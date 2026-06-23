import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import { getDb } from '../../../db/database.js'
import { getAgentMemory } from '../../memory/agent-memory.js'
import { buildMemorySpaceFilter as buildScopeFilter, getDefaultMemorySpace, getMemorySpaceFolderPath, type MemorySpaceRef } from '../../memory/memory-space-scope.js'
import { relativePathForFolder } from '../../memory/memory-space-folders.js'
import { readTextFile, writeTextFile, fileExists, backupToRevisions, resolveUniqueFileName } from '../../memory/memory-file-manager.js'
import { getEntityGraphStore, type EntityEdge, type EntityNode, type EntityType } from '../../memory/entity-graph.js'
import { deleteMemoryGraphSource } from '../../memory/memory-entity-indexer.js'
import { cancelMemoryIndexJobsForFile, startMemoryIndexJob } from '../../memory/memory-index-jobs.js'

function abortPendingMemoryIndexJobs(spaceId: string, fileName: string): void {
    cancelMemoryIndexJobsForFile(spaceId, fileName)
}

function clearMemoryGraphSource(spaceId: string, fileName: string): void {
    deleteMemoryGraphSource(spaceId, fileName)
}

function scheduleMemoryReindexJob(
    spaceId: string,
    fileName: string,
): void {
    const folderPath = getMemorySpaceFolderPath(spaceId)
    cancelMemoryIndexJobsForFile(spaceId, fileName)
    startMemoryIndexJob({
        kind: 'reindex',
        spaceId,
        fileName,
        replaceExisting: true,
        run: async (signal) => {
            if (!folderPath) throw new Error('Memory folder has no folder configured')
            const result = await getAgentMemory().reindexFile(folderPath, fileName, spaceId, { signal })
            return { success: true, chunksStored: result.chunkCount, fileName: result.fileName }
        },
    })
}

export const MEMORY_READ_TOOL_NAMES = [
    'memory_list_documents',
    'memory_retrieve_chunks',
    'memory_semantic_search',
] as const

export const MEMORY_WRITE_TOOL_NAMES = [
    'memory_create',
    'memory_update',
    'memory_remove',
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

export type MemoryReadToolName = (typeof MEMORY_READ_TOOL_NAMES)[number]
export type MemoryWriteToolName = (typeof MEMORY_WRITE_TOOL_NAMES)[number]
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number]
export type RelationshipGraphToolName = (typeof RELATIONSHIP_GRAPH_TOOL_NAMES)[number]

export function isMemoryToolName(toolName: string): toolName is MemoryToolName {
    return (MEMORY_TOOL_NAMES as readonly string[]).includes(toolName)
}

export function isMemoryReadToolName(toolName: string): toolName is MemoryReadToolName {
    return (MEMORY_READ_TOOL_NAMES as readonly string[]).includes(toolName)
}

