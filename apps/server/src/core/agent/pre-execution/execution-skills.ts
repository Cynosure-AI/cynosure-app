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
    autoRouterProviderId?: string
    autoRouterModel?: string
    /** Extra metadata to merge into emitted EventBus events during pre-execution routing. */
    eventMeta?: Record<string, unknown>
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
        autoRouterProviderId,
        autoRouterModel,
        eventMeta,
    } = input

    const manualSkills = getSkillsByIds([
        ...(preset.skills || []),
        ...(selectedSkillIds || []),
    ], { enabledOnly: true })

    const useAgentAutoRouterProvider = preset.autoRouterProviderId === AGENT_ROUTER_PROVIDER
    const useAgentAutoRouterModel = preset.autoRouterModel === AGENT_ROUTER_MODEL
    const autoRouter = resolveRouterProviderModel({
        gateway,
        fallbackProviderId: providerId,
        fallbackModel: model,
        agentRouterProviderId: useAgentAutoRouterProvider ? preset.providerId : (preset.autoRouterProviderId || undefined),
        agentRouterModel: useAgentAutoRouterModel ? (preset.model || undefined) : (preset.autoRouterModel || undefined),
        requestRouterProviderId: autoRouterProviderId,
        requestRouterModel: useAgentAutoRouterProvider ? undefined : autoRouterModel,
    })

    const selectedSkills = await applyAutoSkillRouting({
        enabled: isSkillRoutingEnabled(preset, autoSkillRouting),
        gateway,
        conversationId,
        userQuery,
        recentMessages,
        manualSkills,
        availableSkills: listSkills({ enabledOnly: true }),
        providerId: autoRouter.providerId,
        model,
        routerModel: autoRouter.model,
        eventMeta,
    })

    return buildSkillsSystemPrompt(selectedSkills) || null
}

function isSkillRoutingEnabled(preset: ExecutionPreset, sessionEnabled?: boolean): boolean {
    if (sessionEnabled === true) return true
    if (sessionEnabled === false) return false
    return preset.autoSkillRouting === true
}
