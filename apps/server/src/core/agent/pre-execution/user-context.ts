import type { UserSettings } from '../../user-settings.js'

export interface UserContextOptions {
    /** Sub-agents report to the parent agent, so the user's reply preferences don't apply to them. */
    includeInstructions?: boolean
}

/**
 * The user's profile as a system prompt section. It changes only when the user
 * edits their profile, so it stays in the cacheable prompt prefix.
 */
export function buildUserContextPrompt(
    profile: Pick<UserSettings, 'name' | 'instructions'>,
    { includeInstructions = true }: UserContextOptions = {},
): string {
    const name = profile.name.trim()
    const instructions = includeInstructions ? profile.instructions.trim() : ''
    if (!name && !instructions) return ''

    const sections: string[] = []
    if (name) {
        // Memories are written in the third person, so the name is what links them to the person in the chat.
        sections.push([
            '## User',
            '',
            `The user's name is ${JSON.stringify(name)}. Stored memories and documents that mention ${name} are about the user you are working with.`,
        ].join('\n'))
    }
    if (instructions) {
        sections.push([
            '## User instructions',
            '',
            'The user set these standing instructions for every conversation. Follow them unless the current request asks for something different.',
            '',
            '<user_instructions>',
            instructions,
            '</user_instructions>',
        ].join('\n'))
    }
    return sections.join('\n\n')
}

/** Where memory tools should file facts about the user, so every run and Dream agree on one location. */
export function userMemoryFilingHint(name: string): string {
    const trimmed = name.trim()
    return trimmed
        ? `Facts about the user belong in People/${trimmed}; record them under that name rather than as "the user" or "me".`
        : ''
}
