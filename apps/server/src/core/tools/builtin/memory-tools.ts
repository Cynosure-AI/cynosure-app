import type { ToolDefinition, ToolResult } from '../../gateway/providers/base.provider.js'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { getDb } from '../../../db/database.js'
import { getAgentMemory } from '../../memory/agent-memory.js'
import { getMemoryParser, type RetrievedChunk } from '../../memory/parser.js'
import { buildMemoryFolderFilter as buildScopeFilter, getDefaultMemoryFolder, getMemoryFolderDirectoryPath, type MemoryFolderRef } from '../../memory/memory-folder-scope.js'
import { ensureMemoryFolderPath, categoryPathForDirectory } from '../../memory/memory-folder-directories.js'
import { readTextFile, writeTextFile, fileExists, resolveUniqueFileName, deleteFile } from '../../memory/memory-file-manager.js'
import type { KnowledgeAssertion, KnowledgeEntity, KnowledgeEntityType } from '../../memory/knowledge-types.js'
import { getMemoryKnowledgeStore } from '../../memory/memory-knowledge.js'
import { cancelMemoryIndexJobsForFile } from '../../memory/memory-index-jobs.js'
import {
    parseMemoryDocumentRef,
} from '../../memory/memory-reference.js'
import type { MemoryRevisionContext } from '../../memory/memory-revisions.js'

const memoryDocumentMutationTails = new Map<string, Promise<void>>()

async function withMemoryDocumentLock<T>(documentId: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const key = documentId.trim()
    const prior = memoryDocumentMutationTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const tail = prior.catch(() => undefined).then(() => held)
    memoryDocumentMutationTails.set(key, tail)
    await prior.catch(() => undefined)
    try {
        signal?.throwIfAborted()
        return await operation()
    } finally {
        release()
        if (memoryDocumentMutationTails.get(key) === tail) memoryDocumentMutationTails.delete(key)
    }
}

async function reindexMemoryFile(
    categoryId: string,
    fileName: string,
    signal?: AbortSignal,
    revisionContext?: MemoryRevisionContext,
): Promise<{ chunkCount: number; revision: number; contentHash: string; documentId: string; documentRef: string }> {
    const directoryPath = getMemoryFolderDirectoryPath(categoryId)
    if (!directoryPath) throw new Error('Memory folder has no category configured')
    cancelMemoryIndexJobsForFile(categoryId, fileName)
    const memory = getAgentMemory()
    const result = await memory.reindexFile(directoryPath, fileName, categoryId, { signal, revisionContext })
    const ref = memory.getDocumentReference(categoryId, result.fileName)
    if (!ref) throw new Error('Memory was indexed but its document reference could not be loaded')
    return { chunkCount: result.chunkCount, revision: ref.revisionNumber, contentHash: ref.revision, documentId: ref.documentId, documentRef: ref.documentRef }
}

export const MEMORY_READ_TOOL_NAMES = [
    'memory_search',
] as const

export const MEMORY_WRITE_TOOL_NAMES = [
    'memory_create',
    'memory_patch',
] as const

export const MEMORY_TOOL_NAMES = [
    ...MEMORY_READ_TOOL_NAMES,
    ...MEMORY_WRITE_TOOL_NAMES,
] as const

export const KNOWLEDGE_TOOL_NAMES = [
    'knowledge_search',
    'knowledge_assert',
    'knowledge_delete',
    'knowledge_entity_merge',
] as const
export const KNOWLEDGE_READ_TOOL_NAMES = ['knowledge_search'] as const

export type MemoryReadToolName = (typeof MEMORY_READ_TOOL_NAMES)[number]
export type MemoryWriteToolName = (typeof MEMORY_WRITE_TOOL_NAMES)[number]
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number]
export type KnowledgeToolName = (typeof KNOWLEDGE_TOOL_NAMES)[number]
export type KnowledgeReadToolName = (typeof KNOWLEDGE_READ_TOOL_NAMES)[number]

export function isMemoryToolName(toolName: string): toolName is MemoryToolName {
    return (MEMORY_TOOL_NAMES as readonly string[]).includes(toolName)
}

export function isMemoryReadToolName(toolName: string): toolName is MemoryReadToolName {
    return (MEMORY_READ_TOOL_NAMES as readonly string[]).includes(toolName)
}

export function isKnowledgeToolName(toolName: string): toolName is KnowledgeToolName {
    return (KNOWLEDGE_TOOL_NAMES as readonly string[]).includes(toolName)
}

export function isKnowledgeReadToolName(toolName: string): toolName is KnowledgeReadToolName {
    return (KNOWLEDGE_READ_TOOL_NAMES as readonly string[]).includes(toolName)
}

export interface MemoryToolOptions {
    /** SQL filter covering all selected memory folders, e.g. `categoryId IN ('...', '...')`. */
    categoryFilter?: string
    /** Selected memory folders for write tools and read disambiguation. */
    assignedCategories?: MemoryFolderRef[]
    revisionContext?: MemoryRevisionContext
    /** Optional background-curator guards; the mutation guard runs under the document lock. */
    onDocumentRead?: (documentId: string, revision: string) => void
    beforeDocumentMutation?: (documentId: string, content: string) => void
    /** Called after a document has been successfully created or updated. */
    onDocumentMutated?: (documentId: string) => void
}

const ENTITY_TYPES = ['person', 'place', 'organization', 'project', 'event', 'date', 'technology', 'product', 'artifact', 'concept', 'other'] as const
const KNOWLEDGE_SHORT_ID_LENGTH = 8
const IMPORTANCE_LABELS = ['temporary', 'minor', 'useful', 'core'] as const
type ImportanceLabel = (typeof IMPORTANCE_LABELS)[number]
const IMPORTANCE_MAP: Record<ImportanceLabel, 0 | 1 | 2 | 3> = {
    temporary: 0,
    minor: 1,
    useful: 2,
    core: 3,
}

function shortKnowledgeGraphId(prefix: 'n' | 'e', id: string): string {
    return `${prefix}:${id.slice(0, KNOWLEDGE_SHORT_ID_LENGTH)}`
}

function knowledgeHandleSuffix(id: string): string {
    return createHash('sha256').update(id).digest('hex').slice(0, KNOWLEDGE_SHORT_ID_LENGTH)
}

function knowledgeHandleSlug(name: string): string {
    return name
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48) || 'entity'
}

export function readableKnowledgeEntityId(name: string, id: string): string {
    return `n:${knowledgeHandleSlug(name)}#${knowledgeHandleSuffix(id)}`
}

