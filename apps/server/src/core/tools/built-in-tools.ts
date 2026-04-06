import { nanoid } from 'nanoid'
import { readFile } from 'fs/promises'
import { basename } from 'path'
import { getDb } from '../../db/database.js'
import type { ToolDefinition } from '../gateway/providers/base.provider.js'

import { getToolRegistry, type ToolNamespace } from './tool-registry.js'

type BroadcastFn = (event: string, data: unknown) => void

// ─── Built-in tool names (selectable by agents) ────────────

export const BUILTIN_TOOL_NAMES = [
    'create_notification',
    'memory_list_documents',
    'memory_retrieve_chunks',
    'memory_semantic_search',
    'memory_create',
    'memory_update',
    'memory_ingest_document',
] as const

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number]

const BUILTIN_NAMESPACE: ToolNamespace = { id: 'builtin', label: 'Built-in' }

/**
 * Register stub versions of the built-in tools in the global ToolRegistry
 * so they appear in the tool-listing API / UI alongside MCP tools.
 * At execution time the stubs are replaced with context-aware implementations.
 */
export function registerBuiltInTools(): void {
    const registry = getToolRegistry()

    const stub = async () => ({ success: false as const, output: 'This built-in tool requires agent context.' })

    // Notification stub
    registry.register(
        {
            name: 'create_notification',
            description:
                'Create a notification for the user. Use this when you find something noteworthy — e.g. completed tasks, new findings, errors, or anything the user should be aware of.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Short notification title (3-10 words)' },
                    body: { type: 'string', description: 'Detailed notification body (1-3 sentences)' },
                    severity: { type: 'string', enum: ['info', 'warning', 'critical'], description: 'Notification severity level' }
                },
                required: ['title', 'body']
            },
            timeout: 5_000,
            execute: stub,
        },
        BUILTIN_NAMESPACE,
    )

    // Memory list documents stub
    registry.register(
        {
            name: 'memory_list_documents',
            description:
                'List memorised documents (source files) with their chunk counts. Paginated — max 100 per page.',
            parameters: {
                type: 'object',
                properties: {
                    pageIndex: { type: 'number', description: 'Zero-based page index (default: 0).' },
                },
            },
            timeout: 15_000,
            execute: stub,
        },
        BUILTIN_NAMESPACE,
    )

    // Memory retrieve chunks stub
    registry.register(
        {
            name: 'memory_retrieve_chunks',
            description:
                'Retrieve additional chunks from a stored document by source file and chunk index range.',
            parameters: {
                type: 'object',
                properties: {
                    sourceFile: { type: 'string', description: 'The source file name.' },
                    minIndex: { type: 'number', description: 'Minimum chunk index (0-based).' },
                    maxIndex: { type: 'number', description: 'Maximum chunk index (0-based, inclusive).' }
                },
                required: ['sourceFile', 'minIndex', 'maxIndex']
            },
            timeout: 15_000,
            execute: stub,
        },
        BUILTIN_NAMESPACE,
    )

    // Memory semantic search stub
    registry.register(
        {
            name: 'memory_semantic_search',
            description:
                'Search through stored memories using a semantic query. ' +
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
            execute: stub,
        },
        BUILTIN_NAMESPACE,
    )

    // Memory create stub
    registry.register(
        {
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
            execute: stub,
        },
        BUILTIN_NAMESPACE,
    )

    // Memory update stub
    registry.register(
        {
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
            execute: stub,
        },
        BUILTIN_NAMESPACE,
    )

    // Memory ingest document stub
    registry.register(
        {
            name: 'memory_ingest_document',
            description:
                'Ingest a document from the local filesystem into memory. ' +
                'Reads the file at the given path, chunks it, and stores it for semantic retrieval. ' +
                'Supports text-based files (txt, md, csv, json, xml, html, log, etc.).',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Absolute path to the file on the local filesystem.' },
                    space: { type: 'string', description: 'Target memory space name or ID. Defaults to the assigned space when only one is available.' }
                },
                required: ['filePath']
            },
            timeout: 60_000,
            execute: stub,
        },
        BUILTIN_NAMESPACE,
    )
}

