import { describe, expect, test } from 'vitest'
import { buildUserContextPrompt, userMemoryFilingHint } from './user-context.js'
import { resolveSystemPromptMessages } from './execution-prompts.js'

describe('user context prompt', () => {
    test('is empty without a name or instructions', () => {
        expect(buildUserContextPrompt({ name: ' ', instructions: '\n' })).toBe('')
    })

    test('names the user and links memories that mention them', () => {
        const prompt = buildUserContextPrompt({ name: 'Andi', instructions: '' })

        expect(prompt).toContain('## User')
        expect(prompt).toContain('The user\'s name is "Andi".')
        expect(prompt).toContain('mention Andi are about the user')
        expect(prompt).not.toContain('## User instructions')
    })

    test('includes standing instructions unless they are excluded', () => {
        const profile = { name: 'Andi', instructions: '  I understand allegories best.  ' }

        expect(buildUserContextPrompt(profile)).toContain('<user_instructions>\nI understand allegories best.\n</user_instructions>')
        expect(buildUserContextPrompt(profile, { includeInstructions: false })).not.toContain('allegories')
    })

    test('files facts about the user under their name', () => {
        expect(userMemoryFilingHint('Andi')).toContain('People/Andi')
        expect(userMemoryFilingHint('')).toBe('')
    })

    test('is appended after smart tags resolve so user text stays literal', async () => {
        const [message] = await resolveSystemPromptMessages({
            basePrompt: 'Hello {{userName}}',
            smartTagContext: { userName: 'Andi' },
            userContext: buildUserContextPrompt({ name: 'Andi', instructions: 'Write {{userName}} literally.' }),
        })

        expect(message.content).toMatch(/^Hello Andi\n\n## User\n/)
        expect(message.content).toContain('Write {{userName}} literally.')
    })

    test('stands alone when the agent has no system prompt', async () => {
        const [message] = await resolveSystemPromptMessages({
            userContext: buildUserContextPrompt({ name: '', instructions: 'Be brief.' }),
        })

        expect(message.content).toMatch(/^## User instructions/)
    })
})