function resolveKnowledgeAssertionId(value: string): { id: string } | { error: string } {
    const trimmed = value.trim()
    const shortId = trimmed.startsWith('e:') ? trimmed.slice(2) : trimmed
    if (!trimmed.startsWith('e:') || shortId.length === 0) return { id: trimmed }
    const rows = getDb().prepare(`SELECT id FROM memory_knowledge_assertions WHERE id LIKE ? AND status IN ('active', 'disputed') ORDER BY updated_at DESC LIMIT 2`).all(`${shortId}%`) as { id: string }[]
    if (rows.length === 1) return { id: rows[0].id }
    if (rows.length > 1) {
        return { error: `Multiple knowledge edges match id prefix ${trimmed}. Use knowledge_search to get the full id, then retry.` }
    }
    return { id: trimmed }
}

function resolveKnowledgeEntityIds(values: unknown, categoryIds: string[]): { ids: string[] } | { error: string } {
    if (!Array.isArray(values)) return { error: 'entityIds must be an array containing at least one entity ID.' }
    const requested = Array.from(new Set(values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)))
        .slice(0, 20)
    if (requested.length < 1) return { error: 'Provide at least one entity ID to merge.' }
    if (categoryIds.length === 0) return { error: 'No memory folder is selected for knowledge access.' }
    const scopePlaceholders = categoryIds.map(() => '?').join(', ')
    const ids: string[] = []
    let readableHandleRows: Array<{ id: string }> | undefined
    for (const requestedId of requested) {
        const isShort = requestedId.startsWith('n:')
        const candidate = isShort ? requestedId.slice(2) : requestedId
        if (!candidate) return { error: `Invalid entity ID "${requestedId}".` }
        const readableSuffix = isShort && candidate.includes('#') ? candidate.slice(candidate.lastIndexOf('#') + 1) : ''
        if (readableSuffix && !readableHandleRows) {
            readableHandleRows = getDb().prepare(`
                SELECT id FROM memory_knowledge_entities
                WHERE status = 'active' AND namespace_id IN (${scopePlaceholders})
                ORDER BY updated_at DESC
              `).all(...categoryIds) as Array<{ id: string }>
        }
        const rows = readableSuffix
            ? readableHandleRows!.filter((row) => knowledgeHandleSuffix(row.id) === readableSuffix)
            : isShort
                ? getDb().prepare(`
                SELECT id FROM memory_knowledge_entities
                WHERE status = 'active' AND namespace_id IN (${scopePlaceholders}) AND id LIKE ?
                ORDER BY updated_at DESC LIMIT 2
              `).all(...categoryIds, `${candidate}%`) as Array<{ id: string }>
                : getDb().prepare(`
                SELECT id FROM memory_knowledge_entities
                WHERE status = 'active' AND namespace_id IN (${scopePlaceholders}) AND id = ?
                LIMIT 1
              `).all(...categoryIds, candidate) as Array<{ id: string }>
        if (rows.length === 0) return { error: `No active entity matched ID ${requestedId}. Use knowledge_search to refresh the IDs.` }
        if (rows.length > 1) return { error: `Multiple entities match ID ${requestedId}. Use knowledge_search to refresh the IDs and retry.` }
        ids.push(rows[0].id)
    }
    const unique = Array.from(new Set(ids))
    return unique.length >= 1 ? { ids: unique } : { error: 'The supplied IDs did not resolve to an active entity.' }
}

function formatKnowledgeEntity(node: KnowledgeEntity): string {
    const aliases = node.aliases.length ? ` aliases=${node.aliases.join(', ')}` : ''
    const importanceLabel = IMPORTANCE_LABELS[node.importance] ?? 'minor'
    return `- [${importanceLabel}] ${node.name} (${node.type}, id=${readableKnowledgeEntityId(node.name, node.id)}, mentions=${node.mentionCount}${aliases})`
}

function formatKnowledgeAssertion(edge: KnowledgeAssertion): string {
    const importanceLabel = IMPORTANCE_LABELS[edge.importance] ?? 'minor'
    const note = edge.note ? ` Note: ${edge.note}` : ''
    const part = edge.sourceChunkIndex !== undefined ? `, part=${edge.sourceChunkIndex + 1}` : ''
    const sourceDocument = edge.sourceDocumentId
        ? getDb().prepare('SELECT file_name FROM memory_file_index WHERE document_id = ?').get(edge.sourceDocumentId) as { file_name: string } | undefined
        : undefined
    const source = sourceDocument ? ` Source chunk: ${sourceDocument.file_name}${part}.` : ''
    const relevance = edge.retrievalRelevance === undefined ? '' : `, relevance=${edge.retrievalRelevance.toFixed(2)}`
    return `- [${importanceLabel}] ${edge.fromName} --${edge.relation}--> ${edge.toName} (id=${shortKnowledgeGraphId('e', edge.id)}${relevance}, mentions=${edge.mentionCount}).${note}${source}`
}

function normalizeKnowledgeEntityType(value: unknown): KnowledgeEntityType {
    return typeof value === 'string' && (ENTITY_TYPES as readonly string[]).includes(value)
        ? value as KnowledgeEntityType
        : 'other'
}

function cleanAliases(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value
        .filter((alias): alias is string => typeof alias === 'string')
        .map((alias) => alias.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 8)
}

function cleanRelationName(value: unknown): string {
    if (typeof value !== 'string') return ''
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64)
}

function cleanEntityName(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
}

function clampToolNumber(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(max, value))
}

function toImportanceValue(value: unknown): 0 | 1 | 2 | 3 {
    if (typeof value === 'string' && (IMPORTANCE_LABELS as readonly string[]).includes(value)) {
        return IMPORTANCE_MAP[value as ImportanceLabel]
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.round(clampToolNumber(value, 1, 0, 3)) as 0 | 1 | 2 | 3
    }
    return 1
}

function cleanToolString(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function pickToolString(params: unknown, keys: string[]): string {
    if (!params || typeof params !== 'object') return ''
    const obj = params as Record<string, unknown>
    for (const key of keys) {
        const value = cleanToolString(obj[key])
        if (value) return value
    }
    return ''
}

function toEntityInput(value: unknown): { name: string; type: KnowledgeEntityType; aliases: string[] } | { error: string } {
    if (!value || typeof value !== 'object') return { error: 'Expected entity objects with name, type, and optional aliases.' }
    const obj = value as { name?: unknown; type?: unknown; aliases?: unknown }
    const name = cleanEntityName(obj.name)
    if (name.length < 2) return { error: 'Entity names must be at least 2 characters long.' }
    return {
        name,
        type: normalizeKnowledgeEntityType(obj.type),
        aliases: cleanAliases(obj.aliases),
    }
}

function getKnownMemoryFolders(): MemoryFolderRef[] {
    try {
        const db = getDb()
        const rows = db
            .prepare('SELECT id, name, directory_path, is_uncategorized FROM memory_folders ORDER BY is_uncategorized DESC, directory_path ASC')
            .all() as { id: string; name: string; directory_path: string; is_uncategorized: number }[]
        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            categoryPath: row.is_uncategorized === 1 ? '' : categoryPathForDirectory(row.directory_path),
        }))
    } catch {
        return []
    }
}

