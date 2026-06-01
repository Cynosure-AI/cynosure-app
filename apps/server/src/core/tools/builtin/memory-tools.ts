import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import { getDb } from '../../../db/database.js'
import { getAgentMemory } from '../../memory/agent-memory.js'
import { buildMemorySpaceFilter as buildScopeFilter, getDefaultMemorySpace, getMemorySpaceFolderPath, type MemorySpaceRef } from '../../memory/memory-space-scope.js'
import { relativePathForFolder } from '../../memory/memory-space-folders.js'
import { readTextFile, writeTextFile, fileExists, backupToRevisions } from '../../memory/memory-file-manager.js'

export const MEMORY_READ_TOOL_NAMES = [
    'memory_list_documents',
    'memory_retrieve_chunks',
    'memory_semantic_search',
] as const

export const MEMORY_WRITE_TOOL_NAMES = [
    'memory_create',
    'memory_update',
] as const

export const MEMORY_TOOL_NAMES = [
    ...MEMORY_READ_TOOL_NAMES,
    ...MEMORY_WRITE_TOOL_NAMES,
] as const

export type MemoryReadToolName = (typeof MEMORY_READ_TOOL_NAMES)[number]
export type MemoryWriteToolName = (typeof MEMORY_WRITE_TOOL_NAMES)[number]
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number]

export function isMemoryToolName(toolName: string): toolName is MemoryToolName {
    return (MEMORY_TOOL_NAMES as readonly string[]).includes(toolName)
}

export function isMemoryReadToolName(toolName: string): toolName is MemoryReadToolName {
    return (MEMORY_READ_TOOL_NAMES as readonly string[]).includes(toolName)
}

