import type { ToolDefinition, ToolResult } from '../../gateway/providers/base.provider.js'
import { createHash } from 'node:crypto'
import { getDb } from '../../../db/database.js'
import { getAgentMemory } from '../../memory/agent-memory.js'
import { buildMemorySpaceFilter as buildScopeFilter, getDefaultMemorySpace, getMemorySpaceFolderPath, type MemorySpaceRef } from '../../memory/memory-space-scope.js'
import { relativePathForFolder } from '../../memory/memory-space-folders.js'
import { readTextFile, writeTextFile, fileExists, backupToRevisions, resolveUniqueFileName, deleteFile } from '../../memory/memory-file-manager.js'
import { getEntityGraphStore, type EntityEdge, type EntityNode, type EntityType } from '../../memory/entity-graph.js'
import { deleteMemoryGraphSource, legacyMemoryGraphSourceId, memoryGraphSourceId } from '../../memory/memory-entity-indexer.js'
import { cancelMemoryIndexJobsForFile } from '../../memory/memory-index-jobs.js'

function abortPendingMemoryIndexJobs(spaceId: string, fileName: string): void {
    cancelMemoryIndexJobsForFile(spaceId, fileName)
}

function clearMemoryGraphSource(spaceId: string, fileName: string): void {
    deleteMemoryGraphSource(spaceId, fileName)
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
    spaceId: string,
    fileName: string,
    signal?: AbortSignal,
): Promise<{ chunkCount: number; revision: string; documentId: string }> {
    const folderPath = getMemorySpaceFolderPath(spaceId)
    if (!folderPath) throw new Error('Memory folder has no folder configured')
    cancelMemoryIndexJobsForFile(spaceId, fileName)
    const memory = getAgentMemory()
    const result = await memory.reindexFile(folderPath, fileName, spaceId, { signal })
    const ref = memory.getDocumentReference(spaceId, result.fileName)
    if (!ref) throw new Error('Memory was indexed but its document reference could not be loaded')
    return { chunkCount: result.chunkCount, revision: ref.revision, documentId: ref.documentId }
}

export const MEMORY_READ_TOOL_NAMES = [
    'memory_list_documents',
    'memory_retrieve_chunks',
    'memory_semantic_search',
] as const

export const MEMORY_WRITE_TOOL_NAMES = [
    'memory_create',
    'memory_append',
    'memory_replace_range',
    'memory_replace_all',
    'memory_remove_all',
    'memory_remove_range',
] as const

export const MEMORY_TOOL_NAMES = [
    ...MEMORY_READ_TOOL_NAMES,
    ...MEMORY_WRITE_TOOL_NAMES,
] as const

export const RELATIONSHIP_GRAPH_TOOL_NAMES = [
    'relationship_graph_search',
    'relationship_graph_assert',
    'relationship_graph_delete',
] as const
export const RELATIONSHIP_GRAPH_READ_TOOL_NAMES = ['relationship_graph_search'] as const

export type MemoryReadToolName = (typeof MEMORY_READ_TOOL_NAMES)[number]
export type MemoryWriteToolName = (typeof MEMORY_WRITE_TOOL_NAMES)[number]
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number]
export type RelationshipGraphToolName = (typeof RELATIONSHIP_GRAPH_TOOL_NAMES)[number]
export type RelationshipGraphReadToolName = (typeof RELATIONSHIP_GRAPH_READ_TOOL_NAMES)[number]

export function isMemoryToolName(toolName: string): toolName is MemoryToolName {
    return (MEMORY_TOOL_NAMES as readonly string[]).includes(toolName)
}

export function isMemoryReadToolName(toolName: string): toolName is MemoryReadToolName {
    return (MEMORY_READ_TOOL_NAMES as readonly string[]).includes(toolName)
}

export function isRelationshipGraphToolName(toolName: string): toolName is RelationshipGraphToolName {
    return (RELATIONSHIP_GRAPH_TOOL_NAMES as readonly string[]).includes(toolName)
}

export function isRelationshipGraphReadToolName(toolName: string): toolName is RelationshipGraphReadToolName {
    return (RELATIONSHIP_GRAPH_READ_TOOL_NAMES as readonly string[]).includes(toolName)
}

export interface MemoryToolOptions {
    /** SQL filter covering all selected memory folders, e.g. `spaceId IN ('...', '...')`. */
    spaceFilter?: string
    /** Selected memory folders for write tools and read disambiguation. */
    assignedSpaces?: MemorySpaceRef[]
}

const ENTITY_TYPES = ['person', 'place', 'organization', 'project', 'event', 'date', 'technology', 'product', 'artifact', 'concept', 'other'] as const
const ENTITY_GRAPH_SHORT_ID_LENGTH = 8
const IMPORTANCE_LABELS = ['temporary', 'minor', 'useful', 'core'] as const
type ImportanceLabel = (typeof IMPORTANCE_LABELS)[number]
const IMPORTANCE_MAP: Record<ImportanceLabel, 0 | 1 | 2 | 3> = {
    temporary: 0,
    minor: 1,
    useful: 2,
    core: 3,
}

function shortEntityGraphId(prefix: 'n' | 'e', id: string): string {
    return `${prefix}:${id.slice(0, ENTITY_GRAPH_SHORT_ID_LENGTH)}`
}

function resolveEntityGraphEdgeId(value: string): { id: string } | { error: string } {
    const trimmed = value.trim()
    const shortId = trimmed.startsWith('e:') ? trimmed.slice(2) : trimmed
    if (!trimmed.startsWith('e:') || shortId.length === 0) return { id: trimmed }
    const rows = getDb().prepare('SELECT id FROM entity_graph_edges WHERE id LIKE ? ORDER BY last_seen_at DESC LIMIT 2').all(`${shortId}%`) as { id: string }[]
    if (rows.length === 1) return { id: rows[0].id }
    if (rows.length > 1) {
        return { error: `Multiple relationship graph edges match id prefix ${trimmed}. Use relationship_graph_search to get the full id, then retry.` }
    }
    return { id: trimmed }
}

function formatEntityNode(node: EntityNode): string {
    const aliases = node.aliases.length ? ` aliases=${node.aliases.join(', ')}` : ''
    const importanceLabel = IMPORTANCE_LABELS[node.importance] ?? 'minor'
    return `- [${importanceLabel}] ${node.name} (${node.type}, id=${shortEntityGraphId('n', node.id)}, mentions=${node.mentionCount}${aliases})`
}