function createKnownMemoryFoldersLoader(): () => MemoryFolderRef[] {
    let cached: MemoryFolderRef[] | undefined
    return () => {
        cached ??= getKnownMemoryFolders()
        return cached
    }
}

function formatCategories(categories: MemoryFolderRef[]): string {
    if (categories.length === 0) return 'No memory folders exist yet.'
    return categories.map(s => {
        const path = s.categoryPath ? `, category: ${s.categoryPath}` : ', category: Uncategorized'
        return `  - "${s.name}" (id: ${s.id}${path})`
    }).join('\n')
}

function findSpaceByIdOrName(categories: MemoryFolderRef[], wanted: string): MemoryFolderRef | undefined {
    const normalized = wanted.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()
    return categories.find(s =>
        s.id === wanted ||
        s.name.toLowerCase() === wanted.toLowerCase() ||
        (s.categoryPath || '').toLowerCase() === normalized ||
        (s.categoryPath === '' && normalized === 'uncategorized')
    )
}

function makeScopeSummary(assignedCategories: MemoryFolderRef[]): string {
    if (assignedCategories.length === 0) {
        const uncategorizedCategory = getDefaultMemoryFolder()
        return uncategorizedCategory ? `Scope: all memory folders; writes default to "${uncategorizedCategory.name}".` : 'Scope: no memory folders.'
    }
    if (assignedCategories.length === 1) return `Scope: "${assignedCategories[0].name}" category only.`
    return `Scope: selected memory folders only (${assignedCategories.map(s => `"${s.name}"`).join(', ')}).`
}

function resolveReadableCategoryFilter(
    assignedCategories: MemoryFolderRef[],
    baseFilter?: string,
    categoryParam?: string,
    getKnownCategories: () => MemoryFolderRef[] = getKnownMemoryFolders,
): { filter?: string; category?: MemoryFolderRef } | { error: string } {
    if (!categoryParam?.trim()) {
        return { filter: assignedCategories.length > 0 ? buildScopeFilter(assignedCategories) : baseFilter }
    }

    const candidates = assignedCategories.length > 0 ? assignedCategories : getKnownCategories()
    const wanted = categoryParam.trim()
    const match = findSpaceByIdOrName(candidates, wanted)
    if (!match) {
        const scopeLabel = assignedCategories.length > 0 ? 'selected memory folders' : 'existing memory folders'
        return {
            error: `Memory folder "${wanted}" was not found in ${scopeLabel}.\n${formatCategories(candidates)}`
        }
    }

    return { filter: buildScopeFilter([match]), category: match }
}

/**
 * Resolve the target category for a write operation, with smart name-based fallback.
 * Priority (when no explicit category param):
 * 1. If title exists in exactly one selected category → use that
 * 2. If exactly one category is selected → use it
 * 3. If default category exists → use it for unspecified writes
 * 4. If multiple folders are selected and no default exists → error
 * 5. If no folders exist → error
 */
async function resolveTargetCategory(
    assignedCategories: MemoryFolderRef[],
    categoryParam?: string,
    existingTitle?: string,
    getKnownCategories: () => MemoryFolderRef[] = getKnownMemoryFolders,
): Promise<{ categoryId: string; categoryName: string } | { error: string }> {
    // --- Explicit category parameter provided ---
    if (categoryParam?.trim()) {
        const wanted = categoryParam.trim()
        const candidates = assignedCategories.length > 0 ? assignedCategories : getKnownCategories()
        const match = findSpaceByIdOrName(candidates, wanted)
        if (match) return { categoryId: match.id, categoryName: match.name }
        if (wanted.includes(':')) return { error: `Unknown memory folder ID "${wanted}".` }
        const normalized = wanted.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        const roots = assignedCategories.length > 0 ? assignedCategories : [getDefaultMemoryFolder()].filter(Boolean) as MemoryFolderRef[]
        const allowed = roots.some(root => !root.categoryPath || normalized === root.categoryPath || normalized.startsWith(`${root.categoryPath}/`))
        if (!allowed) return { error: `Category "${wanted}" is outside the granted memory folder trees.\n${formatCategories(roots)}` }
        try {
            const created = ensureMemoryFolderPath(getDb(), normalized)
            if (!assignedCategories.some(category => category.id === created.id)) {
                assignedCategories.push({ id: created.id, name: created.name, categoryPath: normalized })
            }
            return { categoryId: created.id, categoryName: created.name }
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) }
        }
    }

    // --- No explicit category parameter ---
    // For updates: try smart title-based resolution first
    if (existingTitle && assignedCategories.length > 0) {
        const mem = getAgentMemory()
        const counts = await Promise.all(
            assignedCategories.map(async (category) => {
                const filter = buildScopeFilter([category])
                try {
                    return await mem.countChunks(existingTitle, filter)
                } catch {
                    // Ignore errors in checking individual categories
                    return 0
                }
            })
        )
        const matchingCategories = assignedCategories.filter((_, i) => counts[i] > 0)

        if (matchingCategories.length === 1) {
            // Title exists in exactly one category — use that
            return { categoryId: matchingCategories[0].id, categoryName: matchingCategories[0].name }
        }

        if (matchingCategories.length > 1) {
            // Title exists in multiple categories — need explicit selection
            const listing = matchingCategories.map(s => `  - "${s.name}" (id: ${s.id})`).join('\n')
            return { error: `Memory entry "${existingTitle}" exists in multiple folders. Please specify which to update using the 'category' parameter:\n${listing}` }
        }
    }

    // --- Smart fallback logic ---
    // If exactly one category is in scope, omitted "category" writes target that category.
    if (assignedCategories.length === 1) {
        return { categoryId: assignedCategories[0].id, categoryName: assignedCategories[0].name }
    }

    // Unspecified writes outside a single selected scope land in the root/Uncategorized memory folder.
    const uncategorizedCategory = getDefaultMemoryFolder()
    if (uncategorizedCategory) {
        return { categoryId: uncategorizedCategory.id, categoryName: uncategorizedCategory.name }
    }

    // Multiple selected categorys but no default or unambiguous match → error
    if (assignedCategories.length > 1) {
        return { error: `Multiple memory folders are selected. Please specify which to write to using the 'category' parameter.\nAvailable categories:\n${formatCategories(assignedCategories)}` }
    }

    // 4. No folders at all
    const existing = getKnownCategories()
    return {
        error:
            'No memory folder is selected for writes. Provide the target memory folder using the "category" parameter, select one in the conversation, or assign one to the agent.\n' +
            `Existing memory folders:\n${formatCategories(existing)}`
    }
}