export interface MemoryToolOptions {
    /** SQL filter covering all selected memory folders, e.g. `spaceId IN ('...', '...')`. */
    spaceFilter?: string
    /** Selected memory folders for write tools and read disambiguation. */
    assignedSpaces?: MemorySpaceRef[]
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
        (!s.relativePath && normalized === 'default')
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
            'Use this to discover what documents are available before using memory_retrieve_chunks or memory_semantic_search. ' +
            'Selected memory folders are treated as one unified knowledge base for reading — use the optional "folder" parameter to filter to a specific folder. ' +
            makeScopeSummary(assignedSpaces),
        parameters: {
            type: 'object',
            properties: {
                pageIndex: { type: 'number', description: 'Zero-based page index (default: 0). Each page returns up to 100 documents.' },
                folder: { type: 'string', description: 'Optional memory folder name, relative path (e.g. "projects/acme"), or ID to restrict the listing. Without this, searches all selected folders.' },
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
                return { success: false, output: `No documents stored in ${resolvedScope.space ? `"${resolvedScope.space.name}"` : 'memory'} yet.` }
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
 * additional chunks from a document by source file name and index range.
 */
export function makeMemoryRetrieveChunksTool(opts: MemoryToolOptions): ToolDefinition {
    const { spaceFilter, assignedSpaces = [] } = opts
    const getKnownSpaces = createKnownMemorySpacesLoader()
    return {
        name: 'memory_retrieve_chunks',
        description:
            'Retrieve additional chunks from a stored document by source file and chunk index range. ' +
            'Very useful to gather more detail of a section(e.g. "Part 4 - 6" when Chunk 5 matches) ' +
            'Returns the text of each chunk in order. ' +
            makeScopeSummary(assignedSpaces),
        parameters: {
            type: 'object',
            properties: {
                sourceFile: { type: 'string', description: 'The source file name exactly as shown in the memory context (e.g. "report.pdf", "notes.md").' },
                minIndex: { type: 'number', description: 'Minimum chunk index (0-based). Use the Part number minus 1.' },
                maxIndex: { type: 'number', description: 'Maximum chunk index (0-based, inclusive). Use the Part number minus 1.' },
                folder: { type: 'string', description: 'Optional memory folder name, relative path (e.g. "projects/acme"), or ID. Use this when the same source file exists in more than one folder.' }
            },
            required: ['sourceFile', 'minIndex', 'maxIndex']
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            const { sourceFile, minIndex, maxIndex, folder } = params as { sourceFile: string; minIndex: number; maxIndex: number; folder?: string }
            const requestedFolder = folder
            const resolvedScope = resolveReadableSpaceFilter(assignedSpaces, spaceFilter, requestedFolder, getKnownSpaces)
            if ('error' in resolvedScope) return { success: false, output: resolvedScope.error }
            const mem = getAgentMemory()

            const cappedMax = Math.min(maxIndex, minIndex + 19) // cap at 20 chunks per call
            const chunks = await mem.getChunksByRange(sourceFile, minIndex, cappedMax, resolvedScope.filter)

            if (chunks.length === 0) {
                return { success: false, output: `No chunks found for "${sourceFile}" in range ${minIndex}-${cappedMax}.` }
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
            return { success: true, output: formatted }
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
                topK: { type: 'number', description: 'Maximum number of results to return (default: 5, max: 30).' },
                folder: { type: 'string', description: 'Optional memory folder name, relative path (e.g. "projects/acme"), or ID to restrict the search. Without this, searches all selected folders.' }
            },
            required: ['query']
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            const { query, topK, folder } = params as { query: string; topK?: number; folder?: string }
            const resolvedScope = resolveReadableSpaceFilter(assignedSpaces, spaceFilter, folder, getKnownSpaces)
            if ('error' in resolvedScope) return { success: false, output: resolvedScope.error }
            const mem = getAgentMemory()

            const k = Math.min(topK ?? 5, 30)
            const results = await mem.recall(query, k, resolvedScope.filter)

            if (results.length === 0) {
                return { success: false, output: `No relevant memories found for this query${resolvedScope.space ? ` in "${resolvedScope.space.name}"` : ''}.` }
            }

            console.log(`[memory_semantic_search] Found ${results.length} results for query "${query.slice(0, 60)}" (topK=${k})`)

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

            return { success: true, output: `Showing ${results.length} result${results.length !== 1 ? 's' : ''}${resolvedScope.space ? ` from "${resolvedScope.space.name}"` : ''}:\n\n${formatted}` }
        }
    }
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

            const mem = getAgentMemory()

            // Ensure .md extension
            const fileName = title.endsWith('.md') ? title : `${title}.md`

            const result = await mem.storeAsFile(content, fileName, resolved.spaceId)
            return {
                success: true,
                output: `Memory "${result.fileName}" created in "${resolved.spaceName}" (${result.chunkCount} chunk${result.chunkCount !== 1 ? 's' : ''} indexed).`
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
            'By default, replaces all content and re-indexes the file. ' +
            'For partial updates, first inspect the relevant chunks with memory_retrieve_chunks, then provide chunkStartIndex and chunkEndIndex. ' +
            'The replacement content should contain the complete desired text for that chunk range.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'The title (file name without .md) of the memory entry to update.' },
                content: { type: 'string', description: 'The new text content. Replaces all content by default, or the selected chunk range when chunkStartIndex/chunkEndIndex are provided.' },
                folder: { type: 'string', description: 'Memory folder name, relative path (e.g. "projects/acme"), or ID. Required only when the title exists in multiple folders; otherwise auto-selected, including the only selected folder.' },
                chunkStartIndex: { type: 'number', description: 'Optional zero-based first chunk index to replace. Use the chunk index shown by memory_retrieve_chunks or semantic search.' },
                chunkEndIndex: { type: 'number', description: 'Optional zero-based last chunk index to replace, inclusive. Required when chunkStartIndex is provided.' },
            },
            required: ['title', 'content']
        },
        timeout: 30_000,
        execute: async (params: unknown) => {
            const { title, content, folder, chunkStartIndex, chunkEndIndex, sectionHeading } = params as {
                title: string; content: string; folder?: string; chunkStartIndex?: number; chunkEndIndex?: number; sectionHeading?: string
            }

            if (sectionHeading?.trim()) {
                return {
                    success: false,
                    output: 'Section-heading updates are no longer supported because memories may come from non-Markdown documents. Use memory_retrieve_chunks, then retry memory_update with chunkStartIndex and chunkEndIndex.',
                }
            }

            const resolved = await resolveTargetSpace(assignedSpaces, folder, title, getKnownSpaces)
            if ('error' in resolved) return { success: false, output: resolved.error }

            const mem = getAgentMemory()
            const targetFilter = buildScopeFilter([{ id: resolved.spaceId }])
            const existingCount = await mem.countChunks(title.endsWith('.md') ? title : `${title}.md`, targetFilter)
            const fileName = title.endsWith('.md') ? title : `${title}.md`

            // Every memory must correlate to a file on disk
            const folderPath = getMemorySpaceFolderPath(resolved.spaceId)
            if (!folderPath) {
                return { success: false, output: `Memory folder "${resolved.spaceName}" has no folder configured. Cannot update memory.` }
            }
            const existsOnDisk = fileExists(folderPath, fileName)

            if (existingCount === 0 && !existsOnDisk) {
                return { success: false, output: `No memory entry found with title "${title}" in "${resolved.spaceName}". Use memory_create to create a new entry.` }
            }

            const hasChunkRange = chunkStartIndex !== undefined || chunkEndIndex !== undefined
            if (hasChunkRange) {
                if (!Number.isInteger(chunkStartIndex) || !Number.isInteger(chunkEndIndex)) {
                    return { success: false, output: 'Partial memory updates require integer chunkStartIndex and chunkEndIndex values.' }
                }
                if (chunkStartIndex! < 0 || chunkEndIndex! < chunkStartIndex!) {
                    return { success: false, output: 'Invalid chunk range. chunkEndIndex must be greater than or equal to chunkStartIndex.' }
                }

                if (!existsOnDisk) {
                    return { success: false, output: `Chunk replacement requires the file "${fileName}" to exist on disk. Use full content replacement instead.` }
                }

                let fileContent: string
                try {
                    fileContent = readTextFile(folderPath, fileName)
                } catch {
                    return { success: false, output: `Could not read file "${fileName}" from memory folder.` }
                }

                const chunks = await mem.getChunksByRange(fileName, chunkStartIndex!, chunkEndIndex!, targetFilter)
                const expectedCount = chunkEndIndex! - chunkStartIndex! + 1
                if (chunks.length !== expectedCount) {
                    return {
                        success: false,
                        output: `Found ${chunks.length}/${expectedCount} chunks for "${fileName}" in range ${chunkStartIndex}-${chunkEndIndex}. Retrieve the current chunks and retry with a valid range.`,
                    }
                }

                const replaced = replaceChunkRangeInText(fileContent, chunks, content)
                if ('error' in replaced) return { success: false, output: replaced.error }

                backupToRevisions(folderPath, fileName)
                writeTextFile(folderPath, fileName, replaced.content)

                const { chunkCount: indexedChunks } = await mem.reindexFile(folderPath, fileName, resolved.spaceId)
                return {
                    success: true,
                    output: `Chunks ${replaced.startIndex}-${replaced.endIndex} in "${fileName}" updated in "${resolved.spaceName}" (${indexedChunks} chunk${indexedChunks !== 1 ? 's' : ''} re-indexed).`
                }
            } else {
                // Full replacement — backup original (if it exists on disk) then write directly
                if (existsOnDisk) backupToRevisions(folderPath, fileName)
                writeTextFile(folderPath, fileName, content)
                const { chunkCount: chunks } = await mem.reindexFile(folderPath, fileName, resolved.spaceId)
                return {
                    success: true,
                    output: `Memory "${fileName}" fully updated in "${resolved.spaceName}" (${chunks} chunk${chunks !== 1 ? 's' : ''} re-indexed).`
                }
            }
        }
    }
}