function formatEntityEdge(edge: EntityEdge): string {
    const importanceLabel = IMPORTANCE_LABELS[edge.importance] ?? 'minor'
    const evidence = edge.evidence ? ` Evidence: ${edge.evidence}` : ''
    return `- [${importanceLabel}] ${edge.fromName} --${edge.relation}--> ${edge.toName} (id=${shortEntityGraphId('e', edge.id)}, confidence=${edge.confidence.toFixed(2)}, mentions=${edge.mentionCount}).${evidence}`
}

function normalizeEntityType(value: unknown): EntityType {
    return typeof value === 'string' && (ENTITY_TYPES as readonly string[]).includes(value)
        ? value as EntityType
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

function toEntityInput(value: unknown): { name: string; type: EntityType; aliases: string[] } | { error: string } {
    if (!value || typeof value !== 'object') return { error: 'Expected entity objects with name, type, and optional aliases.' }
    const obj = value as { name?: unknown; type?: unknown; aliases?: unknown }
    const name = cleanEntityName(obj.name)
    if (name.length < 2) return { error: 'Entity names must be at least 2 characters long.' }
    return {
        name,
        type: normalizeEntityType(obj.type),
        aliases: cleanAliases(obj.aliases),
    }
}

function getKnownMemorySpaces(): MemorySpaceRef[] {
    try {
        const db = getDb()
        const rows = db
            .prepare('SELECT id, name, folder_path, is_default FROM memory_spaces ORDER BY is_default DESC, folder_path ASC')
            .all() as { id: string; name: string; folder_path: string; is_default: number }[]
        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            relativePath: row.is_default === 1 ? '' : relativePathForFolder(row.folder_path),
        }))
    } catch {
        return []
    }
}

function createKnownMemorySpacesLoader(): () => MemorySpaceRef[] {
    let cached: MemorySpaceRef[] | undefined
    return () => {
        cached ??= getKnownMemorySpaces()
        return cached
    }
}

function formatSpaces(spaces: MemorySpaceRef[]): string {
    if (spaces.length === 0) return 'No memory folders exist yet.'
    return spaces.map(s => {
        const path = s.relativePath ? `, folder: ${s.relativePath}` : ', folder: Default'
        return `  - "${s.name}" (id: ${s.id}${path})`
    }).join('\n')
}

function findSpaceByIdOrName(spaces: MemorySpaceRef[], wanted: string): MemorySpaceRef | undefined {
    const normalized = wanted.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()
    return spaces.find(s =>
        s.id === wanted ||
        s.name.toLowerCase() === wanted.toLowerCase() ||
        (s.relativePath || '').toLowerCase() === normalized ||
        (s.relativePath === '' && normalized === 'default')
    )
}

function makeScopeSummary(assignedSpaces: MemorySpaceRef[]): string {
    if (assignedSpaces.length === 0) {
        const defaultSpace = getDefaultMemorySpace()
        return defaultSpace ? `Scope: all memory folders; writes default to "${defaultSpace.name}".` : 'Scope: no memory folders.'
    }
    if (assignedSpaces.length === 1) return `Scope: "${assignedSpaces[0].name}" folder only.`
    return `Scope: selected memory folders only (${assignedSpaces.map(s => `"${s.name}"`).join(', ')}).`
}