interface ResolvedMemoryDocument {
    documentId: string
    revision: string
    revisionNumber: number
    documentRef: string
    categoryId: string
    categoryName: string
    fileName: string
    directoryPath: string
}

function resolveMemoryFileRef(
    fileRef: string,
    assignedCategories: MemoryFolderRef[],
    getKnownCategories: () => MemoryFolderRef[],
): ResolvedMemoryDocument | { error: string } {
    const requested = typeof fileRef === 'string' ? fileRef.trim() : ''
    if (!requested) return { error: 'fileRef must be a non-empty stable identifier returned by memory_search.' }
    const parsedRef = parseMemoryDocumentRef(requested)
    const match = getDb().prepare(`
        SELECT document_id FROM memory_file_index
        WHERE document_id = ? OR document_ref = ?
        LIMIT 1
    `).get(requested, parsedRef ?? requested.toLowerCase()) as { document_id: string } | undefined
    const ref = match ? getAgentMemory().getDocumentReferenceById(match.document_id) : undefined
    if (!ref) return { error: 'No canonical memory file matches this fileRef. Run memory_search again to get a current identifier.' }
    if (assignedCategories.length > 0 && !assignedCategories.some((category) => category.id === ref.categoryId)) {
        return { error: 'The referenced memory document is outside the selected memory-folder scope.' }
    }
    const category = [...assignedCategories, ...getKnownCategories()].find((candidate) => candidate.id === ref.categoryId)
    const directoryPath = getMemoryFolderDirectoryPath(ref.categoryId)
    if (!category || !directoryPath) return { error: 'The memory folder for the referenced document is unavailable.' }
    if (!fileExists(directoryPath, ref.fileName)) return { error: 'The referenced memory document no longer exists.' }
    return {
        documentId: ref.documentId,
        revision: ref.revision,
        revisionNumber: ref.revisionNumber,
        documentRef: ref.documentRef,
        categoryId: ref.categoryId,
        categoryName: category.name,
        fileName: ref.fileName,
        directoryPath,
    }
}

async function commitMemoryMutation(
    resolved: ResolvedMemoryDocument,
    previousContent: string,
    nextContent: string,
    signal?: AbortSignal,
    revisionContext?: MemoryRevisionContext,
): Promise<{ chunkCount: number; revision: number; contentHash: string; documentId: string; documentRef: string }> {
    signal?.throwIfAborted()
    writeTextFile(resolved.directoryPath, resolved.fileName, nextContent)
    let indexed: Awaited<ReturnType<typeof reindexMemoryFile>>
    try {
        indexed = await reindexMemoryFile(resolved.categoryId, resolved.fileName, signal, revisionContext)
    } catch (err) {
        // Restore source and retrieval index together; a failed embedding call
        // must not leave disk and search representing different revisions.
        writeTextFile(resolved.directoryPath, resolved.fileName, previousContent)
        await reindexMemoryFile(resolved.categoryId, resolved.fileName).catch(() => undefined)
        throw new Error(`Memory update failed and the previous content was restored: ${(err as Error).message}`)
    }
    return indexed
}

const CANONICAL_EXCERPT_CHARS = 8_000

async function canonicalExcerptForResult(result: RetrievedChunk): Promise<{
    fileRef: string
    fileName: string
    category: string
    revision: number
    content: string
    score: number
} | undefined> {
    if (!result.sourceFile || !result.categoryId || result.chunkIndex == null) return undefined
    const mem = getAgentMemory()
    const ref = mem.getDocumentReference(result.categoryId, result.sourceFile)
    const directoryPath = getMemoryFolderDirectoryPath(result.categoryId)
    if (!ref || !directoryPath) return undefined

    let canonical: string
    try { canonical = readTextFile(directoryPath, result.sourceFile) } catch { return undefined }
    // Never present an excerpt with a revision belonging to different bytes.
    if (createHash('sha256').update(canonical).digest('hex') !== ref.revision) return undefined

    let sourceStart = result.sourceStart
    let sourceEnd = result.sourceEnd
    if (sourceStart == null || sourceEnd == null || canonical.slice(sourceStart, sourceEnd) !== result.text) {
        const chunks = await getMemoryParser().prepareChunks(canonical, result.sourceFile)
        const current = chunks[result.chunkIndex]
        if (!current || current.contentHash !== result.contentHash) return undefined
        sourceStart = current.sourceStart
        sourceEnd = current.sourceEnd
    }
    if (sourceStart == null || sourceEnd == null) return undefined

    const surrounding = Math.max(0, Math.floor((CANONICAL_EXCERPT_CHARS - (sourceEnd - sourceStart)) / 2))
    let excerptStart = Math.max(0, sourceStart - surrounding)
    let excerptEnd = Math.min(canonical.length, sourceEnd + surrounding)
    if (excerptStart > 0) {
        const boundary = canonical.indexOf('\n', excerptStart)
        if (boundary >= 0 && boundary < sourceStart) excerptStart = boundary + 1
    }
    if (excerptEnd < canonical.length) {
        const boundary = canonical.lastIndexOf('\n', excerptEnd)
        if (boundary > sourceEnd) excerptEnd = boundary
    }
    const category = getDb().prepare('SELECT name FROM memory_folders WHERE id = ?').get(result.categoryId) as { name: string } | undefined
    return {
        fileRef: ref.documentRef,
        fileName: ref.fileName,
        category: category?.name || result.categoryId,
        revision: ref.revisionNumber,
        content: canonical.slice(excerptStart, excerptEnd),
        score: result.score,
    }
}

