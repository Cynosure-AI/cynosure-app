import { getDb } from "../../db/database.js";
import type { ToolDefinition } from "../gateway/providers/base.provider.js";
import { getToolRegistry, type ToolNamespace } from "./tool-registry.js";

// Re-export tool factories so existing imports keep working
export {
    makeNotificationTool,
    type NotificationToolOptions,
} from "./builtin/notification.js";
export {
    makeGenerateTitleTool,
    type GenerateTitleToolOptions,
} from "./builtin/generate-title.js";
export {
    makeMemoryListDocumentsTool,
    makeMemoryRetrieveChunksTool,
    makeMemorySearchTool,
    makeMemoryCreateTool,
    makeMemoryUpdateTool,
    type MemoryToolOptions,
} from "./builtin/memory-tools.js";
export {
    makeSearchAvailableMcpToolsTool,
    TOOL_SEARCH_TOOL_NAME,
    type SearchAvailableMcpToolsOptions,
} from "./builtin/search-available-mcp-tools.js";

// Import for internal hydration use
import { makeNotificationTool } from "./builtin/notification.js";
import {
    makeMemoryListDocumentsTool,
    makeMemoryRetrieveChunksTool,
    makeMemorySearchTool,
    makeMemoryCreateTool,
    makeMemoryUpdateTool,
} from "./builtin/memory-tools.js";

type BroadcastFn = (event: string, data: unknown) => void;

const BUILTIN_NAMESPACE: ToolNamespace = { id: "builtin", label: "Built-in" };

type BuiltInToolSpec = Pick<
    ToolDefinition,
    "name" | "description" | "parameters" | "timeout"
>;

// ─── Built-in tool names (selectable by agents) ────────────

const BUILTIN_TOOL_SPECS = [
    {
        name: "create_app_notification",
        description:
            "Create a notification for the user. Use this when you find something noteworthy — e.g. completed tasks, new findings, errors, or anything the user should be aware of.",
        parameters: {
            type: "object",
            properties: {
                title: {
                    type: "string",
                    description: "Short notification title (3-10 words)",
                },
                body: {
                    type: "string",
                    description: "Detailed notification body (1-3 sentences)",
                },
                severity: {
                    type: "string",
                    enum: ["info", "warning", "critical"],
                    description: "Notification severity level",
                },
            },
            required: ["title", "body"],
        },
        timeout: 5_000,
    },
    {
        name: "memory_list_documents",
        description:
            "List memorised documents (source files) with their chunk counts. Paginated — max 100 per page. Searches all assigned spaces, or all spaces when none are assigned.",
        parameters: {
            type: "object",
            properties: {
                pageIndex: {
                    type: "number",
                    description: "Zero-based page index (default: 0).",
                },
                space: {
                    type: "string",
                    description:
                        "Optional memory space name or ID to restrict the listing.",
                },
            },
        },
        timeout: 15_000,
    },
    {
        name: "memory_retrieve_chunks",
        description:
            "Retrieve additional chunks from a stored document by source file and chunk index range. Searches all assigned spaces, or all spaces when none are assigned; use space to disambiguate duplicate source files.",
        parameters: {
            type: "object",
            properties: {
                sourceFile: { type: "string", description: "The source file name." },
                minIndex: {
                    type: "number",
                    description: "Minimum chunk index (0-based).",
                },
                maxIndex: {
                    type: "number",
                    description: "Maximum chunk index (0-based, inclusive).",
                },
                space: {
                    type: "string",
                    description:
                        "Optional memory space name or ID. Use when the same source file exists in more than one space.",
                },
            },
            required: ["sourceFile", "minIndex", "maxIndex"],
        },
        timeout: 15_000,
    },
    {
        name: "memory_semantic_search",
        description:
            "Search through stored memories using a semantic query. Returns the most relevant memory chunks with their memory space, source, and chunk index. Searches all assigned spaces, or all spaces when none are assigned.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "A descriptive search query to find relevant memories.",
                },
                topK: {
                    type: "number",
                    description:
                        "Maximum number of results to return (default: 5, max: 10).",
                },
                space: {
                    type: "string",
                    description:
                        "Optional memory space name or ID to restrict the search.",
                },
            },
            required: ["query"],
        },
        timeout: 15_000,
    },
    {
        name: "memory_create",
        description:
            "[Experimental] Create a new memory entry with a title and content. The content will be chunked and embedded for later semantic retrieval.",
        parameters: {
            type: "object",
            properties: {
                title: {
                    type: "string",
                    description: "A short descriptive title for the memory entry.",
                },
                content: {
                    type: "string",
                    description: "The text content to store in memory.",
                },
                space: {
                    type: "string",
                    description:
                        "Target memory space name or ID. Required when multiple memory spaces are assigned, or when none are assigned and you need to choose an existing space.",
                },
            },
            required: ["title", "content"],
        },
        timeout: 30_000,
    },
    {
        name: "memory_update",
        description:
            "Update an existing memory entry. Auto-matches the title to find the entry; if multiple spaces contain the same title, space parameter is required. " +
            "By default, replaces all content. Use chunkStartIndex and chunkEndIndex to update only specific chunks.",
        parameters: {
            type: "object",
            properties: {
                title: {
                    type: "string",
                    description:
                        "The title (source file name) of the memory entry to update. Auto-matched across assigned spaces.",
                },
                content: {
                    type: "string",
                    description:
                        "The new text content. Replaces all content by default, or specific chunks if using chunkStartIndex/chunkEndIndex.",
                },
                space: {
                    type: "string",
                    description:
                        "Memory space name or ID. Required only when the title exists in multiple spaces; otherwise auto-selected.",
                },
                chunkStartIndex: {
                    type: "number",
                    description:
                        "Optional: zero-based index of the first chunk to replace. Omit to replace entire content.",
                },
                chunkEndIndex: {
                    type: "number",
                    description:
                        "Optional: zero-based index of the last chunk to replace (inclusive). Required if chunkStartIndex is provided.",
                },
            },
            required: ["title", "content"],
        },
        timeout: 30_000,
    },
] as const satisfies readonly BuiltInToolSpec[];