/**
 * Look up the memory spaces assigned to an agent, returning both ID and name.
 */
function getAssignedSpaces(agentId: string): { id: string; name: string }[] {
    try {
        const db = getDb()
        return db.prepare(
            `SELECT ms.id, ms.name FROM agent_memory_spaces ams
             JOIN memory_spaces ms ON ms.id = ams.space_id
             WHERE ams.agent_id = ?`
        ).all(agentId) as { id: string; name: string }[]
    } catch { /* DB not ready */ }
    return []
}

/**
 * Build a SQL filter covering all assigned memory spaces for an agent.
 * Returns undefined when there are no assigned spaces.
 */
function buildMemorySpaceFilter(assignedSpaces: { id: string }[]): string | undefined {
    if (assignedSpaces.length === 0) return undefined
    const quoted = assignedSpaces.map(s => `'${s.id.replace(/'/g, "''")}'`).join(', ')
    return `spaceId IN (${quoted})`
}

/**
 * Given an array of tool definitions (fetched from the registry), replace any
 * built-in stubs with real context-aware implementations.
 */
export function hydrateBuiltInTools(
    tools: ToolDefinition[],
    ctx: { agentId?: string; conversationId: string; broadcast: BroadcastFn; memorySpaceOverrides?: { id: string; name: string }[] },
): ToolDefinition[] {
    const assignedSpaces = ctx.memorySpaceOverrides ?? (ctx.agentId ? getAssignedSpaces(ctx.agentId) : [])
    const spaceFilter = buildMemorySpaceFilter(assignedSpaces)

    return tools.map((t) => {
        switch (t.name) {
            case 'create_notification':
                return makeNotificationTool({ agentId: ctx.agentId || '', conversationId: ctx.conversationId, broadcast: ctx.broadcast })
            case 'memory_list_documents':
                return makeMemoryListDocumentsTool({ spaceFilter })
            case 'memory_retrieve_chunks':
                return makeMemoryRetrieveChunksTool({ spaceFilter })
            case 'memory_semantic_search':
                return makeMemorySearchTool({ spaceFilter })
            case 'memory_create':
                return makeMemoryCreateTool({ assignedSpaces })
            case 'memory_update':
                return makeMemoryUpdateTool({ spaceFilter, assignedSpaces })
            case 'memory_ingest_document':
                return makeMemoryIngestDocumentTool({ assignedSpaces })
            default:
                return t
        }
    })
}

// ─── Notification tool ─────────────────────────────────────

export interface NotificationToolOptions {
    agentId: string
    conversationId: string
    broadcast: BroadcastFn
}

/**
 * Create a `create_notification` tool the LLM can call to alert the user.
 * Used during cron jobs and any autonomous agent run.
 */