/** Search derived chunks, then return expanded text read from canonical files. */
export function makeMemorySearchTool(opts: MemoryToolOptions): ToolDefinition {
    const { categoryFilter, assignedCategories = [] } = opts
    const getKnownCategories = createKnownMemoryFoldersLoader()
    return {
        name: 'memory_search',
        execution: { readOnly: true },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
            'Search canonical memory files using the derived hybrid retrieval index. ' +
            'Returns expanded canonical excerpts with a stable fileRef and monotonic revision for memory_patch. ' +
            'Retrieval chunk identifiers and boundaries are intentionally hidden. ' +
            'Selected memory folders are treated as one unified knowledge base — use the optional "category" parameter to filter to a specific category. ' +
            makeScopeSummary(assignedCategories),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                query: { type: 'string', description: 'A descriptive search query to find relevant memories.' },
                limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum number of results to return (default: 5, max: 20).' },
                category: { type: 'string', description: 'Optional memory folder name, relative path (e.g. "projects/acme"), or ID to restrict the search. Without this, searches all selected categorys.' }
            },
            required: ['query']
        },
        outputSchema: {
            type: 'object',
            required: ['results'],
            properties: {
                results: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['fileRef', 'fileName', 'revision', 'content'],
                        properties: {
                            fileRef: { type: 'string' },
                            fileName: { type: 'string' },
                            category: { type: 'string' },
                            revision: { type: 'integer' },
                            content: { type: 'string' },
                            score: { type: 'number' },
                        },
                    },
                },
            },
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            const query = pickToolString(params, ['query', 'search_query', 'searchQuery', 'text'])
            if (!query) {
                return { success: false, output: 'A non-empty "query" string is required for memory_search.' }
            }
            const { limit, category } = (params || {}) as { limit?: number; category?: string }
            const resolvedScope = resolveReadableCategoryFilter(assignedCategories, categoryFilter, category, getKnownCategories)
            if ('error' in resolvedScope) return { success: false, output: resolvedScope.error }
            const mem = getAgentMemory()

            const k = Math.floor(clampToolNumber(limit, 5, 1, 20))
            const results = await mem.recall(query, k, resolvedScope.filter)

            if (results.length === 0) {
                return { success: false, output: `No relevant memories found for this query${resolvedScope.category ? ` in "${resolvedScope.category.name}"` : ''}.` }
            }

            console.log(`[memory_search] Found ${results.length} indexed matches for query "${query.slice(0, 60)}" (limit=${k})`)
            const canonicalMatches = (await Promise.all(results.map(canonicalExcerptForResult)))
                .filter((result): result is NonNullable<typeof result> => Boolean(result))
            const canonicalResults = [...new Map(canonicalMatches.map(result => [
                `${result.fileRef}\u0000${result.content}`,
                result,
            ])).values()]
            if (canonicalResults.length === 0) {
                return { success: false, output: 'The search index matched memory, but no result still matched its canonical file. Retry after indexing completes.' }
            }
            for (const result of results) {
                if (!opts.onDocumentRead || !result.categoryId || !result.sourceFile) continue
                const ref = mem.getDocumentReference(result.categoryId, result.sourceFile)
                if (ref && canonicalResults.some(item => item.fileRef === ref.documentRef)) opts.onDocumentRead(ref.documentId, ref.revision)
            }
            const formatted = canonicalResults.map(result =>
                `[fileRef=${result.fileRef} fileName=${result.fileName} revision=${result.revision} category=${result.category} score=${(result.score * 100).toFixed(1)}%]\n${result.content}`
            ).join('\n\n---\n\n')
            return {
                success: true,
                output: `Showing ${canonicalResults.length} canonical memory excerpt${canonicalResults.length === 1 ? '' : 's'}:\n\n${formatted}`,
                structuredContent: { results: canonicalResults },
            }
        }
    }
}

/**
 * Create a `knowledge_search` tool that lets the LLM inspect known
 * relationships and their connected entities.
 */
function resolveKnowledgeSpace(
    assignedCategories: MemoryFolderRef[],
    category?: string,
): MemoryFolderRef | { error: string } {
    if (assignedCategories.length === 0) {
        return { error: 'No memory folder is selected for knowledge access.' }
    }
    if (category?.trim()) {
        const match = findSpaceByIdOrName(assignedCategories, category.trim())
        return match || { error: `Memory folder "${category.trim()}" is not in the selected knowledge scope.` }
    }
    if (assignedCategories.length === 1) return assignedCategories[0]
    return { error: `Multiple memory folders are selected. Specify the target using the "category" parameter.\n${formatCategories(assignedCategories)}` }
}

export function makeKnowledgeSearchTool(opts: MemoryToolOptions = {}): ToolDefinition {
    const assignedCategories = opts.assignedCategories || []
    const categoryIds = assignedCategories.map((category) => category.id)
    return {
        name: 'knowledge_search',
        execution: { readOnly: true },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
            'Search and inspect source-grounded relationships derived from memory documents, plus explicitly approved manual assertions. ' +
            'Use this to look up known people, organizations, projects, technologies, concepts, or relationships. ' +
            'Provide a query to find matching entities and walk nearby relationships, or omit query to list recent graph entries.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Entity name, alias, or natural-language phrase to search for.' },
                depth: { type: 'number', description: 'Relationship walk depth from matched entities (default: 1 for focused query searches, max: 3).' },
                limit: { type: 'number', description: 'Maximum number of focused relationships to return (default: 12, max: 80).' },
            },
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            if (categoryIds.length === 0) {
                return { success: false, output: 'No memory folder is selected for knowledge access.' }
            }
            const query = pickToolString(params, ['query', 'entity', 'name', 'search_query', 'searchQuery'])
            const { depth, limit } = (params || {}) as { depth?: number; limit?: number }
            const knowledge = getMemoryKnowledgeStore()
            const cappedLimit = Math.floor(clampToolNumber(limit, 12, 1, 80))

            if (query) {
                const walkDepth = Math.floor(clampToolNumber(depth, 1, 1, 3))
                const result = await knowledge.search(query, categoryIds, cappedLimit, { depth: walkDepth })
                const walk = result.graph
                if (!walk || (walk.nodes.length === 0 && walk.edges.length === 0)) {
                    return { success: false, output: `No knowledge nodes matched "${query}".` }
                }

                const nodeLines = walk.nodes.slice(0, cappedLimit).map(formatKnowledgeEntity)
                const edgeLines = walk.edges.slice(0, cappedLimit).map(formatKnowledgeAssertion)
                const sections = [
                    `Matched ${walk.seedNodes.length} seed node${walk.seedNodes.length !== 1 ? 's' : ''}; focused ${walkDepth} hop${walkDepth !== 1 ? 's' : ''}.`,
                    nodeLines.length ? `Nodes:\n${nodeLines.join('\n')}` : '',
                    edgeLines.length ? `Relationships:\n${edgeLines.join('\n')}` : 'No relationships connected to the matched nodes.',
                ].filter(Boolean)
                return { success: true, output: sections.join('\n\n') }
            }

            const snapshot = knowledge.browseGraph({ limit: cappedLimit, categoryIds })
            if (snapshot.nodes.length === 0 && snapshot.edges.length === 0) {
                return { success: false, output: 'No knowledge entries are available in the selected memory folders.' }
            }

            const nodeLines = snapshot.nodes.map(formatKnowledgeEntity)
            const edgeLines = snapshot.edges.map(formatKnowledgeAssertion)
            return {
                success: true,
                output: [
                    `Recent knowledge entries (limit ${cappedLimit}):`,
                    nodeLines.length ? `Nodes:\n${nodeLines.join('\n')}` : '',
                    edgeLines.length ? `Relationships:\n${edgeLines.join('\n')}` : '',
                ].filter(Boolean).join('\n\n'),
            }
        },
    }
}

/**
 * Create a `knowledge_assert` tool that lets the LLM actively record
 * or correct a relationship in the knowledge.
 */
