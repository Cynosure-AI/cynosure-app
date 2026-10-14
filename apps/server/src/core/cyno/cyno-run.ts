/**
 * Runs as Cyno outside the web chat: messaging channels and scheduled jobs
 * without an agent. They use Cyno's current profile, resolved the way a new
 * Cyno chat in the app would resolve it.
 */
import { getBuiltInToolKey } from '../tools/built-in-tools.js'
import { getDefaultMemoryFolder } from '../memory/memory-folder-scope.js'
import type { ConversationExecutionConfig, CynoProfile } from '@shared/types'
import { getCynoProfile } from './cyno-profile.js'

/** Tools a Cyno chat starts with when the profile has no selection of its own. */
const DEFAULT_TOOL_NAMES = ['manage_mcp', 'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']

/** Cyno's profile as a run configuration: unset tools are the defaults, unset memory is All Memory. */
export function cynoExecutionConfig(profile: CynoProfile = getCynoProfile()): ConversationExecutionConfig {
    const allMemory = getDefaultMemoryFolder()
    return {
        allowedTools: profile.tools ?? DEFAULT_TOOL_NAMES.map(getBuiltInToolKey),
        subAgents: profile.subAgents.map(({ agentId }) => ({ agentId })),
        memoryFolderIds: profile.memoryFolders ?? (allMemory ? [allMemory.id] : []),
        systemPrompt: profile.systemPrompt,
        model: profile.model,
        providerId: profile.providerId,
        thinkingEnabled: profile.thinkingEnabled,
        reasoningEffort: profile.reasoningEffort,
        autoToolRouting: profile.autoToolRouting,
        autoMemory: profile.autoMemory,
    }
}
