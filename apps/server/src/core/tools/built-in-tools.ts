import type { RegistryAwareToolDefinition, ToolDefinition } from "../gateway/providers/base.provider.js";
import type { ConversationExecutionConfig } from "@shared/types";
import {
    buildMemorySpaceFilter,
    getAssignedOrDefaultSpaces,
    getDefaultMemorySpace,
    type MemorySpaceRef,
} from "../memory/memory-space-scope.js";
import { getToolRegistry, type ToolNamespace } from "./tool-registry.js";
import { makeNotificationTool } from "./builtin/notification.js";
import { makeChannelNotificationTool } from "./builtin/channel-notification.js";
import { makeScheduleTools, SCHEDULE_TOOL_NAMES } from "./builtin/schedule-tools.js";
import {
    makeMemoryListDocumentsTool,
    makeMemoryRetrieveChunksTool,
    makeMemorySearchTool,
    makeMemoryCreateTool,
    makeMemoryAppendTool,
    makeMemoryReplaceRangeTool,
    makeMemoryReplaceAllTool,
    makeMemoryRemoveAllTool,
    makeMemoryRemoveRangeTool,
    makeKnowledgeSearchTool,
    makeKnowledgeAssertTool,
    makeKnowledgeDeleteTool,
    makeKnowledgeEntityMergeTool,
    MEMORY_READ_TOOL_NAMES,
    MEMORY_TOOL_NAMES,
    KNOWLEDGE_TOOL_NAMES,
} from "./builtin/memory-tools.js";
export {
    makeNotificationTool,
    makeChannelNotificationTool,
    makeMemoryListDocumentsTool,
    makeMemoryRetrieveChunksTool,
    makeMemorySearchTool,
    makeMemoryCreateTool,
    makeMemoryAppendTool,
    makeMemoryReplaceRangeTool,
    makeMemoryReplaceAllTool,
    makeMemoryRemoveAllTool,
    makeMemoryRemoveRangeTool,
    makeKnowledgeSearchTool,
    makeKnowledgeAssertTool,
    makeKnowledgeDeleteTool,
    makeKnowledgeEntityMergeTool,
    MEMORY_TOOL_NAMES,
    KNOWLEDGE_TOOL_NAMES,
    makeScheduleTools,
    SCHEDULE_TOOL_NAMES,
};
export type { NotificationToolOptions } from "./builtin/notification.js";
export type { ChannelNotificationToolOptions } from "./builtin/channel-notification.js";
export {
    MEMORY_READ_TOOL_NAMES,
    MEMORY_WRITE_TOOL_NAMES,
    isKnowledgeToolName,
    isKnowledgeReadToolName,
    isMemoryToolName,
    isMemoryReadToolName,
    type MemoryToolOptions,
} from "./builtin/memory-tools.js";
export {
    makeSearchAvailableMcpToolsTool,
    TOOL_SEARCH_TOOL_NAME,
    type SearchAvailableMcpToolsOptions,
} from "./builtin/expand-available-toolset.js";

type BroadcastFn = (event: string, data: unknown) => void;

export const BUILTIN_NAMESPACE_ID = "builtin";
export const BUILTIN_NAMESPACE_IDS = {
    memory: "builtin:memory",
    scheduling: "builtin:scheduling",
    notifications: "builtin:notifications",
    utility: "builtin:utility",
} as const;

export const BUILTIN_NAMESPACES = {
    memory: { id: BUILTIN_NAMESPACE_IDS.memory, label: "Built-In: Memory" },
    scheduling: { id: BUILTIN_NAMESPACE_IDS.scheduling, label: "Built-In: Scheduling" },
    notifications: { id: BUILTIN_NAMESPACE_IDS.notifications, label: "Built-In: Notifications" },
    utility: { id: BUILTIN_NAMESPACE_IDS.utility, label: "Built-In: Utility" },
} as const satisfies Record<string, ToolNamespace>;

type BuiltInToolSpec = Pick<
    ToolDefinition,
    "name" | "description" | "parameters" | "timeout" | "annotations" | "execution"
>;

// ─── Built-in tool names (selectable by agents) ────────────