export function makeKnowledgeAssertTool(opts: MemoryToolOptions = {}): ToolDefinition {
    const assignedCategories = opts.assignedCategories || []
    return {
        name: 'knowledge_assert',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description:
            'Assert or update a durable relationship in the knowledge. ' +
            'Use this for stable facts the user explicitly wants remembered as connected entities. ' +
            'This creates missing entities, merges repeated relationships, and may replace older functional relationships such as works_at or lives_in.',
        parameters: {
            type: 'object',
            properties: {
                from: {
                    type: 'object',
                    description: 'Source entity.',
                    properties: {
                        name: { type: 'string', description: 'Entity name.' },
                        type: { type: 'string', enum: ENTITY_TYPES, description: 'Entity type.' },
                        aliases: { type: 'array', items: { type: 'string' }, description: 'Optional aliases for the entity.' },
                    },
                    required: ['name'],
                },
                relation: { type: 'string', description: 'Concise snake_case relationship name, e.g. works_at, uses, owns, depends_on.' },
                to: {
                    type: 'object',
                    description: 'Target entity.',
                    properties: {
                        name: { type: 'string', description: 'Entity name.' },
                        type: { type: 'string', enum: ENTITY_TYPES, description: 'Entity type.' },
                        aliases: { type: 'array', items: { type: 'string' }, description: 'Optional aliases for the entity.' },
                    },
                    required: ['name'],
                },
                importance: { type: 'string', enum: IMPORTANCE_LABELS, description: 'Importance: temporary, minor, useful (durable fact), or core.' },
                note: { type: 'string', description: 'Short contextual note explaining the relationship.' },
                category: { type: 'string', description: 'Target memory folder name or ID. Required when multiple memory folders are selected.' },
            },
            required: ['from', 'relation', 'to'],
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            const { from, relation, to, importance, note, category } = (params || {}) as {
                from?: unknown; relation?: unknown; to?: unknown; importance?: unknown; note?: unknown; category?: string
            }
            const targetSpace = resolveKnowledgeSpace(assignedCategories, category)
            if ('error' in targetSpace) return { success: false, output: targetSpace.error }
            const fromEntity = toEntityInput(from)
            if ('error' in fromEntity) return { success: false, output: `Invalid from entity: ${fromEntity.error}` }
            const toEntity = toEntityInput(to)
            if ('error' in toEntity) return { success: false, output: `Invalid to entity: ${toEntity.error}` }
            const rel = cleanRelationName(relation)
            if (!rel) return { success: false, output: 'Relationship name is required.' }
            if (fromEntity.name.toLowerCase() === toEntity.name.toLowerCase()) {
                return { success: false, output: 'Cannot create a relationship from an entity to itself.' }
            }

            const edge = getMemoryKnowledgeStore().assertRelationship({
                categoryId: targetSpace.id,
                from: fromEntity,
                relation: rel,
                to: toEntity,
                importance: toImportanceValue(importance),
                note: typeof note === 'string' ? note.replace(/\s+/g, ' ').trim().slice(0, 600) : '',
            })

            if (!edge) return { success: false, output: 'No relationship was created.' }
            return { success: true, output: `Relationship asserted:\n${formatKnowledgeAssertion(edge)}` }
        },
    }
}

/** Merge duplicate graph entities into an existing canonical owner or the first supplied entity ID. */
export function makeKnowledgeEntityMergeTool(opts: MemoryToolOptions = {}): ToolDefinition {
    const categoryIds = (opts.assignedCategories || []).map((category) => category.id)
    return {
        name: 'knowledge_entity_merge',
        description:
            'Manually repair confirmed duplicate knowledge entities. Routine entity resolution happens during memory indexing; use this only for exceptional repairs, not uncertain candidate matches. Provide entity IDs returned by knowledge_search and a new canonical mainName. ' +
            'Entities may come from different selected memory folders. If mainName already belongs to an active entity anywhere in scope, that entity automatically remains stable; otherwise the first supplied ID remains stable. ' +
            'All other entities are redirected into it, and their former names and aliases become normalized aliases. ' +
            'Relationships, mentions, and resolution records are rewired; duplicate relationships are consolidated.',
        parameters: {
            type: 'object',
            properties: {
                entityIds: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 1,
                    maxItems: 20,
                    description: 'One or more full or readable node IDs (n:entity_name#xxxxxxxx) from knowledge_search. One ID is sufficient when mainName already belongs to another active entity.',
                },
                mainName: { type: 'string', description: 'New canonical display name for the merged entity.' },
            },
            required: ['entityIds', 'mainName'],
            additionalProperties: false,
        },
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        timeout: 30_000,
        execute: async (params: unknown) => {
            const { entityIds, mainName } = (params || {}) as { entityIds?: unknown; mainName?: unknown }
            const resolved = resolveKnowledgeEntityIds(entityIds, categoryIds)
            if ('error' in resolved) return { success: false, output: resolved.error }
            const canonicalName = cleanEntityName(mainName)
            if (!canonicalName) return { success: false, output: 'mainName is required.' }
            try {
                const result = await getMemoryKnowledgeStore().mergeEntities({
                    entityIds: resolved.ids,
                    canonicalName,
                    categoryIds,
                })
                const aliases = result.entity.aliases.length ? result.entity.aliases.join(', ') : 'none'
                return {
                    success: true,
                    output: [
                        `Merged ${result.mergedEntityIds.length + 1} entities into ${result.entity.name} (${readableKnowledgeEntityId(result.entity.name, result.entity.id)}).`,
                        `Aliases: ${aliases}.`,
                        `Consolidated ${result.consolidatedAssertions} duplicate relationship${result.consolidatedAssertions === 1 ? '' : 's'}; retired ${result.retiredSelfRelationships} self-relationship${result.retiredSelfRelationships === 1 ? '' : 's'}.`,
                    ].join('\n'),
                }
            } catch (error) {
                const code = error instanceof Error ? error.message : ''
                const messages: Record<string, string> = {
                    ENTITY_MERGE_REQUIRES_MULTIPLE: 'Provide at least two distinct entities, either as IDs or as one ID plus an existing mainName owner.',
                    ENTITY_MERGE_INVALID_NAME: 'mainName is not valid.',
                    ENTITY_MERGE_ENTITY_NOT_FOUND: 'One or more entities no longer exist or were already merged. Search again and retry.',
                    ENTITY_MERGE_OUT_OF_SCOPE: 'One or more entities are outside the selected memory folder scope.',
                }
                return { success: false, output: messages[code] || `Entity merge failed: ${code || 'unknown error'}` }
            }
        },
    }
}

/**
 * Create a `knowledge_delete` tool that lets the LLM remove an
 * incorrect relationship by ID or by exact relationship triple.
 */
