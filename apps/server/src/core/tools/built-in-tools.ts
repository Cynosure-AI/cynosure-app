import type { RegistryAwareToolDefinition, ToolDefinition } from "../gateway/providers/base.provider.js";
import type { ConversationExecutionConfig } from "@shared/types";
import {
    buildMemoryFolderFilter,
    expandMemoryFolderScope,
    getAssignedMemoryFolders,
    getDefaultMemoryFolder,
    type MemoryFolderRef,
} from "../memory/memory-folder-scope.js";
import { getToolRegistry, type ToolNamespace } from "./tool-registry.js";
import { makeNotificationTool } from "./builtin/notification.js";
import { makeScheduleTools, SCHEDULE_TOOL_NAMES } from "./builtin/schedule-tools.js";
import { makeManageMcpTool } from "./builtin/manage-mcp.js";
import { makeFileTools } from "./builtin/file-tools.js";
import { makeShellTool } from "./builtin/shell-tool.js";
import {
    makeMemorySearchTool,
    makeMemoryCreateTool,
    makeMemoryPatchTool,
    makeMemoryDeleteTool,
    MEMORY_READ_TOOL_NAMES,
    MEMORY_TOOL_NAMES,
} from "./builtin/memory-tools.js";
export { makeSearchAvailableMcpToolsTool } from "./builtin/expand-available-toolset.js";

type BroadcastFn = (event: string, data: unknown) => void;

export const BUILTIN_NAMESPACE_IDS = {
    memory: "builtin:memory",
    scheduling: "builtin:scheduling",
    notifications: "builtin:notifications",
    utility: "builtin:utility",
    files: "builtin:files",
    shell: "builtin:shell",
} as const;

export const BUILTIN_NAMESPACES = {
    memory: {
        id: BUILTIN_NAMESPACE_IDS.memory,
        label: "Built-In: Memory",
        description: "Search, create, update, and organize persistent memory and knowledge.",
    },
    scheduling: {
        id: BUILTIN_NAMESPACE_IDS.scheduling,
        label: "Built-In: Scheduling",
        description: "Create, review, update, and remove scheduled agent tasks.",
    },
    notifications: {
        id: BUILTIN_NAMESPACE_IDS.notifications,
        label: "Built-In: Notifications",
        description: "Send notifications in Cynosure or through connected channels.",
    },
    utility: {
        id: BUILTIN_NAMESPACE_IDS.utility,
        label: "Built-In: Utility",
        description: "Work with attachments, MCP tools, planning, and sub-agent delegation.",
    },
    files: {
        id: BUILTIN_NAMESPACE_IDS.files,
        label: "Built-In: Files",
        description: "Browse and manage local files and directories within allowed folders.",
    },
    shell: {
        id: BUILTIN_NAMESPACE_IDS.shell,
        label: "Built-In: Shell",
        description: "Run shell commands with server permissions using the normal tool approval settings.",
    },
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
    assignedFolders: MemoryFolderRef[];
    folderFilter?: string;
    scheduleExecutionConfig?: ConversationExecutionConfig;
}

