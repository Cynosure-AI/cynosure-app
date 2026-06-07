import type { SubAgentAssignment } from '../../agents/agent-store.js'
import type { ChatMessage } from '../../gateway/providers/base.provider.js'

export interface ResolveSystemPromptInput {
    basePrompt?: string
    overridePrompt?: string
    suffix?: string
    skillsPrompt?: string | null
    subAgents?: SubAgentAssignment[]
}

export async function resolveSystemPromptMessages(input: ResolveSystemPromptInput): Promise<ChatMessage[]> {
    const {
        basePrompt,
        overridePrompt,
        suffix,
        skillsPrompt,
        subAgents,
    } = input

    let effectiveSystemPrompt = overridePrompt ?? basePrompt ?? ''

    if (subAgents?.length) {
        const { buildSubAgentPrompt } = await import('../sub-agent-tools.js')
        effectiveSystemPrompt = appendPrompt(effectiveSystemPrompt, buildSubAgentPrompt(subAgents), '\n')
    }

    if (suffix) {
        effectiveSystemPrompt = appendPrompt(effectiveSystemPrompt, suffix, '\n')
    }

    if (skillsPrompt) {
        effectiveSystemPrompt = appendPrompt(effectiveSystemPrompt, skillsPrompt, '\n\n')
    }

    return effectiveSystemPrompt ? [{ role: 'system', content: effectiveSystemPrompt }] : []
}

function appendPrompt(current: string, addition: string, separator: string): string {
    return current ? `${current}${separator}${addition}` : addition
}