export function makeKnowledgeDeleteTool(opts: MemoryToolOptions = {}): ToolDefinition {
    const assignedCategories = opts.assignedCategories || []
    const categoryIds = assignedCategories.map((category) => category.id)
    return {
        name: 'knowledge_delete',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        description:
            'Delete an incorrect relationship from the knowledge. ' +
            'Prefer edgeId from knowledge_search. If edgeId is unknown, provide from, relation, and to to delete an exact relationship triple.',
        parameters: {
            type: 'object',
            properties: {
                edgeId: { type: 'string', description: 'Relationship edge ID to delete. The short e:xxxxxxxx ID from knowledge_search is accepted.' },
                from: {
                    type: 'object',
                    description: 'Source entity for exact triple deletion when edgeId is not available.',
                    properties: {
                        name: { type: 'string', description: 'Entity name.' },
                        type: { type: 'string', enum: ENTITY_TYPES, description: 'Entity type.' },
                    },
                },
                relation: { type: 'string', description: 'Relationship name for exact triple deletion.' },
                to: {
                    type: 'object',
                    description: 'Target entity for exact triple deletion when edgeId is not available.',
                    properties: {
                        name: { type: 'string', description: 'Entity name.' },
                        type: { type: 'string', enum: ENTITY_TYPES, description: 'Entity type.' },
                    },
                },
            },
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            if (categoryIds.length === 0) {
                return { success: false, output: 'No memory folder is selected for knowledge access.' }
            }
            const { edgeId, from, relation, to } = (params || {}) as {
                edgeId?: string; from?: unknown; relation?: unknown; to?: unknown
            }
            const knowledge = getMemoryKnowledgeStore()

            if (edgeId?.trim()) {
                const resolvedEdgeId = resolveKnowledgeAssertionId(edgeId)
                if ('error' in resolvedEdgeId) return { success: false, output: resolvedEdgeId.error }
                const result = knowledge.deleteEdge(resolvedEdgeId.id, categoryIds)
                return result.edgeDeleted
                    ? { success: true, output: formatKnowledgeDeleteOutput(`Deleted knowledge edge ${edgeId.trim()}.`, result.orphanedNodeIds.length) }
                    : { success: false, output: `No relationship found with id ${edgeId.trim()}.` }
            }

            const fromEntity = toEntityInput(from)
            if ('error' in fromEntity) return { success: false, output: 'Provide edgeId, or a valid from/relation/to triple to delete.' }
            const toEntity = toEntityInput(to)
            if ('error' in toEntity) return { success: false, output: 'Provide edgeId, or a valid from/relation/to triple to delete.' }
            const rel = cleanRelationName(relation)
            if (!rel) return { success: false, output: 'Provide edgeId, or a valid from/relation/to triple to delete.' }

            const result = knowledge.deleteMatchingEdge(fromEntity.name, rel, toEntity.name, categoryIds)
            return result.edgeDeleted
                ? { success: true, output: formatKnowledgeDeleteOutput('Deleted 1 matching knowledge edge.', result.orphanedNodeIds.length) }
                : { success: false, output: 'No matching knowledge edge was found.' }
        },
    }
}

function formatKnowledgeDeleteOutput(message: string, orphanedNodeCount: number): string {
    if (orphanedNodeCount === 0) return message
    return `${message} Removed ${orphanedNodeCount} orphaned entit${orphanedNodeCount === 1 ? 'y' : 'ies'}.`
}

/**
 * Create a `memory_create` tool that lets the LLM store new memory entries.
 * Writes a Markdown file to the target category and indexes it.
 */
export function makeMemoryCreateTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedCategories = [] } = opts
    const getKnownCategories = createKnownMemoryFoldersLoader()
    return {
        name: 'memory_create',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description:
            'Create a new memory entry with a title and content. ' +
            'Writes a Markdown file to the memory folder and indexes it for semantic retrieval. ' +
            'Use this to persistently store notes, findings, or any information worth remembering. ' +
            'If exactly one memory folder is selected, omit "category" to write there; otherwise omitted "category" writes to the default root memory folder. ' +
            'Provide "category" to store in a specific selected category.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'A descriptive title for the canonical memory file. The .md extension is appended automatically.' },
                content: { type: 'string', description: 'The Markdown text content to store in memory.' },
                category: { type: 'string', description: 'Optional memory folder name, relative path (e.g. "projects/acme"), or ID. Omit to write to the only selected category, or to the default root category when no single selected category is in scope.' }
            },
            required: ['title', 'content']
        },
        timeout: 120_000,
        execute: async (params: unknown, signal?: AbortSignal) => {
            const { title, content, category } = params as { title: string; content: string; category?: string }

            const resolved = await resolveTargetCategory(assignedCategories, category, undefined, getKnownCategories)
            if ('error' in resolved) return { success: false, output: resolved.error }

            // Ensure .md extension
            const fileName = title.endsWith('.md') ? title : `${title}.md`
            if (basename(fileName) !== fileName || fileName.startsWith('.') || !fileName.trim()) {
                return { success: false, output: 'The memory title must be a plain, visible file name without path separators.' }
            }
            const directoryPath = getMemoryFolderDirectoryPath(resolved.categoryId)
            if (!directoryPath) {
                return { success: false, output: `Memory folder "${resolved.categoryName}" has no category configured. Cannot create memory.` }
            }

            const uniqueName = resolveUniqueFileName(directoryPath, fileName)
            signal?.throwIfAborted()
            writeTextFile(directoryPath, uniqueName, content)

            let indexed: Awaited<ReturnType<typeof reindexMemoryFile>>
            try {
                indexed = await reindexMemoryFile(resolved.categoryId, uniqueName, signal, opts.revisionContext)
            } catch (err) {
                deleteFile(directoryPath, uniqueName)
                throw new Error(`Memory creation failed; the unindexed source file was removed: ${(err as Error).message}`)
            }
            opts.onDocumentMutated?.(indexed.documentId)

            return {
                success: true,
                output: `Memory "${uniqueName}" created and indexed in "${resolved.categoryName}" (fileRef=${indexed.documentRef}, revision=${indexed.revision}, chunks=${indexed.chunkCount}).`
            }
        }
    }
}

export type MemoryPatchConflictReason =
    | 'file_not_found'
    | 'expected_context_not_found'
    | 'ambiguous_context'
    | 'invalid_patch'
    | 'revision_conflict'
    | 'patch_application_failed'

export type MemoryPatchApplication =
    | { status: 'success'; content: string; affectedRanges: Array<{ start: number; oldEnd: number; newEnd: number }> }
    | { status: 'conflict'; reason: MemoryPatchConflictReason; message: string }

interface ParsedPatchHunk { before: string; after: string }