function buildSpaceMap(...spaceGroups: MemorySpaceRef[][]): Map<string, string> {
    const map = new Map<string, string>()
    for (const group of spaceGroups) {
        for (const space of group) map.set(space.id, space.name)
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

function resolveReadableSpaceFilter(
    assignedSpaces: MemorySpaceRef[],
    baseFilter?: string,
    folderParam?: string,
    getKnownSpaces: () => MemorySpaceRef[] = getKnownMemorySpaces,
): { filter?: string; space?: MemorySpaceRef } | { error: string } {
    if (!folderParam?.trim()) return { filter: baseFilter }

    const candidates = assignedSpaces.length > 0 ? assignedSpaces : getKnownSpaces()
    const wanted = folderParam.trim()
    const match = findSpaceByIdOrName(candidates, wanted)
    if (!match) {
        const scopeLabel = assignedSpaces.length > 0 ? 'selected memory folders' : 'existing memory folders'
        return {
            error: `Memory folder "${wanted}" was not found in ${scopeLabel}.\n${formatSpaces(candidates)}`
        }
    }

    return { filter: buildScopeFilter([match]), space: match }
}

/**
 * Resolve the target folder for a write operation, with smart name-based fallback.
 * Priority (when no explicit folder param):
 * 1. If title exists in exactly one selected folder → use that
 * 2. If exactly one folder is selected → use it
 * 3. If default folder exists → use it for unspecified writes
 * 4. If multiple folders are selected and no default exists → error
 * 5. If no folders exist → error
 */
async function resolveTargetSpace(
    assignedSpaces: MemorySpaceRef[],
    folderParam?: string,
    existingTitle?: string,
    getKnownSpaces: () => MemorySpaceRef[] = getKnownMemorySpaces,
): Promise<{ spaceId: string; spaceName: string } | { error: string }> {
    // --- Explicit folder parameter provided ---
    if (folderParam?.trim()) {
        const wanted = folderParam.trim()
        const candidates = assignedSpaces.length > 0 ? assignedSpaces : getKnownSpaces()
        const match = findSpaceByIdOrName(candidates, wanted)
        if (match) return { spaceId: match.id, spaceName: match.name }

        const scopeLabel = assignedSpaces.length > 0 ? 'selected memory folders' : 'existing memory folders'
        return {
            error: `Memory folder "${wanted}" not found in ${scopeLabel}.\n${formatSpaces(candidates.length > 0 ? candidates : getKnownSpaces())}`
        }
    }

    // --- No explicit folder parameter ---
    // For updates: try smart title-based resolution first
    if (existingTitle && assignedSpaces.length > 0) {
        const mem = getAgentMemory()
        const counts = await Promise.all(
            assignedSpaces.map(async (space) => {
                const filter = buildScopeFilter([space])
                try {
                    return await mem.countChunks(existingTitle, filter)
                } catch {
                    // Ignore errors in checking individual spaces
                    return 0
                }
            })
        )
        const matchingSpaces = assignedSpaces.filter((_, i) => counts[i] > 0)

        if (matchingSpaces.length === 1) {
            // Title exists in exactly one space — use that
            return { spaceId: matchingSpaces[0].id, spaceName: matchingSpaces[0].name }
        }

        if (matchingSpaces.length > 1) {
            // Title exists in multiple spaces — need explicit selection
            const listing = matchingSpaces.map(s => `  - "${s.name}" (id: ${s.id})`).join('\n')
            return { error: `Memory entry "${existingTitle}" exists in multiple folders. Please specify which to update using the 'folder' parameter:\n${listing}` }
        }
    }

    // --- Smart fallback logic ---
    // If exactly one space is in scope, omitted "folder" writes target that space.
    if (assignedSpaces.length === 1) {
        return { spaceId: assignedSpaces[0].id, spaceName: assignedSpaces[0].name }
    }

    // Unspecified writes outside a single selected scope land in the root/default memory folder.
    const defaultSpace = getDefaultMemorySpace()
    if (defaultSpace) {
        return { spaceId: defaultSpace.id, spaceName: defaultSpace.name }
    }

    // Multiple selected folders but no default or unambiguous match → error
    if (assignedSpaces.length > 1) {
        return { error: `Multiple memory folders are selected. Please specify which to write to using the 'folder' parameter.\nAvailable folders:\n${formatSpaces(assignedSpaces)}` }
    }

    // 4. No folders at all
    const existing = getKnownSpaces()
    return {
        error:
            'No memory folder is selected for writes. Provide the target memory folder using the "folder" parameter, select one in the conversation, or assign one to the agent.\n' +
            `Existing memory folders:\n${formatSpaces(existing)}`
    }
}

interface ResolvedMemoryDocument {
    documentId: string
    revision: string
    spaceId: string
    spaceName: string
    fileName: string
    folderPath: string
}

function resolveMemoryDocumentById(
    documentId: string,
    assignedSpaces: MemorySpaceRef[],
    getKnownSpaces: () => MemorySpaceRef[],
): ResolvedMemoryDocument | { error: string } {
    const ref = getAgentMemory().getDocumentReferenceById(documentId.trim())
    if (!ref) return { error: `No memory document found with documentId="${documentId}". Search or list memories again to get a current documentId.` }
    if (assignedSpaces.length > 0 && !assignedSpaces.some((space) => space.id === ref.spaceId)) {
        return { error: `Memory document "${documentId}" is outside the selected memory-folder scope.` }
    }
    const space = [...assignedSpaces, ...getKnownSpaces()].find((candidate) => candidate.id === ref.spaceId)
    const folderPath = getMemorySpaceFolderPath(ref.spaceId)
    if (!space || !folderPath) return { error: `The memory folder for document "${documentId}" is unavailable.` }
    if (!fileExists(folderPath, ref.fileName)) return { error: `The source file for memory document "${documentId}" no longer exists.` }
    return {
        documentId: ref.documentId,
        revision: ref.revision,
        spaceId: ref.spaceId,
        spaceName: space.name,
        fileName: ref.fileName,
        folderPath,
    }
}

function verifyExpectedRevision(content: string, expectedRevision: string): string | undefined {
    const actualRevision = createHash('sha256').update(content).digest('hex')
    return actualRevision === expectedRevision
        ? undefined
        : `Memory changed since it was retrieved (expected revision ${expectedRevision}, current revision ${actualRevision}). Retrieve it again before retrying the update.`
}

async function commitMemoryMutation(
    resolved: ResolvedMemoryDocument,
    previousContent: string,
    nextContent: string,
    signal?: AbortSignal,
): Promise<{ chunkCount: number; revision: string; documentId: string }> {
    backupToRevisions(resolved.folderPath, resolved.fileName)
    writeTextFile(resolved.folderPath, resolved.fileName, nextContent)
    let indexed: Awaited<ReturnType<typeof reindexMemoryFile>>
    try {
        indexed = await reindexMemoryFile(resolved.spaceId, resolved.fileName, signal)
    } catch (err) {
        // Restore source and retrieval index together; a failed embedding call
        // must not leave disk and search representing different revisions.
        writeTextFile(resolved.folderPath, resolved.fileName, previousContent)
        await reindexMemoryFile(resolved.spaceId, resolved.fileName).catch(() => undefined)
        throw new Error(`Memory update failed and the previous revision was restored: ${(err as Error).message}`)
    }
    // Graph data is derived and must not make the authoritative file/vector
    // commit fail after both have reached the new revision.
    try {
        clearMemoryGraphSource(resolved.spaceId, resolved.fileName)
    } catch (err) {
        console.warn('[memory-tools] Failed to invalidate derived graph data after memory update:', err)
    }
    return indexed
}

async function commitMemoryRemoval(
    resolved: ResolvedMemoryDocument,
    previousContent: string,
): Promise<{ deletedChunks: number; deletedEdges: number }> {
    backupToRevisions(resolved.folderPath, resolved.fileName)
    abortPendingMemoryIndexJobs(resolved.spaceId, resolved.fileName)
    let deletedChunks: number
    try {
        deletedChunks = await getAgentMemory().deleteSourceFile(resolved.fileName, resolved.spaceId)
    } catch (err) {
        // A vector-store failure or filesystem failure must not leave only one
        // side removed. Recreate the source if needed, then rebuild its index.
        if (!fileExists(resolved.folderPath, resolved.fileName)) {
            writeTextFile(resolved.folderPath, resolved.fileName, previousContent)
        }
        await reindexMemoryFile(resolved.spaceId, resolved.fileName).catch(() => undefined)
        throw new Error(`Memory removal failed and the previous revision was restored: ${(err as Error).message}`)
    }
    try {
        const { edgesDeleted } = deleteMemoryGraphSource(resolved.spaceId, resolved.fileName)
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
    const { spaceFilter, assignedSpaces = [] } = opts
    const getKnownSpaces = createKnownMemorySpacesLoader()
    return {
        name: 'memory_list_documents',
        execution: { readOnly: true },
        description:
            'List memorised documents (source files) stored in your knowledge base. ' +
            'Returns document names, chunk counts, and ingestion dates. Paginated — max 100 per page. ' +
            'Results are newest first. ' +
            'Use this to discover what documents are available before using memory_retrieve_chunks or memory_semantic_search. ' +
            'Selected memory folders are treated as one unified knowledge base for reading — use the optional "folder" parameter to filter to a specific folder. ' +
            makeScopeSummary(assignedSpaces),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                pageIndex: { type: 'number', description: 'Zero-based page index (default: 0). Each page returns up to 100 documents.' },
                folder: { type: 'string', description: 'Optional memory folder name, relative path (e.g. "projects/acme"), or ID to restrict the listing. Without this, lists all selected folders.' },
            },
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            const { pageIndex, folder } = (params || {}) as { pageIndex?: number; folder?: string }
            const resolvedScope = resolveReadableSpaceFilter(assignedSpaces, spaceFilter, folder, getKnownSpaces)
            if ('error' in resolvedScope) return { success: false, output: resolvedScope.error }
            const mem = getAgentMemory()
            const allFiles = await mem.listSourceFiles(undefined, resolvedScope.filter)

            if (allFiles.length === 0) {
                const location = resolvedScope.space ? `"${resolvedScope.space.name}"` : 'memory'
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

            const spaceMap = buildSpaceMap(assignedSpaces, getKnownSpaces())
            const lines = pageFiles.map((file) => {
                const ref = file.spaceId ? mem.getDocumentReference(file.spaceId, file.sourceFile) : undefined
                const location = file.spaceId ? `, folder=${spaceMap.get(file.spaceId) || file.spaceId}` : ''
                const identity = ref ? `, documentId=${ref.documentId}, revision=${ref.revision}` : ''
                return `- ${file.sourceFile} (${file.chunkCount} chunk${file.chunkCount !== 1 ? 's' : ''}${location}${identity})`
            })

            const scope = resolvedScope.space ? ` in "${resolvedScope.space.name}"` : ''
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
    const { spaceFilter, assignedSpaces = [] } = opts
    const getKnownSpaces = createKnownMemorySpacesLoader()
    return {
        name: 'memory_retrieve_chunks',
        execution: { readOnly: true },
        description:
            'Retrieve additional chunks from a stored document by source file and part number range. ' +
            'Very useful to gather more detail of a section (e.g. "Part 4 - 6" when Part 5 matches). ' +
            'Returns the text of each chunk in order. ' +
            makeScopeSummary(assignedSpaces),
        parameters: {
            type: 'object',
            properties: {
                sourceFile: { type: 'string', description: 'The source file name exactly as shown in the memory context (e.g. "report.pdf", "notes.md").' },
                minPart: { type: 'number', description: 'Minimum Part number to retrieve, matching the 1-based Part number shown in memory search results.' },
                maxPart: { type: 'number', description: 'Maximum Part number to retrieve, inclusive, matching the 1-based Part number shown in memory search results.' },
                folder: { type: 'string', description: 'Optional memory folder name, relative path (e.g. "projects/acme"), or ID. Use this when the same source file exists in more than one folder.' }
            },
            required: ['sourceFile', 'minPart', 'maxPart']
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            const { sourceFile, minPart, maxPart, minIndex: legacyMinIndex, maxIndex: legacyMaxIndex, folder } = params as {
                sourceFile: string; minPart?: number; maxPart?: number; minIndex?: number; maxIndex?: number; folder?: string
            }
            const requestedFolder = folder
            const resolvedScope = resolveReadableSpaceFilter(assignedSpaces, spaceFilter, requestedFolder, getKnownSpaces)
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
            const chunks = await mem.getChunksByRange(sourceFile, requestedMinIndex, cappedMax, resolvedScope.filter)

            if (chunks.length === 0) {
                return { success: false, output: `No chunks found for "${sourceFile}" in Part range ${requestedMinIndex + 1}-${cappedMax + 1}.` }
            }

            const distinctSpaces = [...new Set(chunks.map(c => c.spaceId).filter((id): id is string => Boolean(id)))]
            if (!requestedFolder && distinctSpaces.length > 1) {
                const spaceMap = buildSpaceMap(assignedSpaces, getKnownSpaces())
                const listing = distinctSpaces.map(id => `  - "${spaceMap.get(id) || id}" (id: ${id})`).join('\n')
                return {
                    success: false,
                    output: `Source file "${sourceFile}" exists in multiple memory folders. Re-run with the 'folder' parameter.\nMatching folders:\n${listing}`
                }
            }

            const total = await mem.countChunks(sourceFile, resolvedScope.filter)
            const spaceMap = buildSpaceMap(assignedSpaces, getKnownSpaces())
            const resolvedSpaceId = distinctSpaces.length === 1 ? distinctSpaces[0] : resolvedScope.space?.id
            const documentRef = resolvedSpaceId ? mem.getDocumentReference(resolvedSpaceId, sourceFile) : undefined
            const formatted = chunks.map(c => {
                const location = c.spaceId && !resolvedScope.space
                    ? `[${spaceMap.get(c.spaceId) || c.spaceId} · Part ${c.chunkIndex + 1}/${total}]`
                    : `[Part ${c.chunkIndex + 1}/${total}]`
                return `${location}\n${c.text}`
            }).join('\n\n---\n\n')
            const wasCapped = cappedMax < requestedMaxIndex
            const capNote = wasCapped
                ? `\n\n(Showing Parts ${requestedMinIndex + 1}-${cappedMax + 1} of requested Parts ${requestedMinIndex + 1}-${requestedMaxIndex + 1}; capped at 20 chunks per call. Call again with a later range to continue.)`
                : ''
            const identity = documentRef
                ? `[Document: documentId=${documentRef.documentId}, revision=${documentRef.revision}]\n\n`
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
    const { spaceFilter, assignedSpaces = [] } = opts
    const getKnownSpaces = createKnownMemorySpacesLoader()
    return {
        name: 'memory_semantic_search',
        execution: { readOnly: true },
        description:
            'Search through stored RAG memories using a semantic query. ' +
            'Use this to get a rough starting point for memories, which can then be refined or expanded using other tools. ' +
            'Returns the most relevant memory chunks with their source, memory folder, and chunk index. ' +
            'Selected memory folders are treated as one unified knowledge base — use the optional "folder" parameter to filter to a specific folder. ' +
            makeScopeSummary(assignedSpaces),
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'A descriptive search query to find relevant memories.' },
                limit: { type: 'number', description: 'Maximum number of results to return (default: 5, max: 20).' },
                folder: { type: 'string', description: 'Optional memory folder name, relative path (e.g. "projects/acme"), or ID to restrict the search. Without this, searches all selected folders.' }
            },
            required: ['query']
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            const query = pickToolString(params, ['query', 'search_query', 'searchQuery', 'text'])
            if (!query) {
                return { success: false, output: 'A non-empty "query" string is required for memory_semantic_search.' }
            }
            const { limit, topK, folder } = (params || {}) as { limit?: number; topK?: number; folder?: string }
            const resolvedScope = resolveReadableSpaceFilter(assignedSpaces, spaceFilter, folder, getKnownSpaces)
            if ('error' in resolvedScope) return { success: false, output: resolvedScope.error }
            const mem = getAgentMemory()

            const k = Math.min(limit ?? topK ?? 5, 20)
            const results = await mem.recall(query, k, resolvedScope.filter)

            if (results.length === 0) {
                return { success: false, output: `No relevant memories found for this query${resolvedScope.space ? ` in "${resolvedScope.space.name}"` : ''}.` }
            }

            console.log(`[memory_semantic_search] Found ${results.length} results for query "${query.slice(0, 60)}" (limit=${k})`)

            // Enrich with total chunks per source
            const uniqueSourceKeys = [...new Set(
                results
                    .filter(r => r.sourceFile)
                    .map(r => `${r.sourceFile!}\u0000${r.spaceId || ''}`)
            )]
            const counts = await Promise.all(uniqueSourceKeys.map(key => {
                const [sf, sid] = key.split('\u0000')
                const filter = sid ? buildScopeFilter([{ id: sid }]) : resolvedScope.filter
                return mem.countChunks(sf, filter)
            }))
            const countMap = new Map(uniqueSourceKeys.map((key, i) => [key, counts[i]]))
            const spaceMap = buildSpaceMap(assignedSpaces, getKnownSpaces())

            const formatted = results.map(r => {
                const parts: string[] = []
                const spaceName = r.spaceId ? spaceMap.get(r.spaceId) || r.spaceId : undefined
                const ref = r.sourceFile && r.spaceId ? mem.getDocumentReference(r.spaceId, r.sourceFile) : undefined
                if (ref) parts.push(`[documentId=${ref.documentId}, revision=${ref.revision}]`)
                if (r.sourceFile) {
                    const total = countMap.get(`${r.sourceFile}\u0000${r.spaceId || ''}`)
                    const label = spaceName ? `${spaceName} · ${r.sourceFile}` : r.sourceFile
                    if (r.chunkIndex != null && total) {
                        parts.push(`[${label} · Part ${r.chunkIndex + 1}/${total}]`)
                    } else {
                        parts.push(`[${label}]`)
                    }
                } else if (spaceName) {
                    parts.push(`[${spaceName}]`)
                }
                parts.push(`(score: ${(r.score * 100).toFixed(1)}%)`)
                parts.push(r.text)
                return parts.join(' ')
            }).join('\n\n---\n\n')

            const graph = getEntityGraphStore()
            const seedNodes = graph.findSeedNodes(query, results.map((r) => r.text), 8)
            const graphSourceIds = memoryGraphSourceIdsForChunks(results)
            const graphContext = seedNodes.length > 0
                ? graph.formatWalk(graph.walk(seedNodes.map((node) => node.id), 2, 24, 0, {
                    sourceIds: graphSourceIds,
                    contextText: [query, ...results.map((r) => r.text)].join(' '),
                }))
                : ''
            const graphSection = graphContext ? `\n\n---\n\n${graphContext}` : ''

            return { success: true, output: `Showing ${results.length} result${results.length !== 1 ? 's' : ''}${resolvedScope.space ? ` from "${resolvedScope.space.name}"` : ''}:\n\n${formatted}${graphSection}` }
        }
    }
}

function memoryGraphSourceIdsForChunks(chunks: Array<{ sourceFile?: string; spaceId?: string }>): string[] {
    const sourceIds = new Set<string>()
    for (const chunk of chunks) {
        if (!chunk.sourceFile) continue
        if (chunk.spaceId) sourceIds.add(memoryGraphSourceId(chunk.spaceId, chunk.sourceFile))
        else sourceIds.add(legacyMemoryGraphSourceId(chunk.sourceFile))
    }
    return Array.from(sourceIds)
}

/**
 * Create a `relationship_graph_search` tool that lets the LLM inspect known
 * relationships and their connected entities.
 */
function relationshipGraphSourcePrefixes(assignedSpaces: MemorySpaceRef[]): string[] {
    return assignedSpaces.flatMap((space) => [
        `memory:${space.id}:`,
        `memory-space:${space.id}:`,
    ])
}

function resolveRelationshipGraphSpace(
    assignedSpaces: MemorySpaceRef[],
    folder?: string,
): MemorySpaceRef | { error: string } {
    if (assignedSpaces.length === 0) {
        return { error: 'No memory folder is selected for relationship graph access.' }
    }
    if (folder?.trim()) {
        const match = findSpaceByIdOrName(assignedSpaces, folder.trim())
        return match || { error: `Memory folder "${folder.trim()}" is not in the selected relationship graph scope.` }
    }
    if (assignedSpaces.length === 1) return assignedSpaces[0]
    return { error: `Multiple memory folders are selected. Specify the target using the "folder" parameter.\n${formatSpaces(assignedSpaces)}` }
}

export function makeRelationshipGraphSearchTool(opts: MemoryToolOptions = {}): ToolDefinition {
    const assignedSpaces = opts.assignedSpaces || []
    const sourceIdPrefixes = relationshipGraphSourcePrefixes(assignedSpaces)
    return {
        name: 'relationship_graph_search',
        execution: { readOnly: true },
        description:
            'Search and inspect the durable relationship graph extracted from conversations and memory use. ' +
            'Use this to look up known people, organizations, projects, technologies, concepts, or relationships. ' +
            'Provide a query to find matching entities and walk nearby relationships, or omit query to list recent graph entries.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Entity name, alias, or natural-language phrase to search for.' },
                depth: { type: 'number', description: 'Relationship walk depth from matched entities (default: 1 for focused query searches, max: 3).' },
                limit: { type: 'number', description: 'Maximum number of nodes/edges to return (default: 20, max: 80).' },
            },
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            if (sourceIdPrefixes.length === 0) {
                return { success: false, output: 'No memory folder is selected for relationship graph access.' }
            }
            const query = pickToolString(params, ['query', 'entity', 'name', 'search_query', 'searchQuery'])
            const { depth, limit } = (params || {}) as { depth?: number; limit?: number }
            const graph = getEntityGraphStore()
            const cappedLimit = Math.floor(clampToolNumber(limit, 20, 1, 80))

            if (query) {
                const seedNodes = graph.findSeedNodes(query, [], Math.min(cappedLimit, 12))
                if (seedNodes.length === 0) {
                    return { success: false, output: `No relationship graph nodes matched "${query}".` }
                }

                const walkDepth = Math.floor(clampToolNumber(depth, 1, 1, 3))
                const walk = graph.focusedWalk(seedNodes.map((node) => node.id), query, walkDepth, cappedLimit, 0, { sourceIdPrefixes })
                if (walk.edges.length === 0) {
                    return { success: false, output: `No relationship graph entries in the selected memory folders matched "${query}".` }
                }
                const nodeLines = walk.nodes.slice(0, cappedLimit).map(formatEntityNode)
                const edgeLines = walk.edges.slice(0, cappedLimit).map(formatEntityEdge)
                const sections = [
                    `Matched ${seedNodes.length} seed node${seedNodes.length !== 1 ? 's' : ''}; focused ${walkDepth} hop${walkDepth !== 1 ? 's' : ''}.`,
                    nodeLines.length ? `Nodes:\n${nodeLines.join('\n')}` : '',
                    edgeLines.length ? `Relationships:\n${edgeLines.join('\n')}` : 'No relationships connected to the matched nodes.',
                ].filter(Boolean)
                return { success: true, output: sections.join('\n\n') }
            }

            const snapshot = graph.list(cappedLimit, 0, sourceIdPrefixes)
            if (snapshot.nodes.length === 0 && snapshot.edges.length === 0) {
                return { success: false, output: 'No relationship graph entries are available in the selected memory folders.' }
            }

            const nodeLines = snapshot.nodes.map(formatEntityNode)
            const edgeLines = snapshot.edges.map(formatEntityEdge)
            return {
                success: true,
                output: [
                    `Recent relationship graph entries (limit ${cappedLimit}):`,
                    nodeLines.length ? `Nodes:\n${nodeLines.join('\n')}` : '',
                    edgeLines.length ? `Relationships:\n${edgeLines.join('\n')}` : '',
                ].filter(Boolean).join('\n\n'),
            }
        },
    }
}

