/**
 * The settings one run executes with. Every entry point (app chat, messaging
 * channels, scheduled jobs and webhooks) resolves them here, so a setting
 * means the same thing wherever a run starts.
 *
 * A run has an agent, whose saved definition applies, or none: Cyno. The
 * settings chosen for this run (a chat's session settings, a job's saved chat
 * settings, Cyno's profile) take precedence; unset fields fall back to the
 * agent's.
 */
import { getDb } from '../../db/database.js'
import { getToolRegistry, type ToolRegistry } from '../tools/tool-registry.js'
import { getAssignedMemoryFolderIds, getAssignedMemoryFolders } from '../memory/memory-folder-scope.js'
import { buildPersistedChatConfig, resolveMemoryFolderOverrides, resolveToolSelection } from '../chat/run-config.js'
import { defaultAutoModes } from './execution-preset.js'
import type { AgentData } from '../agents/agent-store.js'
import type { ExecutionRequest } from './pre-execution/execution-input.js'
import type { ConversationExecutionConfig, ReasoningEffort } from '@shared/types'

/** Settings chosen for one run. Unset memory means the agent's folders (all memory for Cyno); empty means memory off. */
export type RunChoices = Partial<ConversationExecutionConfig>

export interface RunSettings {
    /** Null for Cyno. */
    agent: AgentData | null
    /** planExecution options; callers add their own prompt suffix, tool tracking, and limits. */
    plan: NonNullable<ExecutionRequest['run']>
    /** Ask before running tools that need approval. */
    hitl: boolean
    thinkingEnabled: boolean
    reasoningEffort?: ReasoningEffort
    /** The agent's cap on the context window, if it has one. */
    maxContextTokens: number | null
    /** The settings to store on the conversation, with the model the run resolved to. */
    persistedConfig(responseModel: string, responseProvider: string): ConversationExecutionConfig
}

export function resolveRunSettings(
    agent: AgentData | null,
    choices: RunChoices = {},
    toolRegistry: ToolRegistry = getToolRegistry(),
): RunSettings {
    const autoModes = defaultAutoModes(agent)
    const autoToolRouting = choices.autoToolRouting ?? autoModes.autoToolRouting
    const autoMemory = choices.autoMemory ?? autoModes.autoMemory
    const thinkingEnabled = choices.thinkingEnabled ?? (agent?.thinkingEnabled !== false)
    const reasoningEffort = choices.reasoningEffort ?? agent?.reasoningEffort
    const tools = Array.isArray(choices.allowedTools)
        ? resolveToolSelection(toolRegistry, choices.allowedTools, choices.autoToolRouting)
        : null
    const memoryFolderOverrides = Array.isArray(choices.memoryFolderIds)
        ? resolveMemoryFolderOverrides(getDb(), choices.memoryFolderIds)
        : (agent ? getAssignedMemoryFolders(agent.id) : undefined)

    return {
        agent,
        plan: {
            providerOverride: choices.providerId || undefined,
            modelOverride: choices.model || undefined,
            systemPrompt: choices.systemPrompt || undefined,
            requestedSubAgents: choices.subAgents,
            memoryFolderOverrides,
            selectedToolKeys: tools?.selectedToolKeys,
            hasExplicitToolAllowlist: tools?.hasExplicitToolAllowlist ?? false,
            autoToolRouting,
            autoMemory,
            autoRouterProviderId: choices.autoRouterProviderId || undefined,
            autoRouterModel: choices.autoRouterModel || undefined,
            thinkingEnabled,
            reasoningEffort,
        },
        hitl: agent ? !agent.autoApproveTools : true,
        thinkingEnabled,
        reasoningEffort,
        maxContextTokens: typeof agent?.maxContextTokens === 'number' && agent.maxContextTokens > 0 ? agent.maxContextTokens : null,
        persistedConfig: (responseModel, responseProvider) => buildPersistedChatConfig({
            selectedToolKeys: tools?.selectedToolKeys ?? agent?.tools ?? [],
            requestedSubAgents: choices.subAgents ?? agent?.subAgents ?? [],
            requestedMemoryFolderIds: choices.memoryFolderIds ?? (agent ? getAssignedMemoryFolderIds(agent.id) : []),
            // Only the editable base prompt belongs in session settings; runs add their own instructions.
            systemPrompt: choices.systemPrompt ?? agent?.systemPrompt ?? '',
            responseModel,
            responseProvider,
            thinkingEnabled,
            reasoningEffort,
            autoToolRouting,
            autoMemory,
        }),
    }
}