function parseContextualPatch(patch: string): ParsedPatchHunk[] | { error: string } {
    if (typeof patch !== 'string' || !patch.trim()) return { error: 'patch must be a non-empty string.' }
    const lines = patch.replace(/\r\n?/g, '\n').split('\n')
    while (lines.length && !lines[0].startsWith('@@')) lines.shift()
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    if (!lines.length) return { error: 'patch must contain at least one @@ hunk.' }

    const hunks: ParsedPatchHunk[] = []
    let before: string[] | undefined
    let after: string[] | undefined
    const finish = () => {
        if (!before || !after) return
        if (before.length === 0) throw new Error('Each hunk needs deleted or unchanged context for safe addressing.')
        hunks.push({ before: before.join('\n'), after: after.join('\n') })
    }
    try {
        for (const line of lines) {
            if (line.startsWith('@@')) {
                finish()
                before = []
                after = []
                continue
            }
            if (!before || !after) return { error: 'Patch content must follow an @@ hunk header.' }
            if (line.startsWith('\\ No newline at end of file')) continue
            if (line.startsWith('-')) before.push(line.slice(1))
            else if (line.startsWith('+')) after.push(line.slice(1))
            else if (line.startsWith(' ')) {
                before.push(line.slice(1))
                after.push(line.slice(1))
            } else if (line === '') {
                before.push('')
                after.push('')
            } else {
                return { error: `Invalid patch line ${JSON.stringify(line)}; lines must start with space, +, or -.` }
            }
        }
        finish()
    } catch (error) {
        return { error: (error as Error).message }
    }
    if (hunks.length === 0) return { error: 'patch must contain at least one non-empty hunk.' }
    return hunks
}

/** Apply all contextual hunks in memory. No content is returned on conflict. */
export function applyMemoryPatch(content: string, patch: string): MemoryPatchApplication {
    const parsed = parseContextualPatch(patch)
    if ('error' in parsed) return { status: 'conflict', reason: 'invalid_patch', message: parsed.error }
    let next = content
    const affectedRanges: Array<{ start: number; oldEnd: number; newEnd: number }> = []
    for (const hunk of parsed) {
        const start = next.indexOf(hunk.before)
        if (start < 0) {
            return { status: 'conflict', reason: 'expected_context_not_found', message: 'Expected patch context was not found in the canonical file.' }
        }
        if (next.indexOf(hunk.before, start + 1) >= 0) {
            return { status: 'conflict', reason: 'ambiguous_context', message: 'Expected patch context occurs more than once; include more unchanged context.' }
        }
        next = next.slice(0, start) + hunk.after + next.slice(start + hunk.before.length)
        affectedRanges.push({ start, oldEnd: start + hunk.before.length, newEnd: start + hunk.after.length })
    }
    return { status: 'success', content: next, affectedRanges }
}

function patchConflict(reason: MemoryPatchConflictReason, currentRevision: number | undefined, message: string): ToolResult {
    const result = { status: 'conflict' as const, reason, currentRevision, message }
    return { success: false, output: JSON.stringify(result), structuredContent: result }
}

export function makeMemoryPatchTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedCategories = [] } = opts
    const getKnownCategories = createKnownMemoryFoldersLoader()
    return {
        name: 'memory_patch',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Atomically apply a strict contextual patch to a canonical memory file. Context is matched literally and must identify exactly one location; matching is never fuzzy. A stale expectedRevision may still succeed when every hunk remains uniquely applicable. Use fileRef and revision returned by memory_search.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                fileRef: { type: 'string', description: 'Stable canonical file reference returned by memory_search (for example user-profile#4k8z2q).' },
                expectedRevision: { type: 'integer', minimum: 1, description: 'Monotonic revision returned by memory_search.' },
                patch: { type: 'string', description: 'One or more @@ contextual diff hunks. Prefix removed lines with -, added lines with +, and unchanged context with a space.' },
            },
            required: ['fileRef', 'expectedRevision', 'patch'],
        },
        outputSchema: {
            type: 'object',
            required: ['status'],
            properties: {
                status: { type: 'string', enum: ['success', 'conflict'] },
                fileRef: { type: 'string' },
                previousRevision: { type: 'integer' },
                revision: { type: 'integer' },
                currentRevision: { type: 'integer' },
                reason: { type: 'string' },
                affectedRanges: { type: 'array' },
                message: { type: 'string' },
            },
        },
        timeout: 120_000,
        execute: async (params: unknown, signal?: AbortSignal) => {
            const input = (params || {}) as { fileRef: string; expectedRevision: number; patch: string }
            if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
                return patchConflict('invalid_patch', undefined, 'expectedRevision must be a positive integer.')
            }
            const initial = resolveMemoryFileRef(input.fileRef, assignedCategories, getKnownCategories)
            if ('error' in initial) return patchConflict('file_not_found', undefined, initial.error)
            return withMemoryDocumentLock(initial.documentId, signal, async () => {
                const resolved = resolveMemoryFileRef(input.fileRef, assignedCategories, getKnownCategories)
                if ('error' in resolved) return patchConflict('file_not_found', undefined, resolved.error)
                if (input.expectedRevision > resolved.revisionNumber) {
                    return patchConflict('revision_conflict', resolved.revisionNumber, 'expectedRevision is newer than the canonical file revision.')
                }
                let current: string
                try { current = readTextFile(resolved.directoryPath, resolved.fileName) } catch {
                    return patchConflict('file_not_found', resolved.revisionNumber, 'The canonical memory file could not be read.')
                }
                opts.beforeDocumentMutation?.(resolved.documentId, current)
                let applied = applyMemoryPatch(current, input.patch)
                if (applied.status === 'conflict') return patchConflict(applied.reason, resolved.revisionNumber, applied.message)
                if (applied.content === current) {
                    const result = { status: 'success' as const, fileRef: resolved.documentRef, previousRevision: resolved.revisionNumber, revision: resolved.revisionNumber, affectedRanges: [] }
                    return { success: true, output: JSON.stringify(result), structuredContent: result }
                }
                // Catch canonical writes that occurred after validation but before
                // commit. Rebase only through the same strict unique-context rules.
                const latest = readTextFile(resolved.directoryPath, resolved.fileName)
                if (latest !== current) {
                    current = latest
                    applied = applyMemoryPatch(current, input.patch)
                    if (applied.status === 'conflict') return patchConflict(applied.reason, resolved.revisionNumber, applied.message)
                }
                try {
                    const indexed = await commitMemoryMutation(resolved, current, applied.content, signal, opts.revisionContext)
                    opts.onDocumentMutated?.(indexed.documentId)
                    const result = { status: 'success' as const, fileRef: indexed.documentRef, previousRevision: resolved.revisionNumber, revision: indexed.revision, affectedRanges: applied.affectedRanges }
                    return { success: true, output: JSON.stringify(result), structuredContent: result }
                } catch (error) {
                    return patchConflict('patch_application_failed', resolved.revisionNumber, (error as Error).message)
                }
            })
        },
    }
}
