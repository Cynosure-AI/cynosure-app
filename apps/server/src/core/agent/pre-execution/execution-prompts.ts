import type { SubAgentAssignment } from '../../agents/agent-store.js'
import type { ChatMessage } from '../../gateway/providers/base.provider.js'
import { resolvePromptSmartTags, resolvePromptTimeContext, type PromptSmartTagContext } from './prompt-smart-tags.js'

export interface ResolveSystemPromptInput {
    basePrompt?: string
    overridePrompt?: string
    suffix?: string
    subAgents?: SubAgentAssignment[]
    smartTagContext?: PromptSmartTagContext
}

export async function resolveSystemPromptMessages(input: ResolveSystemPromptInput): Promise<ChatMessage[]> {
    const {
        basePrompt,
        overridePrompt,
        suffix,
        subAgents,
        smartTagContext,
    } = input

    let effectiveSystemPrompt = overridePrompt ?? basePrompt ?? ''

    if (subAgents?.length) {
        const { buildSubAgentPrompt } = await import('../sub-agent-tools.js')
        effectiveSystemPrompt = appendPrompt(effectiveSystemPrompt, buildSubAgentPrompt(subAgents), '\n')
    }

    if (suffix) {
        effectiveSystemPrompt = appendPrompt(effectiveSystemPrompt, suffix, '\n')
    }

    // Resolve the time once so every tool round of this turn sees the same value.
    const tagContext = { ...smartTagContext, now: smartTagContext?.now ?? new Date() }
    const timeContext = resolvePromptTimeContext(effectiveSystemPrompt, tagContext)
    effectiveSystemPrompt = resolvePromptSmartTags(effectiveSystemPrompt, tagContext)

    const messages: ChatMessage[] = effectiveSystemPrompt ? [{ role: 'system', content: effectiveSystemPrompt }] : []
    // Turn-local, so it sits after the cached prefix instead of changing the system prompt.
    if (timeContext) messages.push({ role: 'user', content: timeContext, metadata: { contextKind: 'current-time' } })
    return messages
}

function appendPrompt(current: string, addition: string, separator: string): string {
    return current ? `${current}${separator}${addition}` : addition
}