/**
 * Create a `relationship_graph_assert` tool that lets the LLM actively record
 * or correct a relationship in the relationship graph.
 */
export function makeRelationshipGraphAssertTool(opts: MemoryToolOptions = {}): ToolDefinition {
    const assignedSpaces = opts.assignedSpaces || []
    return {
        name: 'relationship_graph_assert',
        description:
            'Assert or update a durable relationship in the relationship graph. ' +
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
                confidence: { type: 'number', description: 'Confidence from 0.1 to 1.0 (default: 0.9 for explicit user-provided facts).' },
                importance: { type: 'string', enum: IMPORTANCE_LABELS, description: 'Importance: temporary, minor, useful (durable fact), or core.' },
                evidence: { type: 'string', description: 'Short evidence phrase explaining why this relationship is true.' },
                folder: { type: 'string', description: 'Target memory folder name or ID. Required when multiple memory folders are selected.' },
            },
            required: ['from', 'relation', 'to'],
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            const { from, relation, to, confidence, importance, evidence, folder } = (params || {}) as {
                from?: unknown; relation?: unknown; to?: unknown; confidence?: unknown; importance?: unknown; evidence?: unknown; folder?: string
            }
            const targetSpace = resolveRelationshipGraphSpace(assignedSpaces, folder)
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

            const edge = getEntityGraphStore().upsertEdge({
                action: 'assert',
                from: fromEntity,
                relation: rel,
                to: toEntity,
                confidence: clampToolNumber(confidence, 0.9, 0.1, 1),
                importance: toImportanceValue(importance),
                evidence: typeof evidence === 'string' ? evidence.replace(/\s+/g, ' ').trim().slice(0, 280) : '',
            }, 'tool', `memory-space:${targetSpace.id}:relationship-assertions`)

            if (!edge) return { success: false, output: 'No relationship was created.' }
            return { success: true, output: `Relationship asserted:\n${formatEntityEdge(edge)}` }
        },
    }
}

