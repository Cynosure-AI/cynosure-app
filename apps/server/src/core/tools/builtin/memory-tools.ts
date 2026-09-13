import type { ToolDefinition, ToolResult } from '../../gateway/providers/base.provider.js'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { getDb } from '../../../db/database.js'
import { getAgentMemory } from '../../memory/agent-memory.js'
import { buildMemoryCategoryFilter as buildScopeFilter, getDefaultMemoryCategory, getMemoryCategoryDirectoryPath, type MemoryCategoryRef } from '../../memory/memory-category-scope.js'
import { ensureMemoryCategoryPath, categoryPathForDirectory } from '../../memory/memory-category-directories.js'
import { readTextFile, writeTextFile, fileExists, resolveUniqueFileName, deleteFile } from '../../memory/memory-file-manager.js'
import type { KnowledgeAssertion, KnowledgeEntity, KnowledgeEntityType } from '../../memory/knowledge-types.js'
import { getMemoryKnowledgeStore } from '../../memory/memory-knowledge.js'
import { deleteMemoryKnowledgeSource } from '../../memory/memory-deep-research.js'
import { cancelMemoryIndexJobsForFile } from '../../memory/memory-index-jobs.js'
import {
    memoryDocumentRefMatchesContentHash,
    parseMemoryDocumentRef,
    type ParsedMemoryDocumentRef,
} from '../../memory/memory-reference.js'
import type { MemoryRevisionContext } from '../../memory/memory-revisions.js'

function abortPendingMemoryIndexJobs(categoryId: string, fileName: string): void {
    cancelMemoryIndexJobsForFile(categoryId, fileName)
}

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
): Promise<{ chunkCount: number; revision: string; documentId: string; documentRef: string }> {
    const directoryPath = getMemoryCategoryDirectoryPath(categoryId)
    if (!directoryPath) throw new Error('Memory category has no category configured')
    cancelMemoryIndexJobsForFile(categoryId, fileName)
    const memory = getAgentMemory()
    const result = await memory.reindexFile(directoryPath, fileName, categoryId, { signal, revisionContext })
    const ref = memory.getDocumentReference(categoryId, result.fileName)
    if (!ref) throw new Error('Memory was indexed but its document reference could not be loaded')
    return { chunkCount: result.chunkCount, revision: ref.revision, documentId: ref.documentId, documentRef: ref.documentRef }
}

export const MEMORY_READ_TOOL_NAMES = [
    'memory_list_documents',
    'memory_retrieve_chunks',
    'memory_semantic_search',
] as const

