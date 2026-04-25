import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import { getDb } from '../../../db/database.js'
import { getAgentMemory } from '../../memory/agent-memory.js'
import { getRAGStore } from '../../memory/rag.js'

type MemorySpaceRef = { id: string; name: string }

export interface MemoryToolOptions {
    /** SQL filter covering all assigned memory spaces, e.g. `spaceId IN ('...', '...')`. */
    spaceFilter?: string
    /** Assigned memory spaces for write tools and read disambiguation. */
    assignedSpaces?: MemorySpaceRef[]
}

function sqlString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`
}

function getKnownMemorySpaces(): MemorySpaceRef[] {
    try {
        const db = getDb()
        return db
            .prepare('SELECT id, name FROM memory_spaces ORDER BY sort_order ASC, created_at DESC')
            .all() as MemorySpaceRef[]
    } catch {
        return []
    }
}

function formatSpaces(spaces: MemorySpaceRef[]): string {
    if (spaces.length === 0) return 'No memory spaces exist yet.'
    return spaces.map(s => `  - "${s.name}" (id: ${s.id})`).join('\n')
}

function makeScopeSummary(assignedSpaces: MemorySpaceRef[]): string {
    if (assignedSpaces.length === 0) return 'Scope: all memory spaces.'
    if (assignedSpaces.length === 1) return `Scope: "${assignedSpaces[0].name}" only.`
    return `Scope: assigned memory spaces only (${assignedSpaces.map(s => `"${s.name}"`).join(', ')}).`
}

function buildSpaceMap(...spaceGroups: MemorySpaceRef[][]): Map<string, string> {
    const map = new Map<string, string>()
    for (const group of spaceGroups) {
        for (const space of group) map.set(space.id, space.name)
    }
    return map
}

function resolveReadableSpaceFilter(
    assignedSpaces: MemorySpaceRef[],
    baseFilter?: string,
    spaceParam?: string
): { filter?: string; space?: MemorySpaceRef } | { error: string } {
    if (!spaceParam?.trim()) return { filter: baseFilter }

    const candidates = assignedSpaces.length > 0 ? assignedSpaces : getKnownMemorySpaces()
    const wanted = spaceParam.trim()
    const match = candidates.find(s => s.id === wanted || s.name.toLowerCase() === wanted.toLowerCase())
    if (!match) {
        const scopeLabel = assignedSpaces.length > 0 ? 'available assigned spaces' : 'existing memory spaces'
        return {
            error: `Memory space "${wanted}" was not found in ${scopeLabel}.\n${formatSpaces(candidates)}`
        }
    }

    return { filter: `spaceId = ${sqlString(match.id)}`, space: match }
}

/**
 * Resolve the target space for a write operation.
 * Returns the spaceId on success, or an error string on failure.
 */
function resolveTargetSpace(assignedSpaces: MemorySpaceRef[], spaceParam?: string): { spaceId: string; spaceName: string } | { error: string } {
    if (assignedSpaces.length === 0) {
        const existing = getKnownMemorySpaces()
        if (spaceParam?.trim()) {
            const wanted = spaceParam.trim()
            const match = existing.find(s => s.id === wanted || s.name.toLowerCase() === wanted.toLowerCase())
            if (match) return { spaceId: match.id, spaceName: match.name }
            return {
                error: `Memory space "${wanted}" does not exist.\nExisting memory spaces:\n${formatSpaces(existing)}`
            }
        }
        return {
            error:
                'No memory space is assigned for writes. Provide the target memory space using the "space" parameter, select one in the conversation, or assign one to the agent.\n' +
                `Existing memory spaces:\n${formatSpaces(existing)}`
        }
    }
    if (assignedSpaces.length === 1) {
        const only = assignedSpaces[0]
        if (!spaceParam || only.id === spaceParam || only.name.toLowerCase() === spaceParam.toLowerCase()) {
            return { spaceId: only.id, spaceName: only.name }
        }
        return {
            error: `Memory space "${spaceParam}" is not assigned here. Available space:\n${formatSpaces(assignedSpaces)}`
        }
    }
    // Multiple spaces — require explicit selection
    if (!spaceParam) {
        const listing = assignedSpaces.map(s => `  - "${s.name}" (id: ${s.id})`).join('\n')
        return { error: `Multiple memory spaces are assigned. Please specify which space to write to using the 'space' parameter.\nAvailable spaces:\n${listing}` }
    }
    // Match by ID or name (case-insensitive)
    const match = assignedSpaces.find(s => s.id === spaceParam || s.name.toLowerCase() === spaceParam.toLowerCase())
    if (!match) {
        const listing = assignedSpaces.map(s => `  - "${s.name}" (id: ${s.id})`).join('\n')
        return { error: `Memory space "${spaceParam}" not found among assigned spaces. Available spaces:\n${listing}` }
    }
    return { spaceId: match.id, spaceName: match.name }
}

/**
 * Create a `memory_list_documents` tool that returns all stored
 * document names with their chunk counts.
 */
export function makeMemoryListDocumentsTool(opts: MemoryToolOptions): ToolDefinition {
    const { spaceFilter, assignedSpaces = [] } = opts
    return {
        name: 'memory_list_documents',
        description:
            'List memorised documents (source files) stored in your knowledge base. ' +
            'Returns document names, chunk counts, and ingestion dates. Paginated — max 100 per page. ' +
            'Use this to discover what documents are available before using memory_retrieve_chunks or memory_semantic_search. ' +
            makeScopeSummary(assignedSpaces),
        parameters: {
            type: 'object',
            properties: {
                pageIndex: { type: 'number', description: 'Zero-based page index (default: 0). Each page returns up to 100 documents.' },
                space: { type: 'string', description: 'Optional memory space name or ID to restrict the listing. Without this, searches all assigned spaces, or all spaces when none are assigned.' },
            },
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            const { pageIndex, space } = (params || {}) as { pageIndex?: number; space?: string }
            const resolvedScope = resolveReadableSpaceFilter(assignedSpaces, spaceFilter, space)
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
                space: { type: 'string', description: 'Optional memory space name or ID. Use this when the same source file exists in more than one space.' }
            },
            required: ['sourceFile', 'minIndex', 'maxIndex']
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            const { sourceFile, minIndex, maxIndex, space } = params as { sourceFile: string; minIndex: number; maxIndex: number; space?: string }
            const resolvedScope = resolveReadableSpaceFilter(assignedSpaces, spaceFilter, space)
            if ('error' in resolvedScope) return { success: false, output: resolvedScope.error }
            const mem = getAgentMemory()

            const cappedMax = Math.min(maxIndex, minIndex + 19) // cap at 20 chunks per call
            const chunks = await mem.getChunksByRange(sourceFile, minIndex, cappedMax, resolvedScope.filter)

            if (chunks.length === 0) {
                return { success: false, output: `No chunks found for "${sourceFile}" in range ${minIndex}-${cappedMax}.` }
            }

            const distinctSpaces = [...new Set(chunks.map(c => c.spaceId).filter((id): id is string => Boolean(id)))]
            if (!space && distinctSpaces.length > 1) {
                const spaceMap = buildSpaceMap(assignedSpaces, getKnownMemorySpaces())
                const listing = distinctSpaces.map(id => `  - "${spaceMap.get(id) || id}" (id: ${id})`).join('\n')
                return {
                    success: false,
                    output: `Source file "${sourceFile}" exists in multiple memory spaces. Re-run with the 'space' parameter.\nMatching spaces:\n${listing}`
                }
            }

            const total = await mem.countChunks(sourceFile, resolvedScope.filter)
            const spaceMap = buildSpaceMap(assignedSpaces, getKnownMemorySpaces())
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
    return {
        name: 'memory_semantic_search',
        description:
            'Search through stored RAG memories using a semantic query. ' +
            'Use this to get a rough starting point for memories, which can then be refined or expanded using other tools. ' +
            'Returns the most relevant memory chunks with their source, memory space, and chunk index. ' +
            makeScopeSummary(assignedSpaces),
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'A descriptive search query to find relevant memories.' },
                topK: { type: 'number', description: 'Maximum number of results to return (default: 5, max: 10).' },
                space: { type: 'string', description: 'Optional memory space name or ID to restrict the search. Without this, searches all assigned spaces, or all spaces when none are assigned.' }
            },
            required: ['query']
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            const { query, topK, space } = params as { query: string; topK?: number; space?: string }
            const resolvedScope = resolveReadableSpaceFilter(assignedSpaces, spaceFilter, space)
            if ('error' in resolvedScope) return { success: false, output: resolvedScope.error }
            const mem = getAgentMemory()

            const k = Math.min(topK ?? 5, 10)
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
                const filter = sid ? `spaceId = ${sqlString(sid)}` : resolvedScope.filter
                return mem.countChunks(sf, filter)
            }))
            const countMap = new Map(uniqueSourceKeys.map((key, i) => [key, counts[i]]))
            const spaceMap = buildSpaceMap(assignedSpaces, getKnownMemorySpaces())

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
 */
export function makeMemoryCreateTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedSpaces = [] } = opts
    return {
        name: 'memory_create',
        description:
            '[Experimental] Create a new memory entry with a title and content. ' +
            'The content will be chunked and embedded for later semantic retrieval. ' +
            'Use this to persistently store notes, findings, or any information worth remembering.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'A short descriptive title for the memory entry (used as file name, e.g. "project-notes", "meeting-summary").' },
                content: { type: 'string', description: 'The text content to store in memory.' },
                space: { type: 'string', description: 'Target memory space name or ID. Required when multiple memory spaces are assigned, or when none are assigned and you need to choose an existing space.' }
            },
            required: ['title', 'content']
        },
        timeout: 30_000,
        execute: async (params: unknown) => {
            const { title, content, space } = params as { title: string; content: string; space?: string }

            const resolved = resolveTargetSpace(assignedSpaces, space)
            if ('error' in resolved) return { success: false, output: resolved.error }

            const mem = getAgentMemory()
            const uniqueTitle = await mem.resolveUniqueSourceFile(title, resolved.spaceId)
            const chunks = await mem.store(content, uniqueTitle, resolved.spaceId)

            return { success: true, output: `Memory "${uniqueTitle}" created in "${resolved.spaceName}" (${chunks} chunk${chunks !== 1 ? 's' : ''} stored).` }
        }
    }
}

/**
 * Create a `memory_update` tool that lets the LLM replace the content
 * of an existing memory entry (delete old chunks, re-ingest new content).
 */
export function makeMemoryUpdateTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedSpaces = [] } = opts
    return {
        name: 'memory_update',
        description:
            '[Experimental] Update an existing memory entry by replacing its content entirely. ' +
            'The old chunks are deleted and the new content is re-chunked and re-embedded. ' +
            'Use the exact title (source file name) of the memory entry you want to update.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'The exact title (source file name) of the existing memory entry to update.' },
                content: { type: 'string', description: 'The new text content that will replace the old content.' },
                space: { type: 'string', description: 'Target memory space name or ID. Required when multiple memory spaces are assigned, or when none are assigned and you need to choose an existing space.' }
            },
            required: ['title', 'content']
        },
        timeout: 30_000,
        execute: async (params: unknown) => {
            const { title, content, space } = params as { title: string; content: string; space?: string }

            const resolved = resolveTargetSpace(assignedSpaces, space)
            if ('error' in resolved) return { success: false, output: resolved.error }

            const mem = getAgentMemory()
            const rag = getRAGStore()

            // Check and replace only inside the resolved target space. If the
            // same title exists elsewhere, leave that other space untouched.
            const targetFilter = `spaceId = ${sqlString(resolved.spaceId)}`
            const existingCount = await mem.countChunks(title, targetFilter)
            if (existingCount === 0) {
                return { success: false, output: `No memory entry found with title "${title}" in "${resolved.spaceName}". Use memory_create to create a new entry.` }
            }

            // Delete old chunks within the target space
            const deleted = await rag.deleteBySource('permanent_memory', title, targetFilter)

            // Re-ingest with new content into the target space
            const chunks = await mem.store(content, title, resolved.spaceId)

            return { success: true, output: `Memory "${title}" updated in "${resolved.spaceName}" (${deleted} old chunk${deleted !== 1 ? 's' : ''} removed, ${chunks} new chunk${chunks !== 1 ? 's' : ''} stored).` }
        }
    }
}