/**
 * Create a `relationship_graph_delete` tool that lets the LLM remove an
 * incorrect relationship by ID or by exact relationship triple.
 */
export function makeRelationshipGraphDeleteTool(opts: MemoryToolOptions = {}): ToolDefinition {
    const assignedSpaces = opts.assignedSpaces || []
    const sourceIdPrefixes = relationshipGraphSourcePrefixes(assignedSpaces)
    return {
        name: 'relationship_graph_delete',
        description:
            'Delete an incorrect relationship from the relationship graph. ' +
            'Prefer edgeId from relationship_graph_search. If edgeId is unknown, provide from, relation, and to to delete an exact relationship triple.',
        parameters: {
            type: 'object',
            properties: {
                edgeId: { type: 'string', description: 'Relationship edge ID to delete. The short e:xxxxxxxx ID from relationship_graph_search is accepted.' },
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
            if (sourceIdPrefixes.length === 0) {
                return { success: false, output: 'No memory folder is selected for relationship graph access.' }
            }
            const { edgeId, from, relation, to } = (params || {}) as {
                edgeId?: string; from?: unknown; relation?: unknown; to?: unknown
            }
            const graph = getEntityGraphStore()

            if (edgeId?.trim()) {
                const resolvedEdgeId = resolveEntityGraphEdgeId(edgeId)
                if ('error' in resolvedEdgeId) return { success: false, output: resolvedEdgeId.error }
                const result = graph.deleteEdgeEvidenceBySourcePrefixes(resolvedEdgeId.id, sourceIdPrefixes)
                return result.edgeDeleted
                    ? { success: true, output: formatRelationshipGraphDeleteOutput(`Deleted relationship graph edge ${edgeId.trim()}.`, result.orphanedNodeIds.length) }
                    : { success: false, output: `No relationship found with id ${edgeId.trim()}.` }
            }

            const fromEntity = toEntityInput(from)
            if ('error' in fromEntity) return { success: false, output: 'Provide edgeId, or a valid from/relation/to triple to delete.' }
            const toEntity = toEntityInput(to)
            if ('error' in toEntity) return { success: false, output: 'Provide edgeId, or a valid from/relation/to triple to delete.' }
            const rel = cleanRelationName(relation)
            if (!rel) return { success: false, output: 'Provide edgeId, or a valid from/relation/to triple to delete.' }

            const result = graph.deleteMatchingEdgeBySourcePrefixes({
                action: 'delete',
                from: fromEntity,
                relation: rel,
                to: toEntity,
            }, sourceIdPrefixes)
            return result.edgeDeleted
                ? { success: true, output: formatRelationshipGraphDeleteOutput('Deleted 1 matching relationship graph edge.', result.orphanedNodeIds.length) }
                : { success: false, output: 'No matching relationship graph edge was found.' }
        },
    }
}

function formatRelationshipGraphDeleteOutput(message: string, orphanedNodeCount: number): string {
    if (orphanedNodeCount === 0) return message
    return `${message} Removed ${orphanedNodeCount} orphaned entit${orphanedNodeCount === 1 ? 'y' : 'ies'}.`
}

/**
 * Create a `memory_create` tool that lets the LLM store new memory entries.
 * Writes a Markdown file to the target folder and indexes it.
 */
export function makeMemoryCreateTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedSpaces = [] } = opts
    const getKnownSpaces = createKnownMemorySpacesLoader()
    return {
        name: 'memory_create',
        description:
            'Create a new memory entry with a title and content. ' +
            'Writes a Markdown file to the memory folder and indexes it for semantic retrieval. ' +
            'Use this to persistently store notes, findings, or any information worth remembering. ' +
            'If exactly one memory folder is selected, omit "folder" to write there; otherwise omitted "folder" writes to the default root memory folder. ' +
            'Provide "folder" to store in a specific selected folder.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'A short descriptive title for the memory entry (used as the file name, e.g. "project-notes" or "meeting-summary"). Will have .md appended automatically.' },
                content: { type: 'string', description: 'The Markdown text content to store in memory.' },
                folder: { type: 'string', description: 'Optional memory folder name, relative path (e.g. "projects/acme"), or ID. Omit to write to the only selected folder, or to the default root folder when no single selected folder is in scope.' }
            },
            required: ['title', 'content']
        },
        timeout: 120_000,
        execute: async (params: unknown, signal?: AbortSignal) => {
            const { title, content, folder } = params as { title: string; content: string; folder?: string }

            const resolved = await resolveTargetSpace(assignedSpaces, folder, undefined, getKnownSpaces)
            if ('error' in resolved) return { success: false, output: resolved.error }

            // Ensure .md extension
            const fileName = title.endsWith('.md') ? title : `${title}.md`
            const folderPath = getMemorySpaceFolderPath(resolved.spaceId)
            if (!folderPath) {
                return { success: false, output: `Memory folder "${resolved.spaceName}" has no folder configured. Cannot create memory.` }
            }

            const uniqueName = resolveUniqueFileName(folderPath, fileName)
            writeTextFile(folderPath, uniqueName, content)

            let indexed: Awaited<ReturnType<typeof reindexMemoryFile>>
            try {
                indexed = await reindexMemoryFile(resolved.spaceId, uniqueName, signal)
            } catch (err) {
                deleteFile(folderPath, uniqueName)
                throw new Error(`Memory creation failed; the unindexed source file was removed: ${(err as Error).message}`)
            }

            return {
                success: true,
                output: `Memory "${uniqueName}" created and indexed in "${resolved.spaceName}" (documentId=${indexed.documentId}, revision=${indexed.revision}, chunks=${indexed.chunkCount}).`
            }
        }
    }
}

