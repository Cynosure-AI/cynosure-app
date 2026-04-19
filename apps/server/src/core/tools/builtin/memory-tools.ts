import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import { getAgentMemory } from '../../memory/agent-memory.js'
import { getRAGStore } from '../../memory/rag.js'

export interface MemoryToolOptions {
    /** SQL filter covering all assigned memory spaces, e.g. `spaceId IN ('...', '...')`. */
    spaceFilter?: string
    /** Assigned memory spaces for write tools (name + id for disambiguation). */
    assignedSpaces?: { id: string; name: string }[]
}

/**
 * Resolve the target space for a write operation.
 * Returns the spaceId on success, or an error string on failure.
 */
function resolveTargetSpace(assignedSpaces: { id: string; name: string }[], spaceParam?: string): { spaceId: string } | { error: string } {
    if (assignedSpaces.length === 0) {
        return { error: 'No memory spaces assigned to this agent. Ask the user to assign a memory space first.' }
    }
    if (assignedSpaces.length === 1) {
        return { spaceId: assignedSpaces[0].id }
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
    return { spaceId: match.id }
}

/**
 * Create a `memory_list_documents` tool that returns all stored
 * document names with their chunk counts.
 */
export function makeMemoryListDocumentsTool(opts: MemoryToolOptions): ToolDefinition {
    const { spaceFilter } = opts
    return {
        name: 'memory_list_documents',
        description:
            'List memorised documents (source files) stored in your knowledge base. ' +
            'Returns document names, chunk counts, and ingestion dates. Paginated — max 100 per page. ' +
            'Use this to discover what documents are available before using memory_retrieve_chunks or memory_semantic_search.',
        parameters: {
            type: 'object',
            properties: {
                pageIndex: { type: 'number', description: 'Zero-based page index (default: 0). Each page returns up to 100 documents.' },
            },
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            if (!spaceFilter) {
                return { success: false, output: 'No memory spaces assigned to this agent. Ask the user to assign a memory space first.' }
            }
            const { pageIndex } = (params || {}) as { pageIndex?: number }
            const mem = getAgentMemory()
            const allFiles = await mem.listSourceFiles(undefined, spaceFilter)

            if (allFiles.length === 0) {
                return { success: false, output: 'No documents stored in memory yet.' }
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

            const header = allFiles.length <= PAGE_SIZE
                ? `${allFiles.length} document${allFiles.length !== 1 ? 's' : ''} in memory:`
                : `Page ${page + 1}/${totalPages} (showing ${pageFiles.length} of ${allFiles.length} documents):`

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
    const { spaceFilter } = opts
    return {
        name: 'memory_retrieve_chunks',
        description:
            'Retrieve additional chunks from a stored document by source file and chunk index range. ' +
            'Very useful to gather more detail of a section(e.g. "Part 4 - 6" when Chunk 5 matches) ' +
            'Returns the text of each chunk in order.',
        parameters: {
            type: 'object',
            properties: {
                sourceFile: { type: 'string', description: 'The source file name exactly as shown in the memory context (e.g. "report.pdf", "notes.md").' },
                minIndex: { type: 'number', description: 'Minimum chunk index (0-based). Use the Part number minus 1.' },
                maxIndex: { type: 'number', description: 'Maximum chunk index (0-based, inclusive). Use the Part number minus 1.' }
            },
            required: ['sourceFile', 'minIndex', 'maxIndex']
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            if (!spaceFilter) {
                return { success: false, output: 'No memory spaces assigned to this agent. Ask the user to assign a memory space first.' }
            }
            const { sourceFile, minIndex, maxIndex } = params as { sourceFile: string; minIndex: number; maxIndex: number }
            const mem = getAgentMemory()

            const cappedMax = Math.min(maxIndex, minIndex + 19) // cap at 20 chunks per call
            const chunks = await mem.getChunksByRange(sourceFile, minIndex, cappedMax, spaceFilter)

            if (chunks.length === 0) {
                return { success: false, output: `No chunks found for "${sourceFile}" in range ${minIndex}-${cappedMax}.` }
            }

            const total = await mem.countChunks(sourceFile, spaceFilter)
            const formatted = chunks.map(c => `[Part ${c.chunkIndex + 1}/${total}]\n${c.text}`).join('\n\n---\n\n')
            return { success: true, output: formatted }
        }
    }
}

/**
 * Create a `memory_semantic_search` tool that lets the LLM run
 * a new semantic search query against stored memories.
 */
export function makeMemorySearchTool(opts: MemoryToolOptions): ToolDefinition {
    const { spaceFilter } = opts
    return {
        name: 'memory_semantic_search',
        description:
            'Search through stored RAG memories using a semantic query. ' +
            'Use this to get a rough starting point for memories, which can then be refined or expanded using other tools. ' +
            'Returns the most relevant memory chunks with their source and chunk index.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'A descriptive search query to find relevant memories.' },
                topK: { type: 'number', description: 'Maximum number of results to return (default: 5, max: 10).' }
            },
            required: ['query']
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            if (!spaceFilter) {
                return { success: false, output: 'No memory spaces assigned to this agent. Ask the user to assign a memory space first.' }
            }
            const { query, topK } = params as { query: string; topK?: number }
            const mem = getAgentMemory()

            const k = Math.min(topK ?? 5, 10)
            const results = await mem.recall(query, k, spaceFilter)

            if (results.length === 0) {
                return { success: false, output: 'No relevant memories found for this query.' }
            }

            console.log(`[memory_semantic_search] Found ${results.length} results for query "${query.slice(0, 60)}" (topK=${k})`)

            // Enrich with total chunks per source
            const uniqueSources = [...new Set(results.filter(r => r.sourceFile).map(r => r.sourceFile!))]
            const counts = await Promise.all(uniqueSources.map(sf =>
                mem.countChunks(sf, spaceFilter)
            ))
            const countMap = new Map(uniqueSources.map((sf, i) => [sf, counts[i]]))

            const formatted = results.map(r => {
                const parts: string[] = []
                if (r.sourceFile) {
                    const total = countMap.get(r.sourceFile)
                    if (r.chunkIndex != null && total) {
                        parts.push(`[${r.sourceFile} · Part ${r.chunkIndex + 1}/${total}]`)
                    } else {
                        parts.push(`[${r.sourceFile}]`)
                    }
                }
                parts.push(`(score: ${(r.score * 100).toFixed(1)}%)`)
                parts.push(r.text)
                return parts.join(' ')
            }).join('\n\n---\n\n')

            return { success: true, output: `Showing ${results.length} result${results.length !== 1 ? 's' : ''}:\n\n${formatted}` }
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
                space: { type: 'string', description: 'Target memory space name or ID. Required when multiple memory spaces are assigned.' }
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

            return { success: true, output: `Memory "${uniqueTitle}" created (${chunks} chunk${chunks !== 1 ? 's' : ''} stored).` }
        }
    }
}

/**
 * Create a `memory_update` tool that lets the LLM replace the content
 * of an existing memory entry (delete old chunks, re-ingest new content).
 */
export function makeMemoryUpdateTool(opts: MemoryToolOptions): ToolDefinition {
    const { spaceFilter, assignedSpaces = [] } = opts
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
                space: { type: 'string', description: 'Target memory space name or ID. Required when multiple memory spaces are assigned.' }
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

            // Check existence across all assigned spaces
            if (!spaceFilter) {
                return { success: false, output: 'No memory spaces assigned to this agent.' }
            }
            const existingCount = await mem.countChunks(title, spaceFilter)
            if (existingCount === 0) {
                return { success: false, output: `No memory entry found with title "${title}". Use memory_create to create a new entry.` }
            }

            // Delete old chunks within the target space
            const targetFilter = `spaceId = '${resolved.spaceId.replace(/'/g, "''")}'`
            const deleted = await rag.deleteBySource('permanent_memory', title, targetFilter)

            // Re-ingest with new content into the target space
            const chunks = await mem.store(content, title, resolved.spaceId)

            return { success: true, output: `Memory "${title}" updated (${deleted} old chunk${deleted !== 1 ? 's' : ''} removed, ${chunks} new chunk${chunks !== 1 ? 's' : ''} stored).` }
        }
    }
}