export function makeNotificationTool(opts: NotificationToolOptions): ToolDefinition {
    const { agentId, conversationId, broadcast } = opts
    return {
        name: 'create_notification',
        description:
            'Create a notification for the user. Use this when you find something noteworthy — e.g. completed tasks, new findings, errors, or anything the user should be aware of.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Short notification title (3-10 words)' },
                body: { type: 'string', description: 'Detailed notification body (1-3 sentences)' },
                severity: { type: 'string', enum: ['info', 'warning', 'critical'], description: 'Notification severity level' }
            },
            required: ['title', 'body']
        },
        timeout: 5_000,
        execute: async (params: unknown) => {
            const { title, body, severity } = params as { title: string; body: string; severity?: string }
            const db = getDb()
            const id = nanoid()
            const now = Date.now()
            const sev = ['info', 'warning', 'critical'].includes(severity || '') ? severity! : 'info'

            db.prepare(
                `INSERT INTO notifications (id, agent_id, conversation_id, title, body, severity, read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
            ).run(id, agentId, conversationId, title, body, sev, now)

            broadcast('notification:created', { id, agentId, conversationId, title, body, severity: sev, read: false, createdAt: now })
            return { success: true, output: `Notification created: ${title}` }
        }
    }
}

// ─── Title generation tool ─────────────────────────────────

export interface GenerateTitleToolOptions {
    conversationId: string
    broadcast: BroadcastFn
}

/**
 * Create a `generate_title` tool the LLM calls with a short title.
 * Used as a structured-output mechanism for conversation title generation —
 * the LLM receives the conversation snippets and must call this tool with
 * the generated title, which is more token-efficient than free-form output.
 */
export function makeGenerateTitleTool(opts: GenerateTitleToolOptions): ToolDefinition {
    const { conversationId, broadcast } = opts
    return {
        name: 'generate_title',
        description: 'Set the conversation title. You MUST call this tool with a concise title.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Short chat title (3-6 words). No quotes, no punctuation at the end.' }
            },
            required: ['title']
        },
        timeout: 5_000,
        execute: async (params: unknown) => {
            const { title: rawTitle } = params as { title: string }
            const db = getDb()

            let title = rawTitle
                .replace(/^["'""''`]+|["'""''`]+$/g, '')
                .replace(/^Title:\s*/i, '')
                .replace(/[.!?:;,]+$/, '')
                .replace(/\s{2,}/g, ' ')
                .trim()
                .slice(0, 80)

            if (!title || title.split(/\s+/).length > 10 || /^(the user|this conversation|i |okay|let me)/i.test(title)) {
                return { success: false, output: 'Title rejected — too long or looks like reasoning.' }
            }

            db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), conversationId)
            broadcast('chat:title-updated', { conversationId, title })
            return { success: true, output: title }
        }
    }
}

// ─── Memory tools ──────────────────────────────────────────

import { getAgentMemory } from '../memory/agent-memory.js'
import { getRAGStore } from '../memory/rag.js'

export interface MemoryToolOptions {
    agentId?: string
    /** SQL filter covering all assigned memory spaces, e.g. `spaceId IN ('...', '...')`. */
    spaceFilter?: string
    /** Assigned memory spaces for write tools (name + id for disambiguation). */
    assignedSpaces?: { id: string; name: string }[]
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

// ─── Memory ingest document tool ───────────────────────────

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

/**
 * Create a `memory_ingest_document` tool that reads a file from disk
 * and ingests its content into a memory space.
 */
export function makeMemoryIngestDocumentTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedSpaces = [] } = opts
    return {
        name: 'memory_ingest_document',
        description:
            'Ingest a document from the local filesystem into memory. ' +
            'Reads the file at the given path, chunks it, and stores it for semantic retrieval. ' +
            'Supports text-based files (txt, md, csv, json, xml, html, log, etc.).',
        parameters: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Absolute path to the file on the local filesystem.' },
                space: { type: 'string', description: 'Target memory space name or ID. Defaults to the assigned space when only one is available.' }
            },
            required: ['filePath']
        },
        timeout: 60_000,
        execute: async (params: unknown) => {
            const { filePath: rawPath, space } = params as { filePath: string; space?: string }

            const resolved = resolveTargetSpace(assignedSpaces, space)
            if ('error' in resolved) return { success: false, output: resolved.error }

            // Read file
            let content: string
            try {
                const buf = await readFile(rawPath)
                if (buf.length > MAX_FILE_SIZE) {
                    return { success: false, output: `File is too large (${(buf.length / 1024 / 1024).toFixed(1)} MB). Maximum supported size is 10 MB.` }
                }
                content = buf.toString('utf-8')
            } catch (err) {
                return { success: false, output: `Failed to read file: ${(err as Error).message}` }
            }

            if (!content.trim()) {
                return { success: false, output: 'File is empty.' }
            }

            const fileName = basename(rawPath)
            const mem = getAgentMemory()
            const uniqueName = await mem.resolveUniqueSourceFile(fileName, resolved.spaceId)
            const chunks = await mem.store(content, uniqueName, resolved.spaceId)

            return { success: true, output: `Document "${uniqueName}" ingested (${chunks} chunk${chunks !== 1 ? 's' : ''} stored).` }
        }
    }
}

// ─── Memory list documents tool ────────────────────────────

/**
 * Create a `memory_list_documents` tool that returns all stored
 * document names with their chunk counts, so the LLM can discover
 * what's available before fetching specific chunks.
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