function memoryMutationSchema(extra: Record<string, unknown> = {}, extraRequired: string[] = []): Record<string, unknown> {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            documentId: { type: 'string', description: 'Stable document ID returned by memory search, listing, retrieval, or creation.' },
            expectedRevision: { type: 'string', description: 'Exact revision returned by the most recent memory read. Prevents overwriting a newer edit.' },
            content: { type: 'string', description: 'Content to write.' },
            ...extra,
        },
        required: ['documentId', 'expectedRevision', 'content', ...extraRequired],
    }
}

async function prepareMemoryMutation(
    params: { documentId: string; expectedRevision: string },
    assignedSpaces: MemorySpaceRef[],
    getKnownSpaces: () => MemorySpaceRef[],
): Promise<{ resolved: ResolvedMemoryDocument; fileContent: string } | { error: string }> {
    const resolved = resolveMemoryDocumentById(params.documentId, assignedSpaces, getKnownSpaces)
    if ('error' in resolved) return resolved
    let fileContent: string
    try {
        fileContent = readTextFile(resolved.folderPath, resolved.fileName)
    } catch {
        return { error: `Could not read file "${resolved.fileName}" from memory folder.` }
    }
    const revisionError = verifyExpectedRevision(fileContent, params.expectedRevision)
    return revisionError ? { error: revisionError } : { resolved, fileContent }
}