export function isRelationshipGraphToolName(toolName: string): toolName is RelationshipGraphToolName {
    return (RELATIONSHIP_GRAPH_TOOL_NAMES as readonly string[]).includes(toolName)
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

async function resolveExistingMemorySpace(
    assignedSpaces: MemorySpaceRef[],
    title: string,
    folderParam?: string,
    getKnownSpaces: () => MemorySpaceRef[] = getKnownMemorySpaces,
): Promise<{ spaceId: string; spaceName: string; fileName: string; indexedCount: number; existsOnDisk: boolean; folderPath?: string } | { error: string }> {
    const fileName = title.endsWith('.md') ? title : `${title}.md`
    const mem = getAgentMemory()

    const inspectSpace = async (space: MemorySpaceRef) => {
        const folderPath = getMemorySpaceFolderPath(space.id)
        const existsOnDisk = Boolean(folderPath && fileExists(folderPath, fileName))
        const indexedCount = await mem.countChunks(fileName, buildScopeFilter([{ id: space.id }]))
        return { space, folderPath, existsOnDisk, indexedCount }
    }

    if (folderParam?.trim()) {
        const wanted = folderParam.trim()
        const candidates = assignedSpaces.length > 0 ? assignedSpaces : getKnownSpaces()
        const match = findSpaceByIdOrName(candidates, wanted)
        if (!match) {
            const scopeLabel = assignedSpaces.length > 0 ? 'selected memory folders' : 'existing memory folders'
            return { error: `Memory folder "${wanted}" not found in ${scopeLabel}.\n${formatSpaces(candidates.length > 0 ? candidates : getKnownSpaces())}` }
        }

        const inspected = await inspectSpace(match)
        if (inspected.indexedCount === 0 && !inspected.existsOnDisk) {
            return { error: `No memory entry found with title "${title}" in "${match.name}".` }
        }

        return {
            spaceId: match.id,
            spaceName: match.name,
            fileName,
            indexedCount: inspected.indexedCount,
            existsOnDisk: inspected.existsOnDisk,
            folderPath: inspected.folderPath,
        }
    }

    const candidates = assignedSpaces.length > 0 ? assignedSpaces : getKnownSpaces()
    const inspected = await Promise.all(candidates.map(inspectSpace))
    const matches = inspected.filter((item) => item.indexedCount > 0 || item.existsOnDisk)

    if (matches.length === 1) {
        const match = matches[0]
        return {
            spaceId: match.space.id,
            spaceName: match.space.name,
            fileName,
            indexedCount: match.indexedCount,
            existsOnDisk: match.existsOnDisk,
            folderPath: match.folderPath,
        }
    }

    if (matches.length > 1) {
        const listing = matches.map(({ space }) => `  - "${space.name}" (id: ${space.id})`).join('\n')
        return { error: `Memory entry "${title}" exists in multiple folders. Please specify which to forget using the 'folder' parameter:\n${listing}` }
    }

    return { error: `No memory entry found with title "${title}". Use memory_list_documents or memory_semantic_search to find the exact memory first.` }
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
        description:
            'List memorised documents (source files) stored in your knowledge base. ' +
            'Returns document names, chunk counts, and ingestion dates. Paginated — max 100 per page. ' +
            'Results are newest first. ' +
            'Use this to discover what documents are available before using memory_retrieve_chunks or memory_semantic_search. ' +
            'Selected memory folders are treated as one unified knowledge base for reading — use the optional "folder" parameter to filter to a specific folder. ' +
            makeScopeSummary(assignedSpaces),
        parameters: {
            type: 'object',
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

            const lines = pageFiles.map(f =>
                `- ${f.sourceFile} (${f.chunkCount} chunk${f.chunkCount !== 1 ? 's' : ''})`
            )

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
            return { success: true, output: formatted + capNote }
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
            const graphContext = seedNodes.length > 0
                ? graph.formatWalk(graph.walk(seedNodes.map((node) => node.id), 2, 24))
                : ''
            const graphSection = graphContext ? `\n\n---\n\n${graphContext}` : ''

            return { success: true, output: `Showing ${results.length} result${results.length !== 1 ? 's' : ''}${resolvedScope.space ? ` from "${resolvedScope.space.name}"` : ''}:\n\n${formatted}${graphSection}` }
        }
    }
}

/**
 * Create a `relationship_graph_search` tool that lets the LLM inspect known
 * relationships and their connected entities.
 */
