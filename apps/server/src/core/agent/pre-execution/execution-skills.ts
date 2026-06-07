import { getSkillsByIds, listSkills } from '../../skills/skill-store.js'
import { buildSkillsSystemPrompt } from '../../skills/skill-router.js'
import { applyAutoSkillRouting } from './auto-skill-routing.js'
import { resolveRouterProviderModel } from './execution-resolvers.js'
import type { ExecutionPreset } from '../execution-preset.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage } from '../../gateway/providers/base.provider.js'

const AGENT_ROUTER_PROVIDER = '__agent_provider__'
const AGENT_ROUTER_MODEL = '__agent_model__'

export interface ResolveSkillPromptInput {
    preset: ExecutionPreset
    gateway: LLMGateway
    conversationId: string
    providerId: string
    model: string
    userQuery?: string
    recentMessages?: ChatMessage[]
    selectedSkillIds?: string[]
    autoSkillRouting?: boolean
    skillRouterProviderId?: string
    skillRouterModel?: string
}

export async function resolveSkillSystemPrompt(input: ResolveSkillPromptInput): Promise<string | null> {
    const {
        preset,
        gateway,
        conversationId,
        providerId,
        model,
        userQuery,
        recentMessages,
        selectedSkillIds,
        autoSkillRouting,
        skillRouterProviderId,
        skillRouterModel,
    } = input

    const manualSkills = getSkillsByIds([
        ...(preset.skills || []),
        ...(selectedSkillIds || []),
    ], { enabledOnly: true })

    const useAgentSkillRouterProvider = preset.skillRouterProviderId === AGENT_ROUTER_PROVIDER
    const useAgentSkillRouterModel = preset.skillRouterModel === AGENT_ROUTER_MODEL
    const skillRouter = resolveRouterProviderModel({
        gateway,
        fallbackProviderId: providerId,
        fallbackModel: model,
        agentRouterProviderId: useAgentSkillRouterProvider ? preset.providerId : (preset.skillRouterProviderId || undefined),
        agentRouterModel: useAgentSkillRouterModel ? (preset.model || undefined) : (preset.skillRouterModel || undefined),
        requestRouterProviderId: skillRouterProviderId,
        requestRouterModel: useAgentSkillRouterProvider ? undefined : skillRouterModel,
    })

    const selectedSkills = await applyAutoSkillRouting({
        enabled: isSkillRoutingEnabled(preset, autoSkillRouting),
        gateway,
        conversationId,
        userQuery,
        recentMessages,
        manualSkills,
        availableSkills: listSkills({ enabledOnly: true }),
        providerId: skillRouter.providerId,
        model,
        routerModel: skillRouter.model,
    })

    return buildSkillsSystemPrompt(selectedSkills) || null
}

function isSkillRoutingEnabled(preset: ExecutionPreset, sessionEnabled?: boolean): boolean {
    if (sessionEnabled === true) return true
    if (sessionEnabled === false) return false
    return preset.autoSkillRouting === true
}
