import type { SubAgentAssignment } from '../../agents/agent-store.js'
import type { ChatMessage } from '../../gateway/providers/base.provider.js'
import { resolvePromptSmartTags, type PromptSmartTagContext } from './prompt-smart-tags.js'

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

    effectiveSystemPrompt = resolvePromptSmartTags(effectiveSystemPrompt, smartTagContext ?? {})

    return effectiveSystemPrompt ? [{ role: 'system', content: effectiveSystemPrompt }] : []
}

function appendPrompt(current: string, addition: string, separator: string): string {
    return current ? `${current}${separator}${addition}` : addition
}