export function makeRelationshipGraphSearchTool(): ToolDefinition {
    return {
        name: 'relationship_graph_search',
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
                const walk = graph.focusedWalk(seedNodes.map((node) => node.id), query, walkDepth, cappedLimit)
                const nodeLines = walk.nodes.slice(0, cappedLimit).map(formatEntityNode)
                const edgeLines = walk.edges.slice(0, cappedLimit).map(formatEntityEdge)
                const sections = [
                    `Matched ${seedNodes.length} seed node${seedNodes.length !== 1 ? 's' : ''}; focused ${walkDepth} hop${walkDepth !== 1 ? 's' : ''}.`,
                    nodeLines.length ? `Nodes:\n${nodeLines.join('\n')}` : '',
                    edgeLines.length ? `Relationships:\n${edgeLines.join('\n')}` : 'No relationships connected to the matched nodes.',
                ].filter(Boolean)
                return { success: true, output: sections.join('\n\n') }
            }

            const snapshot = graph.list(cappedLimit)
            if (snapshot.nodes.length === 0 && snapshot.edges.length === 0) {
                return { success: false, output: 'The relationship graph is empty.' }
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
export function makeRelationshipGraphAssertTool(): ToolDefinition {
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
            },
            required: ['from', 'relation', 'to'],
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            const { from, relation, to, confidence, importance, evidence } = (params || {}) as {
                from?: unknown; relation?: unknown; to?: unknown; confidence?: unknown; importance?: unknown; evidence?: unknown
            }
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
            }, 'tool', 'relationship_graph_assert')

            if (!edge) return { success: false, output: 'No relationship was created.' }
            return { success: true, output: `Relationship asserted:\n${formatEntityEdge(edge)}` }
        },
    }
}

/**
 * Create a `relationship_graph_delete` tool that lets the LLM remove an
 * incorrect relationship by ID or by exact relationship triple.
 */
export function makeRelationshipGraphDeleteTool(): ToolDefinition {
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
            const { edgeId, from, relation, to } = (params || {}) as {
                edgeId?: string; from?: unknown; relation?: unknown; to?: unknown
            }
            const graph = getEntityGraphStore()

            if (edgeId?.trim()) {
                const resolvedEdgeId = resolveEntityGraphEdgeId(edgeId)
                if ('error' in resolvedEdgeId) return { success: false, output: resolvedEdgeId.error }
                const result = graph.deleteEdge(resolvedEdgeId.id)
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

            const result = graph.deleteMatchingEdge({
                action: 'delete',
                from: fromEntity,
                relation: rel,
                to: toEntity,
            })
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
        timeout: 30_000,
        execute: async (params: unknown) => {
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

            scheduleMemoryReindexJob(resolved.spaceId, uniqueName)

            return {
                success: true,
                output: `Memory "${uniqueName}" created in "${resolved.spaceName}". Memory indexing is running in the background.`
            }
        }
    }
}

/**
 * Create a `memory_update` tool that lets the LLM update an existing memory file.
 * Supports full replacement or targeted replacement by indexed chunk range.
 */