async function runPreparedMemoryMutation(
    params: { documentId: string; expectedRevision: string },
    assignedSpaces: MemorySpaceRef[],
    getKnownSpaces: () => MemorySpaceRef[],
    signal: AbortSignal | undefined,
    operation: (prepared: { resolved: ResolvedMemoryDocument; fileContent: string }) => Promise<ToolResult>,
): Promise<ToolResult> {
    return withMemoryDocumentLock(params.documentId, signal, async () => {
        const prepared = await prepareMemoryMutation(params, assignedSpaces, getKnownSpaces)
        if ('error' in prepared) return { success: false, output: prepared.error }
        return operation(prepared)
    })
}

export function makeMemoryAppendTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedSpaces = [] } = opts
    const getKnownSpaces = createKnownMemorySpacesLoader()
    return {
        name: 'memory_append',
        description: 'Append content to an existing memory document without modifying its current text. Read the document first and pass its latest revision.',
        parameters: memoryMutationSchema(),
        timeout: 120_000,
        execute: async (params: unknown, signal?: AbortSignal) => {
            const input = params as { documentId: string; expectedRevision: string; content: string }
            return runPreparedMemoryMutation(input, assignedSpaces, getKnownSpaces, signal, async ({ resolved, fileContent }) => {
                const indexed = await commitMemoryMutation(
                    resolved,
                    fileContent,
                    fileContent.trimEnd() + '\n\n' + input.content.trim() + '\n',
                    signal,
                )
                return { success: true, output: `Content appended to "${resolved.fileName}" in "${resolved.spaceName}" and indexed (documentId=${indexed.documentId}, revision=${indexed.revision}, chunks=${indexed.chunkCount}).` }
            })
        },
    }
}

export function makeMemoryReplaceAllTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedSpaces = [] } = opts
    const getKnownSpaces = createKnownMemorySpacesLoader()
    return {
        name: 'memory_replace_all',
        description: 'Replace an entire existing memory document. Read it first and pass its latest revision to prevent overwriting concurrent changes.',
        parameters: memoryMutationSchema(),
        timeout: 120_000,
        execute: async (params: unknown, signal?: AbortSignal) => {
            const input = params as { documentId: string; expectedRevision: string; content: string }
            return runPreparedMemoryMutation(input, assignedSpaces, getKnownSpaces, signal, async ({ resolved, fileContent }) => {
                const indexed = await commitMemoryMutation(resolved, fileContent, input.content, signal)
                return { success: true, output: `Memory "${resolved.fileName}" fully replaced in "${resolved.spaceName}" and indexed (documentId=${indexed.documentId}, revision=${indexed.revision}, chunks=${indexed.chunkCount}).` }
            })
        },
    }
}

export function makeMemoryReplaceRangeTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedSpaces = [] } = opts
    const getKnownSpaces = createKnownMemorySpacesLoader()
    return {
        name: 'memory_replace_range',
        description: 'Replace a contiguous Part range in an existing memory document. First retrieve the current parts and pass the returned documentId and revision.',
        parameters: memoryMutationSchema({
            partStart: { type: 'integer', minimum: 1, description: 'First 1-based Part number to replace.' },
            partEnd: { type: 'integer', minimum: 1, description: 'Last 1-based Part number to replace, inclusive.' },
        }, ['partStart', 'partEnd']),
        timeout: 120_000,
        execute: async (params: unknown, signal?: AbortSignal) => {
            const input = params as { documentId: string; expectedRevision: string; content: string; partStart: number; partEnd: number }
            if (!Number.isInteger(input.partStart) || !Number.isInteger(input.partEnd) || input.partStart < 1 || input.partEnd < input.partStart) {
                return { success: false, output: 'partStart and partEnd must be valid 1-based integers with partEnd greater than or equal to partStart.' }
            }
            return runPreparedMemoryMutation(input, assignedSpaces, getKnownSpaces, signal, async ({ resolved, fileContent }) => {
                const startIndex = toPartIndex(input.partStart)!
                const endIndex = toPartIndex(input.partEnd)!
                const chunks = await getAgentMemory().getChunksByRange(
                    resolved.fileName,
                    startIndex,
                    endIndex,
                    buildScopeFilter([{ id: resolved.spaceId }]),
                )
                if (chunks.length !== endIndex - startIndex + 1) {
                    return { success: false, output: `The requested Part range is stale or incomplete. Retrieve "${resolved.fileName}" again and retry.` }
                }
                const replaced = replaceChunkRangeInText(fileContent, chunks, input.content)
                if ('error' in replaced) return { success: false, output: replaced.error }
                const indexed = await commitMemoryMutation(resolved, fileContent, replaced.content, signal)
                return { success: true, output: `Parts ${replaced.startIndex + 1}-${replaced.endIndex + 1} in "${resolved.fileName}" replaced and indexed (documentId=${indexed.documentId}, revision=${indexed.revision}, chunks=${indexed.chunkCount}).` }
            })
        },
    }
}

function memoryRemovalSchema(withRange: boolean): Record<string, unknown> {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            documentId: { type: 'string', description: 'Stable document ID returned by a current memory read.' },
            expectedRevision: { type: 'string', description: 'Exact revision returned by the most recent memory read.' },
            ...(withRange ? {
                partStart: { type: 'integer', minimum: 1, description: 'First 1-based Part number to remove.' },
                partEnd: { type: 'integer', minimum: 1, description: 'Last 1-based Part number to remove, inclusive.' },
            } : {}),
        },
        required: withRange
            ? ['documentId', 'expectedRevision', 'partStart', 'partEnd']
            : ['documentId', 'expectedRevision'],
    }
}

export function makeMemoryRemoveAllTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedSpaces = [] } = opts
    const getKnownSpaces = createKnownMemorySpacesLoader()
    return {
        name: 'memory_remove_all',
        description: 'Forget an entire memory document. Read it first and pass its latest revision. This moves the source to revisions and removes its retrieval and graph indexes.',
        parameters: memoryRemovalSchema(false),
        timeout: 30_000,
        execute: async (params: unknown, signal?: AbortSignal) => {
            const input = params as { documentId: string; expectedRevision: string }
            return runPreparedMemoryMutation(input, assignedSpaces, getKnownSpaces, signal, async ({ resolved, fileContent }) => {
                const removed = await commitMemoryRemoval(resolved, fileContent)
                return { success: true, output: `Memory "${resolved.fileName}" forgotten from "${resolved.spaceName}" (${removed.deletedChunks} indexed chunks and ${removed.deletedEdges} graph edges removed).` }
            })
        },
    }
}

export function makeMemoryRemoveRangeTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedSpaces = [] } = opts
    const getKnownSpaces = createKnownMemorySpacesLoader()
    return {
        name: 'memory_remove_range',
        description: 'Forget a contiguous Part range from a memory document. Retrieve the current parts first and pass the returned documentId and revision.',
        parameters: memoryRemovalSchema(true),
        timeout: 120_000,
        execute: async (params: unknown, signal?: AbortSignal) => {
            const input = params as { documentId: string; expectedRevision: string; partStart: number; partEnd: number }
            if (!Number.isInteger(input.partStart) || !Number.isInteger(input.partEnd) || input.partStart < 1 || input.partEnd < input.partStart) {
                return { success: false, output: 'partStart and partEnd must be valid 1-based integers with partEnd greater than or equal to partStart.' }
            }
            return runPreparedMemoryMutation(input, assignedSpaces, getKnownSpaces, signal, async ({ resolved, fileContent }) => {
                const startIndex = toPartIndex(input.partStart)!
                const endIndex = toPartIndex(input.partEnd)!
                const chunks = await getAgentMemory().getChunksByRange(
                    resolved.fileName,
                    startIndex,
                    endIndex,
                    buildScopeFilter([{ id: resolved.spaceId }]),
                )
                if (chunks.length !== endIndex - startIndex + 1) {
                    return { success: false, output: `The requested Part range is stale or incomplete. Retrieve "${resolved.fileName}" again and retry.` }
                }
                const removed = removeChunkRangeFromText(fileContent, chunks)
                if ('error' in removed) return { success: false, output: removed.error }
                if (!removed.content.trim()) {
                    const deleted = await commitMemoryRemoval(resolved, fileContent)
                    return { success: true, output: `Parts ${input.partStart}-${input.partEnd} removed; the empty memory was forgotten (${deleted.deletedChunks} indexed chunks and ${deleted.deletedEdges} graph edges removed).` }
                }
                const indexed = await commitMemoryMutation(resolved, fileContent, removed.content, signal)
                return { success: true, output: `Parts ${input.partStart}-${input.partEnd} removed and indexed (documentId=${indexed.documentId}, revision=${indexed.revision}, chunks=${indexed.chunkCount}).` }
            })
        },
    }
}