interface BuiltInHydrationContext {
    agentId?: string;
    conversationId: string;
    broadcast: BroadcastFn;
    assignedSpaces: MemorySpaceRef[];
    spaceFilter?: string;
    scheduleExecutionConfig?: ConversationExecutionConfig;
}

const BUILTIN_TOOL_HYDRATORS = {
    create_app_notification: (ctx: BuiltInHydrationContext) => makeNotificationTool({
        agentId: ctx.agentId || "",
        conversationId: ctx.conversationId,
        broadcast: ctx.broadcast,
    }),
    notify_user_on_channel: (ctx: BuiltInHydrationContext) => makeChannelNotificationTool({
        agentId: ctx.agentId || "",
    }),
    schedule_create: (ctx: BuiltInHydrationContext) => makeScheduleTools({ agentId: ctx.agentId || "", executionConfig: ctx.scheduleExecutionConfig })[0],
    schedule_list: (ctx: BuiltInHydrationContext) => makeScheduleTools({ agentId: ctx.agentId || "", executionConfig: ctx.scheduleExecutionConfig })[1],
    schedule_update: (ctx: BuiltInHydrationContext) => makeScheduleTools({ agentId: ctx.agentId || "", executionConfig: ctx.scheduleExecutionConfig })[2],
    schedule_delete: (ctx: BuiltInHydrationContext) => makeScheduleTools({ agentId: ctx.agentId || "", executionConfig: ctx.scheduleExecutionConfig })[3],
    memory_list_documents: (ctx: BuiltInHydrationContext) => makeMemoryListDocumentsTool({
        spaceFilter: ctx.spaceFilter,
        assignedSpaces: ctx.assignedSpaces,
    }),
    memory_retrieve_chunks: (ctx: BuiltInHydrationContext) => makeMemoryRetrieveChunksTool({
        spaceFilter: ctx.spaceFilter,
        assignedSpaces: ctx.assignedSpaces,
    }),
    memory_semantic_search: (ctx: BuiltInHydrationContext) => makeMemorySearchTool({
        spaceFilter: ctx.spaceFilter,
        assignedSpaces: ctx.assignedSpaces,
    }),
    memory_create: (ctx: BuiltInHydrationContext) => makeMemoryCreateTool({
        assignedSpaces: ctx.assignedSpaces,
    }),
    memory_append: (ctx: BuiltInHydrationContext) => makeMemoryAppendTool({
        assignedSpaces: ctx.assignedSpaces,
    }),
    memory_replace_range: (ctx: BuiltInHydrationContext) => makeMemoryReplaceRangeTool({
        assignedSpaces: ctx.assignedSpaces,
    }),
    memory_replace_all: (ctx: BuiltInHydrationContext) => makeMemoryReplaceAllTool({
        assignedSpaces: ctx.assignedSpaces,
    }),
    memory_remove_all: (ctx: BuiltInHydrationContext) => makeMemoryRemoveAllTool({
        assignedSpaces: ctx.assignedSpaces,
    }),
    memory_remove_range: (ctx: BuiltInHydrationContext) => makeMemoryRemoveRangeTool({
        assignedSpaces: ctx.assignedSpaces,
    }),
    knowledge_search: (ctx: BuiltInHydrationContext) => makeKnowledgeSearchTool({ assignedSpaces: ctx.assignedSpaces }),
    knowledge_assert: (ctx: BuiltInHydrationContext) => makeKnowledgeAssertTool({ assignedSpaces: ctx.assignedSpaces }),
    knowledge_delete: (ctx: BuiltInHydrationContext) => makeKnowledgeDeleteTool({ assignedSpaces: ctx.assignedSpaces }),
    knowledge_entity_merge: (ctx: BuiltInHydrationContext) => makeKnowledgeEntityMergeTool({ assignedSpaces: ctx.assignedSpaces }),
} as const satisfies Record<string, (ctx: BuiltInHydrationContext) => ToolDefinition>;

export const BUILTIN_TOOL_NAMES = Object.keys(BUILTIN_TOOL_HYDRATORS);

export type BuiltinToolName = keyof typeof BUILTIN_TOOL_HYDRATORS;

