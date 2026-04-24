import { getDb } from '../../db/database.js'
import type { ToolDefinition } from '../gateway/providers/base.provider.js'
import { getToolRegistry, type ToolNamespace } from './tool-registry.js'

// Re-export tool factories so existing imports keep working
export { makeNotificationTool, type NotificationToolOptions } from './builtin/notification.js'
export { makeGenerateTitleTool, type GenerateTitleToolOptions } from './builtin/generate-title.js'
export {
    makeMemoryListDocumentsTool,
    makeMemoryRetrieveChunksTool,
    makeMemorySearchTool,
    makeMemoryCreateTool,
    makeMemoryUpdateTool,
    type MemoryToolOptions,
} from './builtin/memory-tools.js'

// Import for internal hydration use
import { makeNotificationTool } from './builtin/notification.js'
import {
    makeMemoryListDocumentsTool,
    makeMemoryRetrieveChunksTool,
    makeMemorySearchTool,
    makeMemoryCreateTool,
    makeMemoryUpdateTool,
} from './builtin/memory-tools.js'

type BroadcastFn = (event: string, data: unknown) => void

// ─── Built-in tool names (selectable by agents) ────────────

export const BUILTIN_TOOL_NAMES = [
    'create_app_notification',
    'memory_list_documents',
    'memory_retrieve_chunks',
    'memory_semantic_search',
    'memory_create',
    'memory_update',
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

    registry.register(
        {
            name: 'create_app_notification',
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

    registry.register(
        {
            name: 'memory_list_documents',
            description: 'List memorised documents (source files) with their chunk counts. Paginated — max 100 per page.',
            parameters: { type: 'object', properties: { pageIndex: { type: 'number', description: 'Zero-based page index (default: 0).' } } },
            timeout: 15_000,
            execute: stub,
        },
        BUILTIN_NAMESPACE,
    )

    registry.register(
        {
            name: 'memory_retrieve_chunks',
            description: 'Retrieve additional chunks from a stored document by source file and chunk index range.',
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

    registry.register(
        {
            name: 'memory_semantic_search',
            description: 'Search through stored memories using a semantic query. Returns the most relevant memory chunks with their source and chunk index.',
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

    registry.register(
        {
            name: 'memory_create',
            description: '[Experimental] Create a new memory entry with a title and content. The content will be chunked and embedded for later semantic retrieval.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'A short descriptive title for the memory entry.' },
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

    registry.register(
        {
            name: 'memory_update',
            description: '[Experimental] Update an existing memory entry by replacing its content entirely.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'The exact title of the existing memory entry to update.' },
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
}

// ─── Hydration helpers ─────────────────────────────────────

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
        switch (t.originalName ?? t.name) {
            case 'create_app_notification':
                return { ...makeNotificationTool({ agentId: ctx.agentId || '', conversationId: ctx.conversationId, broadcast: ctx.broadcast }), name: t.name, registryKey: t.registryKey, originalName: t.originalName, namespaceId: t.namespaceId }
            case 'memory_list_documents':
                return { ...makeMemoryListDocumentsTool({ spaceFilter }), name: t.name, registryKey: t.registryKey, originalName: t.originalName, namespaceId: t.namespaceId }
            case 'memory_retrieve_chunks':
                return { ...makeMemoryRetrieveChunksTool({ spaceFilter }), name: t.name, registryKey: t.registryKey, originalName: t.originalName, namespaceId: t.namespaceId }
            case 'memory_semantic_search':
                return { ...makeMemorySearchTool({ spaceFilter }), name: t.name, registryKey: t.registryKey, originalName: t.originalName, namespaceId: t.namespaceId }
            case 'memory_create':
                return { ...makeMemoryCreateTool({ assignedSpaces }), name: t.name, registryKey: t.registryKey, originalName: t.originalName, namespaceId: t.namespaceId }
            case 'memory_update':
                return { ...makeMemoryUpdateTool({ spaceFilter, assignedSpaces }), name: t.name, registryKey: t.registryKey, originalName: t.originalName, namespaceId: t.namespaceId }
            default:
                return t
        }
    })
}