export const BUILTIN_TOOL_NAMES = BUILTIN_TOOL_SPECS.map((tool) => tool.name);

export type BuiltinToolName = (typeof BUILTIN_TOOL_SPECS)[number]["name"];

/**
 * Register stub versions of the built-in tools in the global ToolRegistry
 * so they appear in the tool-listing API / UI alongside MCP tools.
 * At execution time the stubs are replaced with context-aware implementations.
 */
export function registerBuiltInTools(): void {
    const registry = getToolRegistry();

    const stub = async () => ({
        success: false as const,
        output: "This built-in tool requires agent context.",
    });

    for (const tool of BUILTIN_TOOL_SPECS) {
        registry.register({ ...tool, execute: stub }, BUILTIN_NAMESPACE);
    }
}

// ─── Hydration helpers ─────────────────────────────────────

/**
 * Get the default memory space (if it exists).
 */
function getDefaultMemorySpace(): { id: string; name: string } | undefined {
    try {
        const db = getDb();
        return db
            .prepare('SELECT id, name FROM memory_spaces WHERE is_default = 1 ORDER BY created_at ASC LIMIT 1')
            .get() as { id: string; name: string } | undefined;
    } catch {
        /* DB not ready */
    }
    return undefined;
}

/**
 * Look up the memory spaces assigned to an agent, returning both ID and name.
 * If no spaces are assigned, returns the default space (if it exists).
 */
function getAssignedSpaces(agentId: string): { id: string; name: string }[] {
    try {
        const db = getDb();
        const assigned = db
            .prepare(
                `SELECT ms.id, ms.name FROM agent_memory_spaces ams
             JOIN memory_spaces ms ON ms.id = ams.space_id
             WHERE ams.agent_id = ?`,
            )
            .all(agentId) as { id: string; name: string }[];

        if (assigned.length > 0) return assigned;

        // If no spaces assigned, return the default space as fallback
        const defaultSpace = getDefaultMemorySpace();

        return defaultSpace ? [defaultSpace] : [];
    } catch {
        /* DB not ready */
    }
    return [];
}

/**
 * Get the default memory space when no agent context is available.
 */
function getDefaultMemorySpaces(): { id: string; name: string }[] {
    const defaultSpace = getDefaultMemorySpace();
    return defaultSpace ? [defaultSpace] : [];
}

/**
 * Build a SQL filter covering all assigned memory spaces for an agent.
 */
function buildMemorySpaceFilter(
    assignedSpaces: { id: string }[],
): string | undefined {
    if (assignedSpaces.length === 0) return undefined;
    const quoted = assignedSpaces
        .map((s) => `'${s.id.replace(/'/g, "''")}'`)
        .join(", ");
    return `spaceId IN (${quoted})`;
}

/**
 * Given an array of tool definitions (fetched from the registry), replace any
 * built-in stubs with real context-aware implementations.
 */
export function hydrateBuiltInTools(
    tools: ToolDefinition[],
    ctx: {
        agentId?: string;
        conversationId: string;
        broadcast: BroadcastFn;
        memorySpaceOverrides?: { id: string; name: string }[];
    },
): ToolDefinition[] {
    const assignedSpaces =
        ctx.memorySpaceOverrides ??
        (ctx.agentId ? getAssignedSpaces(ctx.agentId) : getDefaultMemorySpaces());
    const spaceFilter = buildMemorySpaceFilter(assignedSpaces);

    return tools.map((t) => {
        const metadata = {
            registryKey: t.registryKey,
            originalName: t.originalName,
            namespaceId: t.namespaceId,
            namespaceLabel: t.namespaceLabel,
            namespaceDescription: t.namespaceDescription,
        };

        switch (t.originalName ?? t.name) {
            case "create_app_notification":
                return {
                    ...makeNotificationTool({
                        agentId: ctx.agentId || "",
                        conversationId: ctx.conversationId,
                        broadcast: ctx.broadcast,
                    }),
                    name: t.name,
                    ...metadata,
                };
            case "memory_list_documents":
                return {
                    ...makeMemoryListDocumentsTool({ spaceFilter, assignedSpaces }),
                    name: t.name,
                    ...metadata,
                };
            case "memory_retrieve_chunks":
                return {
                    ...makeMemoryRetrieveChunksTool({ spaceFilter, assignedSpaces }),
                    name: t.name,
                    ...metadata,
                };
            case "memory_semantic_search":
                return {
                    ...makeMemorySearchTool({ spaceFilter, assignedSpaces }),
                    name: t.name,
                    ...metadata,
                };
            case "memory_create":
                return {
                    ...makeMemoryCreateTool({ assignedSpaces }),
                    name: t.name,
                    ...metadata,
                };
            case "memory_update":
                return {
                    ...makeMemoryUpdateTool({ assignedSpaces }),
                    name: t.name,
                    ...metadata,
                };
            default:
                return t;
        }
    });
}