export function getBuiltInNamespace(toolName: string): ToolNamespace {
    if (MEMORY_TOOL_NAMES.includes(toolName as never) || KNOWLEDGE_TOOL_NAMES.includes(toolName as never)) {
        return BUILTIN_NAMESPACES.memory;
    }
    if (SCHEDULE_TOOL_NAMES.includes(toolName as never)) return BUILTIN_NAMESPACES.scheduling;
    if (toolName === 'create_app_notification' || toolName === 'notify_user_on_channel') {
        return BUILTIN_NAMESPACES.notifications;
    }
    return BUILTIN_NAMESPACES.utility;
}

export function getBuiltInToolKey(toolName: string): string {
    return `${getBuiltInNamespace(toolName).id}::${toolName}`;
}

function getBuiltInToolSpecs(): BuiltInToolSpec[] {
    const specContext: BuiltInHydrationContext = {
        conversationId: "",
        broadcast: () => undefined,
        assignedSpaces: [],
    };

    return BUILTIN_TOOL_NAMES.map((name) => {
        const tool = BUILTIN_TOOL_HYDRATORS[name as BuiltinToolName](specContext);
        return {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            timeout: tool.timeout,
            annotations: tool.annotations,
            execution: tool.execution,
        };
    });
}

export function isBuiltInMemoryToolKey(toolKey: string): boolean {
    return MEMORY_TOOL_NAMES.some((toolName) => toolKey === getBuiltInToolKey(toolName));
}

export function getBuiltInMemoryToolKeys(): string[] {
    return [...MEMORY_TOOL_NAMES, ...KNOWLEDGE_TOOL_NAMES].map(getBuiltInToolKey);
}

export function getBuiltInMemoryReadToolKeys(): string[] {
    return [...MEMORY_READ_TOOL_NAMES, 'knowledge_search']
        .map(getBuiltInToolKey);
}

export function isBuiltInKnowledgeToolKey(toolKey: string): boolean {
    return KNOWLEDGE_TOOL_NAMES.some((toolName) => toolKey === getBuiltInToolKey(toolName));
}

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

    for (const tool of getBuiltInToolSpecs()) {
        registry.register({ ...tool, execute: stub }, getBuiltInNamespace(tool.name));
    }
}

// ─── Hydration helpers ─────────────────────────────────────

/**
 * Get the default memory space when no agent context is available.
 */
function getDefaultMemorySpaces(): MemorySpaceRef[] {
    const defaultSpace = getDefaultMemorySpace();
    return defaultSpace ? [defaultSpace] : [];
}

/**
 * Given an array of tool definitions (fetched from the registry), replace any
 * built-in stubs with real context-aware implementations.
 */
export function hydrateBuiltInTools(
    tools: RegistryAwareToolDefinition[],
    ctx: {
        agentId?: string;
        conversationId: string;
        broadcast: BroadcastFn;
        memorySpaceOverrides?: MemorySpaceRef[];
        scheduleExecutionConfig?: ConversationExecutionConfig;
    },
): RegistryAwareToolDefinition[] {
    const assignedSpaces =
        ctx.memorySpaceOverrides ??
        (ctx.agentId ? getAssignedOrDefaultSpaces(ctx.agentId) : getDefaultMemorySpaces());
    const spaceFilter = buildMemorySpaceFilter(assignedSpaces);

    const hydrationContext: BuiltInHydrationContext = {
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
        broadcast: ctx.broadcast,
        assignedSpaces,
        spaceFilter,
        scheduleExecutionConfig: ctx.scheduleExecutionConfig,
    };

    return tools.map((t) => {
        const metadata = {
            registryKey: t.registryKey,
            originalName: t.originalName,
            namespaceId: t.namespaceId,
            namespaceLabel: t.namespaceLabel,
            namespaceDescription: t.namespaceDescription,
        };
        const originalName = t.originalName ?? t.name;
        const hydrate = BUILTIN_TOOL_HYDRATORS[originalName as BuiltinToolName];

        if (!hydrate) return t;

        return {
            ...hydrate(hydrationContext),
            name: t.name,
            ...metadata,
        };
    });
}