const BUILTIN_TOOL_HYDRATORS = {
    ...Object.fromEntries(makeFileTools().map((tool) => [tool.name, () => tool])),
    shell_execute: () => makeShellTool(),
    manage_mcp: () => makeManageMcpTool(),
    notify_user: (ctx: BuiltInHydrationContext) => makeNotificationTool({
        agentId: ctx.agentId || "",
        conversationId: ctx.conversationId,
        broadcast: ctx.broadcast,
    }),
    schedule_create: (ctx: BuiltInHydrationContext) => makeScheduleTools({ agentId: ctx.agentId || "", executionConfig: ctx.scheduleExecutionConfig })[0],
    schedule_list: (ctx: BuiltInHydrationContext) => makeScheduleTools({ agentId: ctx.agentId || "", executionConfig: ctx.scheduleExecutionConfig })[1],
    schedule_update: (ctx: BuiltInHydrationContext) => makeScheduleTools({ agentId: ctx.agentId || "", executionConfig: ctx.scheduleExecutionConfig })[2],
    schedule_delete: (ctx: BuiltInHydrationContext) => makeScheduleTools({ agentId: ctx.agentId || "", executionConfig: ctx.scheduleExecutionConfig })[3],
    memory_search: (ctx: BuiltInHydrationContext) => makeMemorySearchTool({
        folderFilter: ctx.folderFilter,
        assignedFolders: ctx.assignedFolders,
    }),
    memory_create: (ctx: BuiltInHydrationContext) => makeMemoryCreateTool({
        assignedFolders: ctx.assignedFolders,
        revisionContext: { source: 'ai', conversationId: ctx.conversationId, agentId: ctx.agentId },
    }),
    memory_patch: (ctx: BuiltInHydrationContext) => makeMemoryPatchTool({
        assignedFolders: ctx.assignedFolders,
        revisionContext: { source: 'ai', conversationId: ctx.conversationId, agentId: ctx.agentId },
    }),
    memory_delete: (ctx: BuiltInHydrationContext) => makeMemoryDeleteTool({
        assignedFolders: ctx.assignedFolders,
        revisionContext: { source: 'ai', conversationId: ctx.conversationId, agentId: ctx.agentId },
    }),
} as const satisfies Record<string, (ctx: BuiltInHydrationContext) => ToolDefinition>;

export const BUILTIN_TOOL_NAMES = Object.keys(BUILTIN_TOOL_HYDRATORS);

export type BuiltinToolName = keyof typeof BUILTIN_TOOL_HYDRATORS;

export function getBuiltInNamespace(toolName: string): ToolNamespace {
    if (toolName.startsWith('file_') || toolName.startsWith('directory_')) return BUILTIN_NAMESPACES.files;
    if (toolName === 'shell_execute') return BUILTIN_NAMESPACES.shell;
    if (MEMORY_TOOL_NAMES.includes(toolName as never)) {
        return BUILTIN_NAMESPACES.memory;
    }
    if (SCHEDULE_TOOL_NAMES.includes(toolName as never)) return BUILTIN_NAMESPACES.scheduling;
    return BUILTIN_NAMESPACES.utility;
}

export function getBuiltInToolKey(toolName: string): string {
    return `${getBuiltInNamespace(toolName).id}::${toolName}`;
}

function getBuiltInToolSpecs(): BuiltInToolSpec[] {
    const specContext: BuiltInHydrationContext = {
        conversationId: "",
        broadcast: () => undefined,
        assignedFolders: [],
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
    return [
        ...getBuiltInMemoryReadToolKeys(),
        getBuiltInToolKey('memory_create'),
        getBuiltInToolKey('memory_patch'),
        getBuiltInToolKey('memory_delete'),
    ];
}

export function getBuiltInMemoryReadToolKeys(): string[] {
    return [...MEMORY_READ_TOOL_NAMES].map(getBuiltInToolKey);
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
 * Get the default memory folder when no agent context is available.
 */
function getDefaultMemoryFolders(): MemoryFolderRef[] {
    const uncategorizedFolder = getDefaultMemoryFolder();
    return uncategorizedFolder ? [uncategorizedFolder] : [];
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
        memoryFolderOverrides?: MemoryFolderRef[];
        scheduleExecutionConfig?: ConversationExecutionConfig;
    },
): RegistryAwareToolDefinition[] {
    const selectedFolders =
        ctx.memoryFolderOverrides ??
        (ctx.agentId ? getAssignedMemoryFolders(ctx.agentId) : getDefaultMemoryFolders());
    const assignedFolders = expandMemoryFolderScope(selectedFolders);
    const folderFilter = buildMemoryFolderFilter(assignedFolders);

    const hydrationContext: BuiltInHydrationContext = {
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
        broadcast: ctx.broadcast,
        assignedFolders,
        folderFilter,
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