export function makeMemoryUpdateTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedSpaces = [] } = opts
    const getKnownSpaces = createKnownMemorySpacesLoader()
    return {
        name: 'memory_update',
        description:
            'Update an existing memory file. Auto-matches the title to find the file; if multiple folders contain the same title, folder parameter is required. ' +
            'If exactly one memory folder is selected, omit "folder" to update there when the title is not found elsewhere in the selected scope. ' +
            'mode is required: "replace_all" replaces the whole file, "replace_range" replaces a Part range, and "append" adds content to the end without touching existing text. ' +
            'For partial updates, first inspect the relevant parts with memory_retrieve_chunks, then call with mode="replace_range" and partStart/partEnd. ' +
            'The replacement content should contain the complete desired text for that Part range.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'The title (file name without .md) of the memory entry to update.' },
                mode: {
                    type: 'string',
                    enum: ['replace_all', 'replace_range', 'append'],
                    description: '"replace_all" replaces the full file, "replace_range" replaces partStart through partEnd, and "append" adds content to the end of the file.',
                },
                content: { type: 'string', description: 'For replace_all: the full replacement text. For replace_range: the full replacement text for that Part range. For append: the text to add at the end.' },
                folder: { type: 'string', description: 'Memory folder name, relative path (e.g. "projects/acme"), or ID. Required only when the title exists in multiple folders; otherwise auto-selected, including the only selected folder.' },
                partStart: { type: 'number', description: 'Required only with mode="replace_range". First 1-based Part number to replace, as shown by memory_retrieve_chunks or semantic search.' },
                partEnd: { type: 'number', description: 'Required only with mode="replace_range". Last 1-based Part number to replace, inclusive.' },
            },
            required: ['title', 'mode', 'content']
        },
        timeout: 30_000,
        execute: async (params: unknown) => {
            const { title, mode: rawMode, operation, content, folder, partStart, partEnd, chunkStartIndex: legacyChunkStartIndex, chunkEndIndex: legacyChunkEndIndex, sectionHeading } = params as {
                title: string; mode?: string; operation?: string; content: string; folder?: string; partStart?: number; partEnd?: number; chunkStartIndex?: number; chunkEndIndex?: number; sectionHeading?: string
            }

            if (sectionHeading?.trim()) {
                return {
                    success: false,
                    output: 'Section-heading updates are no longer supported because memories may come from non-Markdown documents. Use memory_retrieve_chunks, then retry memory_update with mode="replace_range" and partStart/partEnd.',
                }
            }

            const mode = rawMode ?? (operation === 'append' ? 'append' : operation === 'set' && (legacyChunkStartIndex !== undefined || legacyChunkEndIndex !== undefined) ? 'replace_range' : operation === 'set' ? 'replace_all' : undefined)
            if (mode !== 'replace_all' && mode !== 'replace_range' && mode !== 'append') {
                return { success: false, output: 'mode is required and must be "replace_all", "replace_range", or "append".' }
            }

            if (mode === 'append' && (partStart !== undefined || partEnd !== undefined || legacyChunkStartIndex !== undefined || legacyChunkEndIndex !== undefined)) {
                return { success: false, output: 'partStart/partEnd only apply to mode="replace_range". Omit them for mode="append".' }
            }
            if (mode === 'replace_all' && (partStart !== undefined || partEnd !== undefined || legacyChunkStartIndex !== undefined || legacyChunkEndIndex !== undefined)) {
                return { success: false, output: 'partStart/partEnd only apply to mode="replace_range". Omit them for mode="replace_all".' }
            }

            const resolved = await resolveTargetSpace(assignedSpaces, folder, title, getKnownSpaces)
            if ('error' in resolved) return { success: false, output: resolved.error }

            const mem = getAgentMemory()
            const targetFilter = buildScopeFilter([{ id: resolved.spaceId }])
            const fileName = title.endsWith('.md') ? title : `${title}.md`
            const existingCount = await mem.countChunks(fileName, targetFilter)

            const folderPath = getMemorySpaceFolderPath(resolved.spaceId)
            if (!folderPath) {
                return { success: false, output: `Memory folder "${resolved.spaceName}" has no folder configured. Cannot update memory.` }
            }
            const existsOnDisk = fileExists(folderPath, fileName)

            if (existingCount === 0 && !existsOnDisk) {
                return { success: false, output: `No memory entry found with title "${title}" in "${resolved.spaceName}". Use memory_create to create a new entry.` }
            }

            if (mode === 'append') {
                if (!existsOnDisk) {
                    return { success: false, output: `Cannot append: file "${fileName}" was not found on disk.` }
                }

                let fileContent: string
                try {
                    fileContent = readTextFile(folderPath, fileName)
                } catch {
                    return { success: false, output: `Could not read file "${fileName}" from memory folder.` }
                }

                backupToRevisions(folderPath, fileName)
                writeTextFile(folderPath, fileName, fileContent.trimEnd() + '\n\n' + content.trim() + '\n')
                clearMemoryGraphSource(resolved.spaceId, fileName)
                scheduleMemoryReindexJob(resolved.spaceId, fileName)

                return {
                    success: true,
                    output: `Content appended to "${fileName}" in "${resolved.spaceName}". Memory indexing is running in the background.`
                }
            }

            if (mode === 'replace_all') {
                if (existsOnDisk) backupToRevisions(folderPath, fileName)
                writeTextFile(folderPath, fileName, content)
                clearMemoryGraphSource(resolved.spaceId, fileName)
                scheduleMemoryReindexJob(resolved.spaceId, fileName)

                return {
                    success: true,
                    output: `Memory "${fileName}" fully replaced in "${resolved.spaceName}". Memory indexing is running in the background.`
                }
            }

            const chunkStartIndex = partStart !== undefined ? toPartIndex(partStart) : legacyChunkStartIndex
            const chunkEndIndex = partEnd !== undefined ? toPartIndex(partEnd) : legacyChunkEndIndex
            if (!Number.isInteger(chunkStartIndex) || !Number.isInteger(chunkEndIndex)) {
                return { success: false, output: 'mode="replace_range" requires integer partStart and partEnd values.' }
            }
            if (chunkStartIndex! < 0 || chunkEndIndex! < chunkStartIndex!) {
                return { success: false, output: 'Invalid Part range. partEnd must be greater than or equal to partStart, and Part numbers start at 1.' }
            }
            if (!existsOnDisk) {
                return { success: false, output: `Part replacement requires the file "${fileName}" to exist on disk. Use mode="replace_all" instead.` }
            }

            let fileContent: string
            try {
                fileContent = readTextFile(folderPath, fileName)
            } catch {
                return { success: false, output: `Could not read file "${fileName}" from memory folder.` }
            }

            const chunks = await mem.getChunksByRange(fileName, chunkStartIndex!, chunkEndIndex!, targetFilter)
            if (chunks.length === 0) {
                return {
                    success: false,
                    output: `No parts found for "${fileName}" in Part range ${chunkStartIndex! + 1}-${chunkEndIndex! + 1}. Retrieve the current parts and retry with a valid range, or use mode="append" to add new content at the end.`,
                }
            }

            const replaced = replaceChunkRangeInText(fileContent, chunks, content)
            if ('error' in replaced) return { success: false, output: replaced.error }

            backupToRevisions(folderPath, fileName)
            writeTextFile(folderPath, fileName, replaced.content)
            clearMemoryGraphSource(resolved.spaceId, fileName)
            scheduleMemoryReindexJob(resolved.spaceId, fileName)

            return {
                success: true,
                output: `Parts ${replaced.startIndex + 1}-${replaced.endIndex + 1} in "${fileName}" updated in "${resolved.spaceName}". Memory indexing is running in the background.`
            }
        }
    }
}