export const MEMORY_WRITE_TOOL_NAMES = [
    'memory_create',
    'memory_update',
    'memory_delete',
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
    /** SQL filter covering all selected memory categories, e.g. `categoryId IN ('...', '...')`. */
    categoryFilter?: string
    /** Selected memory categories for write tools and read disambiguation. */
    assignedCategories?: MemoryCategoryRef[]
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
    if (categoryIds.length === 0) return { error: 'No memory category is selected for knowledge access.' }
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

function toPartIndex(value: unknown): number | undefined {
    return Number.isInteger(value) ? (value as number) - 1 : undefined
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

function getKnownMemoryCategories(): MemoryCategoryRef[] {
    try {
        const db = getDb()
        const rows = db
            .prepare('SELECT id, name, directory_path, is_uncategorized FROM memory_categories ORDER BY is_uncategorized DESC, directory_path ASC')
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

function createKnownMemoryCategoriesLoader(): () => MemoryCategoryRef[] {
    let cached: MemoryCategoryRef[] | undefined
    return () => {
        cached ??= getKnownMemoryCategories()
        return cached
    }
}

function formatCategories(categories: MemoryCategoryRef[]): string {
    if (categories.length === 0) return 'No memory categories exist yet.'
    return categories.map(s => {
        const path = s.categoryPath ? `, category: ${s.categoryPath}` : ', category: Uncategorized'
        return `  - "${s.name}" (id: ${s.id}${path})`
    }).join('\n')
}

function findSpaceByIdOrName(categories: MemoryCategoryRef[], wanted: string): MemoryCategoryRef | undefined {
    const normalized = wanted.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()
    return categories.find(s =>
        s.id === wanted ||
        s.name.toLowerCase() === wanted.toLowerCase() ||
        (s.categoryPath || '').toLowerCase() === normalized ||
        (s.categoryPath === '' && normalized === 'uncategorized')
    )
}

function makeScopeSummary(assignedCategories: MemoryCategoryRef[]): string {
    if (assignedCategories.length === 0) {
        const uncategorizedCategory = getDefaultMemoryCategory()
        return uncategorizedCategory ? `Scope: all memory categories; writes default to "${uncategorizedCategory.name}".` : 'Scope: no memory categories.'
    }
    if (assignedCategories.length === 1) return `Scope: "${assignedCategories[0].name}" category only.`
    return `Scope: selected memory categories only (${assignedCategories.map(s => `"${s.name}"`).join(', ')}).`
}

function buildCategoryMap(...spaceGroups: MemoryCategoryRef[][]): Map<string, string> {
    const map = new Map<string, string>()
    for (const group of spaceGroups) {
        for (const category of group) map.set(category.id, category.name)
    }
    return map
}

function findChunkText(content: string, chunkText: string, fromIndex = 0): { start: number; end: number } | null {
    const normalizedChunk = chunkText.replace(/\r\n/g, '\n').trim()
    if (!normalizedChunk) return null

    const normalizedStart = content.indexOf(normalizedChunk, fromIndex)
    if (normalizedStart < 0) return null

    return { start: normalizedStart, end: normalizedStart + normalizedChunk.length }
}

function replaceChunkRangeInText(
    content: string,
    chunks: { text: string; chunkIndex: number }[],
    replacement: string,
): { content: string; startIndex: number; endIndex: number } | { error: string } {
    const normalizedContent = content.replace(/\r\n/g, '\n')
    const sorted = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    if (!first || !last) return { error: 'No indexed chunks were found for the requested range.' }

    const firstMatch = findChunkText(normalizedContent, first.text)
    if (!firstMatch) {
        return { error: `Could not locate chunk ${first.chunkIndex} in the source file. The file may have changed since indexing; re-index it before retrying.` }
    }

    const lastMatch = first.chunkIndex === last.chunkIndex
        ? firstMatch
        : findChunkText(normalizedContent, last.text, firstMatch.start)

    if (!lastMatch) {
        return { error: `Could not locate chunk ${last.chunkIndex} in the source file. The file may have changed since indexing; re-index it before retrying.` }
    }

    const start = firstMatch.start
    const end = lastMatch.end
    const before = normalizedContent.slice(0, start).replace(/\s*$/, '\n\n')
    const after = normalizedContent.slice(end).replace(/^\s*/, '\n\n')
    return {
        content: `${before}${replacement.trim()}${after}`.trim() + '\n',
        startIndex: first.chunkIndex,
        endIndex: last.chunkIndex,
    }
}

function removeChunkRangeFromText(
    content: string,
    chunks: { text: string; chunkIndex: number }[],
): { content: string; startIndex: number; endIndex: number } | { error: string } {
    const normalizedContent = content.replace(/\r\n/g, '\n')
    const sorted = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    if (!first || !last) return { error: 'No indexed chunks were found for the requested range.' }

    const firstMatch = findChunkText(normalizedContent, first.text)
    if (!firstMatch) {
        return { error: `Could not locate chunk ${first.chunkIndex} in the source file. The file may have changed since indexing; re-index it before retrying.` }
    }

    const lastMatch = first.chunkIndex === last.chunkIndex
        ? firstMatch
        : findChunkText(normalizedContent, last.text, firstMatch.start)

    if (!lastMatch) {
        return { error: `Could not locate chunk ${last.chunkIndex} in the source file. The file may have changed since indexing; re-index it before retrying.` }
    }

    const before = normalizedContent.slice(0, firstMatch.start).replace(/\s*$/, '\n\n')
    const after = normalizedContent.slice(lastMatch.end).replace(/^\s*/, '\n\n')
    const nextContent = `${before}${after}`.trim()

    return {
        content: nextContent ? `${nextContent}\n` : '',
        startIndex: first.chunkIndex,
        endIndex: last.chunkIndex,
    }
}

function resolveReadableCategoryFilter(
    assignedCategories: MemoryCategoryRef[],
    baseFilter?: string,
    categoryParam?: string,
    getKnownCategories: () => MemoryCategoryRef[] = getKnownMemoryCategories,
): { filter?: string; category?: MemoryCategoryRef } | { error: string } {
    if (!categoryParam?.trim()) {
        return { filter: assignedCategories.length > 0 ? buildScopeFilter(assignedCategories) : baseFilter }
    }

    const candidates = assignedCategories.length > 0 ? assignedCategories : getKnownCategories()
    const wanted = categoryParam.trim()
    const match = findSpaceByIdOrName(candidates, wanted)
    if (!match) {
        const scopeLabel = assignedCategories.length > 0 ? 'selected memory categories' : 'existing memory categories'
        return {
            error: `Memory category "${wanted}" was not found in ${scopeLabel}.\n${formatCategories(candidates)}`
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
    assignedCategories: MemoryCategoryRef[],
    categoryParam?: string,
    existingTitle?: string,
    getKnownCategories: () => MemoryCategoryRef[] = getKnownMemoryCategories,
): Promise<{ categoryId: string; categoryName: string } | { error: string }> {
    // --- Explicit category parameter provided ---
    if (categoryParam?.trim()) {
        const wanted = categoryParam.trim()
        const candidates = assignedCategories.length > 0 ? assignedCategories : getKnownCategories()
        const match = findSpaceByIdOrName(candidates, wanted)
        if (match) return { categoryId: match.id, categoryName: match.name }
        if (wanted.includes(':')) return { error: `Unknown memory category ID "${wanted}".` }
        const normalized = wanted.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        const roots = assignedCategories.length > 0 ? assignedCategories : [getDefaultMemoryCategory()].filter(Boolean) as MemoryCategoryRef[]
        const allowed = roots.some(root => !root.categoryPath || normalized === root.categoryPath || normalized.startsWith(`${root.categoryPath}/`))
        if (!allowed) return { error: `Category "${wanted}" is outside the granted memory category trees.\n${formatCategories(roots)}` }
        try {
            const created = ensureMemoryCategoryPath(getDb(), normalized)
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

    // Unspecified writes outside a single selected scope land in the root/Uncategorized memory category.
    const uncategorizedCategory = getDefaultMemoryCategory()
    if (uncategorizedCategory) {
        return { categoryId: uncategorizedCategory.id, categoryName: uncategorizedCategory.name }
    }

    // Multiple selected categorys but no default or unambiguous match → error
    if (assignedCategories.length > 1) {
        return { error: `Multiple memory categories are selected. Please specify which to write to using the 'category' parameter.\nAvailable categories:\n${formatCategories(assignedCategories)}` }
    }

    // 4. No folders at all
    const existing = getKnownCategories()
    return {
        error:
            'No memory category is selected for writes. Provide the target memory category using the "category" parameter, select one in the conversation, or assign one to the agent.\n' +
            `Existing memory categories:\n${formatCategories(existing)}`
    }
}

interface ResolvedMemoryDocument {
    documentId: string
    revision: string
    documentRef: ParsedMemoryDocumentRef
    categoryId: string
    categoryName: string
    fileName: string
    directoryPath: string
}

function resolveMemoryDocumentRef(
    documentRef: string,
    assignedCategories: MemoryCategoryRef[],
    getKnownCategories: () => MemoryCategoryRef[],
): ResolvedMemoryDocument | { error: string } {
    const parsed = parseMemoryDocumentRef(documentRef)
    if (!parsed) {
        return { error: 'Invalid documentRef. Read or list memories again to get a current reference.' }
    }
    const matches = parsed.kind === 'stable'
        ? getDb().prepare('SELECT document_id FROM memory_file_index WHERE document_ref = ? LIMIT 2')
            .all(parsed.value) as Array<{ document_id: string }>
        : getDb().prepare(`
            SELECT document_id FROM memory_file_index
            WHERE document_id LIKE ?
            ORDER BY created_at DESC
            LIMIT 2
        `).all(`${parsed.documentIdPrefix}%`) as Array<{ document_id: string }>
    if (matches.length > 1) {
        return { error: 'The documentRef is ambiguous. Read or list memories again to get a current reference.' }
    }
    const ref = matches.length === 1
        ? getAgentMemory().getDocumentReferenceById(matches[0].document_id)
        : undefined
    if (!ref) return { error: 'No memory document matches this documentRef. Search or list memories again to get a current reference.' }
    if (assignedCategories.length > 0 && !assignedCategories.some((category) => category.id === ref.categoryId)) {
        return { error: 'The referenced memory document is outside the selected memory-category scope.' }
    }
    const category = [...assignedCategories, ...getKnownCategories()].find((candidate) => candidate.id === ref.categoryId)
    const directoryPath = getMemoryCategoryDirectoryPath(ref.categoryId)
    if (!category || !directoryPath) return { error: 'The memory category for the referenced document is unavailable.' }
    if (!fileExists(directoryPath, ref.fileName)) return { error: 'The referenced memory document no longer exists.' }
    return {
        documentId: ref.documentId,
        revision: ref.revision,
        documentRef: parsed,
        categoryId: ref.categoryId,
        categoryName: category.name,
        fileName: ref.fileName,
        directoryPath,
    }
}

function verifyDocumentRef(content: string, resolved: ResolvedMemoryDocument): string | undefined {
    const actualHash = createHash('sha256').update(content).digest('hex')
    const matchesIndexedRevision = resolved.documentRef.kind === 'stable'
        ? actualHash === resolved.revision.toLowerCase()
        : memoryDocumentRefMatchesContentHash(resolved.documentRef, actualHash)
    return matchesIndexedRevision
        ? undefined
        : 'Memory changed outside the index while this update was being prepared. Retrieve it again before retrying.'
}

async function commitMemoryMutation(
    resolved: ResolvedMemoryDocument,
    previousContent: string,
    nextContent: string,
    signal?: AbortSignal,
    revisionContext?: MemoryRevisionContext,
): Promise<{ chunkCount: number; revision: string; documentId: string; documentRef: string }> {
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

async function commitMemoryRemoval(
    resolved: ResolvedMemoryDocument,
    previousContent: string,
): Promise<{ deletedChunks: number; deletedEdges: number }> {
    abortPendingMemoryIndexJobs(resolved.categoryId, resolved.fileName)
    let deletedChunks: number
    try {
        deletedChunks = await getAgentMemory().deleteSourceFile(resolved.fileName, resolved.categoryId)
    } catch (err) {
        // A vector-store failure or filesystem failure must not leave only one
        // side removed. Recreate the source if needed, then rebuild its index.
        if (!fileExists(resolved.directoryPath, resolved.fileName)) {
            writeTextFile(resolved.directoryPath, resolved.fileName, previousContent)
        }
        await reindexMemoryFile(resolved.categoryId, resolved.fileName).catch(() => undefined)
        throw new Error(`Memory removal failed and the previous source was restored: ${(err as Error).message}`)
    }
    try {
        const { edgesDeleted } = deleteMemoryKnowledgeSource(resolved.categoryId, resolved.fileName)
        return { deletedChunks, deletedEdges: edgesDeleted }
    } catch (err) {
        console.warn('[memory-tools] Failed to remove derived graph data after memory removal:', err)
        return { deletedChunks, deletedEdges: 0 }
    }
}

/**
 * Create a `memory_list_documents` tool that returns all stored
 * document names with their chunk counts.
 */
export function makeMemoryListDocumentsTool(opts: MemoryToolOptions): ToolDefinition {
    const { categoryFilter, assignedCategories = [] } = opts
    const getKnownCategories = createKnownMemoryCategoriesLoader()
    return {
        name: 'memory_list_documents',
        execution: { readOnly: true },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
            'List memorised documents (source files) stored in your knowledge base. ' +
            'Returns document names, chunk counts, and ingestion dates. Paginated — max 100 per page. ' +
            'Results are newest first. ' +
            'Use this to discover what documents are available before using memory_retrieve_chunks or memory_semantic_search. ' +
            'Selected memory categories are treated as one unified knowledge base for reading — use the optional "category" parameter to filter to a specific category. ' +
            makeScopeSummary(assignedCategories),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                pageIndex: { type: 'number', description: 'Zero-based page index (default: 0). Each page returns up to 100 documents.' },
                category: { type: 'string', description: 'Optional memory category name, relative path (e.g. "projects/acme"), or ID to restrict the listing. Without this, lists all selected categorys.' },
            },
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            const { pageIndex, category } = (params || {}) as { pageIndex?: number; category?: string }
            const resolvedScope = resolveReadableCategoryFilter(assignedCategories, categoryFilter, category, getKnownCategories)
            if ('error' in resolvedScope) return { success: false, output: resolvedScope.error }
            const mem = getAgentMemory()
            const allFiles = await mem.listSourceFiles(undefined, resolvedScope.filter)

            if (allFiles.length === 0) {
                const location = resolvedScope.category ? `"${resolvedScope.category.name}"` : 'memory'
                return {
                    success: false,
                    output: `No documents stored in ${location} yet.`
                }
            }

            const PAGE_SIZE = 100
            const page = Math.max(0, Math.floor(pageIndex ?? 0))
            const totalPages = Math.ceil(allFiles.length / PAGE_SIZE)
            const start = page * PAGE_SIZE
            const pageFiles = allFiles.slice(start, start + PAGE_SIZE)

            if (pageFiles.length === 0) {
                return { success: false, output: `Page ${page + 1} is out of range. Total pages: ${totalPages} (${allFiles.length} documents).` }
            }

            const categoryMap = buildCategoryMap(assignedCategories, getKnownCategories())
            const lines = pageFiles.map((file) => {
                const ref = file.categoryId ? mem.getDocumentReference(file.categoryId, file.sourceFile) : undefined
                const location = file.categoryId ? `, category=${categoryMap.get(file.categoryId) || file.categoryId}` : ''
                const identity = ref ? `, documentRef=${ref.documentRef}` : ''
                return `- ${file.sourceFile} (${file.chunkCount} chunk${file.chunkCount !== 1 ? 's' : ''}${location}${identity})`
            })

            const scope = resolvedScope.category ? ` in "${resolvedScope.category.name}"` : ''
            const header = allFiles.length <= PAGE_SIZE
                ? `${allFiles.length} document${allFiles.length !== 1 ? 's' : ''}${scope}:`
                : `Page ${page + 1}/${totalPages}${scope} (showing ${pageFiles.length} of ${allFiles.length} documents):`

            return {
                success: true,
                output: `${header}\n${lines.join('\n')}`
            }
        }
    }
}

/**
 * Create a `memory_retrieve_chunks` tool that lets the LLM fetch
 * additional chunks from a document by source file name and Part range.
 */
export function makeMemoryRetrieveChunksTool(opts: MemoryToolOptions): ToolDefinition {
    const { categoryFilter, assignedCategories = [] } = opts
    const getKnownCategories = createKnownMemoryCategoriesLoader()
    return {
        name: 'memory_retrieve_chunks',
        execution: { readOnly: true },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
            'Retrieve additional chunks from a stored document by source file and part number range. ' +
            'Very useful to gather more detail of a section (e.g. "Part 4 - 6" when Part 5 matches). ' +
            'Returns the text of each chunk in order. ' +
            makeScopeSummary(assignedCategories),
        parameters: {
            type: 'object',
            properties: {
                sourceFile: { type: 'string', description: 'The source file name exactly as shown in the memory context (e.g. "report.pdf", "notes.md").' },
                minPart: { type: 'number', description: 'Minimum Part number to retrieve, matching the 1-based Part number shown in memory search results.' },
                maxPart: { type: 'number', description: 'Maximum Part number to retrieve, inclusive, matching the 1-based Part number shown in memory search results.' },
                category: { type: 'string', description: 'Optional memory category name, relative path (e.g. "projects/acme"), or ID. Use this when the same source file exists in more than one category.' }
            },
            required: ['sourceFile', 'minPart', 'maxPart']
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            const { sourceFile, minPart, maxPart, minIndex: legacyMinIndex, maxIndex: legacyMaxIndex, category } = params as {
                sourceFile: string; minPart?: number; maxPart?: number; minIndex?: number; maxIndex?: number; category?: string
            }
            const requestedFolder = category
            const resolvedScope = resolveReadableCategoryFilter(assignedCategories, categoryFilter, requestedFolder, getKnownCategories)
            if ('error' in resolvedScope) return { success: false, output: resolvedScope.error }
            const mem = getAgentMemory()

            const minIndex = minPart !== undefined ? toPartIndex(minPart) : legacyMinIndex
            const maxIndex = maxPart !== undefined ? toPartIndex(maxPart) : legacyMaxIndex
            if (!Number.isInteger(minIndex) || !Number.isInteger(maxIndex)) {
                return { success: false, output: 'memory_retrieve_chunks requires integer minPart and maxPart values.' }
            }
            if (minIndex! < 0 || maxIndex! < minIndex!) {
                return { success: false, output: 'Invalid part range. maxPart must be greater than or equal to minPart, and Part numbers start at 1.' }
            }
            const requestedMinIndex = minIndex!
            const requestedMaxIndex = maxIndex!
            const cappedMax = Math.min(requestedMaxIndex, requestedMinIndex + 19) // cap at 20 chunks per call
            const readRevisions = opts.onDocumentRead
                ? new Map((resolvedScope.category ? [resolvedScope.category] : assignedCategories).map(category => {
                    const ref = mem.getDocumentReference(category.id, sourceFile)
                    return [category.id, ref?.revision] as const
                }))
                : undefined
            const chunks = await mem.getChunksByRange(sourceFile, requestedMinIndex, cappedMax, resolvedScope.filter)

            if (chunks.length === 0) {
                return { success: false, output: `No chunks found for "${sourceFile}" in Part range ${requestedMinIndex + 1}-${cappedMax + 1}.` }
            }

            const distinctCategories = [...new Set(chunks.map(c => c.categoryId).filter((id): id is string => Boolean(id)))]
            if (!requestedFolder && distinctCategories.length > 1) {
                const categoryMap = buildCategoryMap(assignedCategories, getKnownCategories())
                const listing = distinctCategories.map(id => `  - "${categoryMap.get(id) || id}" (id: ${id})`).join('\n')
                return {
                    success: false,
                    output: `Source file "${sourceFile}" exists in multiple memory categories. Re-run with the 'category' parameter.\nMatching categories:\n${listing}`
                }
            }

            const total = await mem.countChunks(sourceFile, resolvedScope.filter)
            const categoryMap = buildCategoryMap(assignedCategories, getKnownCategories())
            const resolvedSpaceId = distinctCategories.length === 1 ? distinctCategories[0] : resolvedScope.category?.id
            const documentRef = resolvedSpaceId ? mem.getDocumentReference(resolvedSpaceId, sourceFile) : undefined
            if (documentRef && opts.onDocumentRead) {
                if (readRevisions?.get(documentRef.categoryId) !== documentRef.revision) {
                    return { success: false, output: 'Document changed while reading. Retrieve it again before editing.' }
                }
                opts.onDocumentRead(documentRef.documentId, documentRef.revision)
            }
            const formatted = chunks.map(c => {
                const location = c.categoryId && !resolvedScope.category
                    ? `[${categoryMap.get(c.categoryId) || c.categoryId} · Part ${c.chunkIndex + 1}/${total}]`
                    : `[Part ${c.chunkIndex + 1}/${total}]`
                return `${location}\n${c.text}`
            }).join('\n\n---\n\n')
            const wasCapped = cappedMax < requestedMaxIndex
            const capNote = wasCapped
                ? `\n\n(Showing Parts ${requestedMinIndex + 1}-${cappedMax + 1} of requested Parts ${requestedMinIndex + 1}-${requestedMaxIndex + 1}; capped at 20 chunks per call. Call again with a later range to continue.)`
                : ''
            const identity = documentRef
                ? `[Document: documentRef=${documentRef.documentRef}]\n\n`
                : ''
            return { success: true, output: identity + formatted + capNote }
        }
    }
}

/**
 * Create a `memory_semantic_search` tool that lets the LLM run
 * a new semantic search query against stored memories.
 */
export function makeMemorySearchTool(opts: MemoryToolOptions): ToolDefinition {
    const { categoryFilter, assignedCategories = [] } = opts
    const getKnownCategories = createKnownMemoryCategoriesLoader()
    return {
        name: 'memory_semantic_search',
        execution: { readOnly: true },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
            'Search through stored RAG memories using a semantic query. ' +
            'Use this to get a rough starting point for memories, which can then be refined or expanded using other tools. ' +
            'Returns the most relevant memory chunks with their source, memory category, and chunk index. ' +
            'Selected memory categories are treated as one unified knowledge base — use the optional "category" parameter to filter to a specific category. ' +
            makeScopeSummary(assignedCategories),
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'A descriptive search query to find relevant memories.' },
                limit: { type: 'number', description: 'Maximum number of results to return (default: 5, max: 20).' },
                category: { type: 'string', description: 'Optional memory category name, relative path (e.g. "projects/acme"), or ID to restrict the search. Without this, searches all selected categorys.' }
            },
            required: ['query']
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            const query = pickToolString(params, ['query', 'search_query', 'searchQuery', 'text'])
            if (!query) {
                return { success: false, output: 'A non-empty "query" string is required for memory_semantic_search.' }
            }
            const { limit, topK, category } = (params || {}) as { limit?: number; topK?: number; category?: string }
            const resolvedScope = resolveReadableCategoryFilter(assignedCategories, categoryFilter, category, getKnownCategories)
            if ('error' in resolvedScope) return { success: false, output: resolvedScope.error }
            const mem = getAgentMemory()

            const k = Math.min(limit ?? topK ?? 5, 20)
            const results = await mem.recall(query, k, resolvedScope.filter)

            if (results.length === 0) {
                return { success: false, output: `No relevant memories found for this query${resolvedScope.category ? ` in "${resolvedScope.category.name}"` : ''}.` }
            }

            console.log(`[memory_semantic_search] Found ${results.length} results for query "${query.slice(0, 60)}" (limit=${k})`)

            // Enrich with total chunks per source
            const uniqueSourceKeys = [...new Set(
                results
                    .filter(r => r.sourceFile)
                    .map(r => `${r.sourceFile!}\u0000${r.categoryId || ''}`)
            )]
            const counts = await Promise.all(uniqueSourceKeys.map(key => {
                const [sf, sid] = key.split('\u0000')
                const filter = sid ? buildScopeFilter([{ id: sid }]) : resolvedScope.filter
                return mem.countChunks(sf, filter)
            }))
            const countMap = new Map(uniqueSourceKeys.map((key, i) => [key, counts[i]]))
            const categoryMap = buildCategoryMap(assignedCategories, getKnownCategories())

            const formatted = results.map(r => {
                const parts: string[] = []
                const categoryName = r.categoryId ? categoryMap.get(r.categoryId) || r.categoryId : undefined
                const ref = r.sourceFile && r.categoryId ? mem.getDocumentReference(r.categoryId, r.sourceFile) : undefined
                if (ref) parts.push(`[documentRef=${ref.documentRef}]`)
                if (r.sourceFile) {
                    const total = countMap.get(`${r.sourceFile}\u0000${r.categoryId || ''}`)
                    const label = categoryName ? `${categoryName} · ${r.sourceFile}` : r.sourceFile
                    if (r.chunkIndex != null && total) {
                        parts.push(`[${label} · Part ${r.chunkIndex + 1}/${total}]`)
                    } else {
                        parts.push(`[${label}]`)
                    }
                } else if (categoryName) {
                    parts.push(`[${categoryName}]`)
                }
                parts.push(`(score: ${(r.score * 100).toFixed(1)}%)`)
                parts.push(r.text)
                return parts.join(' ')
            }).join('\n\n---\n\n')

            const graphCategories = resolvedScope.category
                ? [resolvedScope.category]
                : (assignedCategories.length > 0 ? assignedCategories : getKnownCategories())
            const knowledge = getMemoryKnowledgeStore()
            const graphResult = graphCategories.length > 0
                ? await knowledge.search(query, graphCategories.map((category) => category.id), 8)
                : { graph: undefined }
            const graphContext = graphResult.graph ? knowledge.formatWalk(graphResult.graph) : ''
            const graphSection = graphContext ? `\n\n---\n\n${graphContext}` : ''

            return { success: true, output: `Showing ${results.length} result${results.length !== 1 ? 's' : ''}${resolvedScope.category ? ` from "${resolvedScope.category.name}"` : ''}:\n\n${formatted}${graphSection}` }
        }
    }
}

/**
 * Create a `knowledge_search` tool that lets the LLM inspect known
 * relationships and their connected entities.
 */
function resolveKnowledgeSpace(
    assignedCategories: MemoryCategoryRef[],
    category?: string,
): MemoryCategoryRef | { error: string } {
    if (assignedCategories.length === 0) {
        return { error: 'No memory category is selected for knowledge access.' }
    }
    if (category?.trim()) {
        const match = findSpaceByIdOrName(assignedCategories, category.trim())
        return match || { error: `Memory category "${category.trim()}" is not in the selected knowledge scope.` }
    }
    if (assignedCategories.length === 1) return assignedCategories[0]
    return { error: `Multiple memory categories are selected. Specify the target using the "category" parameter.\n${formatCategories(assignedCategories)}` }
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
                return { success: false, output: 'No memory category is selected for knowledge access.' }
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
                return { success: false, output: 'No knowledge entries are available in the selected memory categories.' }
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
                category: { type: 'string', description: 'Target memory category name or ID. Required when multiple memory categories are selected.' },
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
            'Entities may come from different selected memory categories. If mainName already belongs to an active entity anywhere in scope, that entity automatically remains stable; otherwise the first supplied ID remains stable. ' +
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
                    description: 'One or more full or readable node IDs (n:entity_name#xxxxxxxx) from knowledge_search. Legacy short IDs remain accepted. One ID is sufficient when mainName already belongs to another active entity.',
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
                    ENTITY_MERGE_OUT_OF_SCOPE: 'One or more entities are outside the selected memory category scope.',
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
                return { success: false, output: 'No memory category is selected for knowledge access.' }
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
    const getKnownCategories = createKnownMemoryCategoriesLoader()
    return {
        name: 'memory_create',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description:
            'Create a new memory entry with a title and content. ' +
            'Writes a Markdown file to the memory category and indexes it for semantic retrieval. ' +
            'Use this to persistently store notes, findings, or any information worth remembering. ' +
            'If exactly one memory category is selected, omit "category" to write there; otherwise omitted "category" writes to the default root memory category. ' +
            'Provide "category" to store in a specific selected category.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'A focused Subject - Aspect title for the memory entry (for example "Veronica Flowers - Hobbies"). The .md extension is appended automatically.' },
                content: { type: 'string', description: 'The Markdown text content to store in memory.' },
                category: { type: 'string', description: 'Optional memory category name, relative path (e.g. "projects/acme"), or ID. Omit to write to the only selected category, or to the default root category when no single selected category is in scope.' }
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
            const directoryPath = getMemoryCategoryDirectoryPath(resolved.categoryId)
            if (!directoryPath) {
                return { success: false, output: `Memory category "${resolved.categoryName}" has no category configured. Cannot create memory.` }
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
                output: `Memory "${uniqueName}" created and indexed in "${resolved.categoryName}" (documentRef=${indexed.documentRef}, chunks=${indexed.chunkCount}).${indexed.chunkCount > 3 ? ' Warning: this memory exceeds the 1–3 chunk topical target; consider splitting it by aspect.' : ''}`
            }
        }
    }
}

function memoryMutationSchema(extra: Record<string, unknown> = {}, extraRequired: string[] = []): Record<string, unknown> {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            documentRef: { type: 'string', description: 'Stable document reference returned by memory reads (for example project-notes#4k8z2q). It remains unchanged after updates.' },
            content: { type: 'string', description: 'Content to write.' },
            ...extra,
        },
        required: ['documentRef', 'content', ...extraRequired],
    }
}

async function prepareMemoryMutation(
    resolved: ResolvedMemoryDocument,
): Promise<{ resolved: ResolvedMemoryDocument; fileContent: string } | { error: string }> {
    let fileContent: string
    try {
        fileContent = readTextFile(resolved.directoryPath, resolved.fileName)
    } catch {
        return { error: `Could not read file "${resolved.fileName}" from memory category.` }
    }
    const referenceError = verifyDocumentRef(fileContent, resolved)
    return referenceError ? { error: referenceError } : { resolved, fileContent }
}

async function runPreparedMemoryMutation(
    params: { documentRef: string },
    assignedCategories: MemoryCategoryRef[],
    getKnownCategories: () => MemoryCategoryRef[],
    signal: AbortSignal | undefined,
    operation: (prepared: { resolved: ResolvedMemoryDocument; fileContent: string }) => Promise<ToolResult>,
    beforeMutation?: (documentId: string, content: string) => void,
): Promise<ToolResult> {
    const resolved = resolveMemoryDocumentRef(params.documentRef, assignedCategories, getKnownCategories)
    if ('error' in resolved) return { success: false, output: resolved.error }
    return withMemoryDocumentLock(resolved.documentId, signal, async () => {
        const prepared = await prepareMemoryMutation(resolved)
        if ('error' in prepared) return { success: false, output: prepared.error }
        beforeMutation?.(resolved.documentId, prepared.fileContent)
        return operation(prepared)
    })
}

export function makeMemoryUpdateTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedCategories = [] } = opts
    const getKnownCategories = createKnownMemoryCategoriesLoader()
    return {
        name: 'memory_update',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        description: 'Replace one topical memory using its stable documentRef. Search and read it first. Newer supported facts replace obsolete statements; do not append a change log. Optionally rename or recategorize it.',
        parameters: memoryMutationSchema({
            title: { type: 'string', description: 'Optional new Subject - Aspect title.' },
            category: { type: 'string', description: 'Optional existing or new category path inside a granted category tree.' },
        }),
        timeout: 120_000,
        execute: async (params: unknown, signal?: AbortSignal) => {
            const input = params as { documentRef: string; content: string; title?: string; category?: string }
            return runPreparedMemoryMutation(input, assignedCategories, getKnownCategories, signal, async ({ resolved, fileContent }) => {
                const target = input.category
                    ? await resolveTargetCategory(assignedCategories, input.category, undefined, getKnownCategories)
                    : { categoryId: resolved.categoryId, categoryName: resolved.categoryName }
                if ('error' in target) return { success: false, output: target.error }
                const finalName = input.title ? (input.title.endsWith('.md') ? input.title : `${input.title}.md`) : resolved.fileName
                if (basename(finalName) !== finalName || finalName.startsWith('.') || !finalName.trim()) {
                    return { success: false, output: 'The memory title must be a plain, visible file name without path separators.' }
                }
                const targetDirectory = getMemoryCategoryDirectoryPath(target.categoryId)
                if (!targetDirectory) return { success: false, output: 'Target memory category is unavailable.' }
                const relocating = target.categoryId !== resolved.categoryId || finalName !== resolved.fileName
                if (relocating && fileExists(targetDirectory, finalName)) {
                    return { success: false, output: `Memory "${finalName}" already exists in "${target.categoryName}".` }
                }

                let indexed = await commitMemoryMutation(resolved, fileContent, input.content, signal, opts.revisionContext)
                if (relocating) {
                    const { renameSync } = await import('node:fs')
                    renameSync(join(resolved.directoryPath, resolved.fileName), join(targetDirectory, finalName))
                    await getAgentMemory().remapMovedFileByHash(target.categoryId, finalName, targetDirectory)
                    indexed = await reindexMemoryFile(target.categoryId, finalName, signal, opts.revisionContext)
                }
                opts.onDocumentMutated?.(indexed.documentId)
                return { success: true, output: `Memory "${finalName}" replaced in "${target.categoryName}" (documentRef=${indexed.documentRef}, chunks=${indexed.chunkCount}).${indexed.chunkCount > 3 ? ' Warning: this memory exceeds the 1–3 chunk topical target.' : ''}` }
            }, opts.beforeDocumentMutation)
        },
    }
}

function memoryRemovalSchema(): Record<string, unknown> {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            documentRef: { type: 'string', description: 'Stable document reference returned by memory reads (for example project-notes#4k8z2q). It remains unchanged after updates.' },
        },
        required: ['documentRef'],
    }
}

export function makeMemoryDeleteTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedCategories = [] } = opts
    const getKnownCategories = createKnownMemoryCategoriesLoader()
    return {
        name: 'memory_delete',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        description: 'Forget an entire memory document using its stable documentRef. This archives the source in hidden trash and removes its retrieval and graph indexes.',
        parameters: memoryRemovalSchema(),
        timeout: 30_000,
        execute: async (params: unknown, signal?: AbortSignal) => {
            const input = params as { documentRef: string }
            return runPreparedMemoryMutation(input, assignedCategories, getKnownCategories, signal, async ({ resolved, fileContent }) => {
                const removed = await commitMemoryRemoval(resolved, fileContent)
                return { success: true, output: `Memory "${resolved.fileName}" forgotten from "${resolved.categoryName}" (${removed.deletedChunks} indexed chunks and ${removed.deletedEdges} graph edges removed).` }
            }, opts.beforeDocumentMutation)
        },
    }
}