/**
 * Create a `memory_remove` tool that lets the LLM remove obsolete memory.
 * Supports full source-file removal or targeted removal by indexed chunk range.
 */
export function makeForgetMemoryTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedSpaces = [] } = opts
    const getKnownSpaces = createKnownMemorySpacesLoader()
    return {
        name: 'memory_remove',
        description:
            'Remove an obsolete or incorrect memory entry. Auto-matches the title to find the file; if multiple folders contain the same title, folder parameter is required. ' +
            'By default, forgets the whole memory by moving the source file to revisions and deleting its indexed chunks. ' +
            'To forget only part of a memory, first inspect the relevant parts with memory_retrieve_chunks, then provide partStart and partEnd. ' +
            'Use this only when information is no longer relevant, should no longer be remembered, or conflicts with newer information.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'The title (file name without .md) of the memory entry to remove.' },
                folder: { type: 'string', description: 'Memory folder name, relative path (e.g. "projects/acme"), or ID. Required only when the title exists in multiple folders.' },
                partStart: { type: 'number', description: 'Optional first 1-based Part number to forget, as shown by memory_retrieve_chunks or semantic search.' },
                partEnd: { type: 'number', description: 'Optional last 1-based Part number to forget, inclusive. Required when partStart is provided.' },
            },
            required: ['title']
        },
        timeout: 30_000,
        execute: async (params: unknown) => {
            const { title, folder, partStart, partEnd, chunkStartIndex: legacyChunkStartIndex, chunkEndIndex: legacyChunkEndIndex } = params as {
                title: string; folder?: string; partStart?: number; partEnd?: number; chunkStartIndex?: number; chunkEndIndex?: number
            }
            if (!title?.trim()) return { success: false, output: 'Title is required.' }

            const resolved = await resolveExistingMemorySpace(assignedSpaces, title.trim(), folder, getKnownSpaces)
            if ('error' in resolved) return { success: false, output: resolved.error }

            const mem = getAgentMemory()
            const chunkStartIndex = partStart !== undefined ? toPartIndex(partStart) : legacyChunkStartIndex
            const chunkEndIndex = partEnd !== undefined ? toPartIndex(partEnd) : legacyChunkEndIndex
            const hasChunkRange = chunkStartIndex !== undefined || chunkEndIndex !== undefined

            if (hasChunkRange) {
                if (!Number.isInteger(chunkStartIndex) || !Number.isInteger(chunkEndIndex)) {
                    return { success: false, output: 'Partial memory removal requires integer partStart and partEnd values.' }
                }
                if (chunkStartIndex! < 0 || chunkEndIndex! < chunkStartIndex!) {
                    return { success: false, output: 'Invalid Part range. partEnd must be greater than or equal to partStart, and Part numbers start at 1.' }
                }
                if (!resolved.folderPath || !resolved.existsOnDisk) {
                    return { success: false, output: `Part removal requires the file "${resolved.fileName}" to exist on disk.` }
                }

                let fileContent: string
                try {
                    fileContent = readTextFile(resolved.folderPath, resolved.fileName)
                } catch {
                    return { success: false, output: `Could not read file "${resolved.fileName}" from memory folder.` }
                }

                const targetFilter = buildScopeFilter([{ id: resolved.spaceId }])
                const chunks = await mem.getChunksByRange(resolved.fileName, chunkStartIndex!, chunkEndIndex!, targetFilter)
                const expectedCount = chunkEndIndex! - chunkStartIndex! + 1
                if (chunks.length !== expectedCount) {
                    return {
                        success: false,
                        output: `Found ${chunks.length}/${expectedCount} parts for "${resolved.fileName}" in Part range ${chunkStartIndex! + 1}-${chunkEndIndex! + 1}. Retrieve the current parts and retry with a valid range.`,
                    }
                }

                const removed = removeChunkRangeFromText(fileContent, chunks)
                if ('error' in removed) return { success: false, output: removed.error }

                backupToRevisions(resolved.folderPath, resolved.fileName)

                if (!removed.content.trim()) {
                    abortPendingMemoryIndexJobs(resolved.spaceId, resolved.fileName)
                    const deleted = await mem.deleteSourceFile(resolved.fileName, resolved.spaceId)
                    // Remove all entity graph edges sourced from this memory file
                    const { edgesDeleted } = deleteMemoryGraphSource(resolved.spaceId, resolved.fileName)
                    return {
                        success: true,
                        output: `Parts ${removed.startIndex + 1}-${removed.endIndex + 1} removed; "${resolved.fileName}" is now empty and was forgotten from "${resolved.spaceName}" (${deleted} indexed chunk${deleted !== 1 ? 's' : ''} deleted, ${edgesDeleted} graph edge${edgesDeleted !== 1 ? 's' : ''} removed).`
                    }
                }

                writeTextFile(resolved.folderPath, resolved.fileName, removed.content)
                clearMemoryGraphSource(resolved.spaceId, resolved.fileName)

                scheduleMemoryReindexJob(resolved.spaceId, resolved.fileName)

                return {
                    success: true,
                    output: `Parts ${removed.startIndex + 1}-${removed.endIndex + 1} removed from "${resolved.fileName}" in "${resolved.spaceName}". Memory indexing is running in the background.`
                }
            }

            if (resolved.folderPath && resolved.existsOnDisk) {
                backupToRevisions(resolved.folderPath, resolved.fileName)
            }

            const deleted = await mem.deleteSourceFile(resolved.fileName, resolved.spaceId)
            // Remove all entity graph edges sourced from this memory file
            abortPendingMemoryIndexJobs(resolved.spaceId, resolved.fileName)
            const { edgesDeleted } = deleteMemoryGraphSource(resolved.spaceId, resolved.fileName)
            return {
                success: true,
                output: `Memory "${resolved.fileName}" forgotten from "${resolved.spaceName}" (${deleted} indexed chunk${deleted !== 1 ? 's' : ''} deleted, ${edgesDeleted} graph edge${edgesDeleted !== 1 ? 's' : ''} removed).`
            }
        }
    }
}
