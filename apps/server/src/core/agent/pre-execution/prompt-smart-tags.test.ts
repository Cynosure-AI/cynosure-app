import { describe, expect, test, vi } from 'vitest'

vi.mock('../sub-agent-tools.js', () => ({
    buildSubAgentPrompt: (agents: Array<{ agentId: string }>) => `Sub-agents: ${agents.map(({ agentId }) => agentId).join(', ')}`,
}))

import { resolveSystemPromptMessages } from './execution-prompts.js'
import { resolvePromptSmartTags, resolvePromptTimeContext } from './prompt-smart-tags.js'

describe('prompt smart tags', () => {
    test('resolves execution identity, ISO date, and unique memory folders', () => {
        const result = resolvePromptSmartTags(
            '{{userName}} + {{agentName}}/{{providerId}}/{{model}} at {{isoDate}}. {{selectedMemFolderNames}}',
            {
                userName: 'Ada',
                agentName: 'Researcher',
                providerId: 'provider',
                model: 'model',
                selectedMemFolderNames: [
                    { name: ' Project ', description: ' Active delivery work ' },
                    '',
                    { name: 'Project', description: 'Active delivery work' },
                    'Shared',
                ],
                now: new Date('2026-05-06T07:08:09.000Z'),
            },
        )

        expect(result).toBe(
            'Ada + Researcher/provider/model at 2026-05-06. Provided Memory Folders are: Project (description: Active delivery work), Shared',
        )
    })

    test('keeps time-of-day tags out of the resolved prompt so it stays cacheable', () => {
        const prompt = 'Now: {{currentDateTime}} | {{ currentTime }} | {{localDateTime}} | {{localTime}} | {{isoTime}}'
        const early = resolvePromptSmartTags(prompt, { now: new Date('2026-05-06T07:08:09.000Z') })
        const later = resolvePromptSmartTags(prompt, { now: new Date('2026-05-06T09:41:27.000Z') })

        expect(early).toBe(later)
        expect(early).not.toMatch(/\d:\d{2}/)
        expect(early).toContain('[Current time]')
    })

    test('builds time context only for prompts that use time-of-day tags', () => {
        const now = new Date('2026-05-06T07:08:09.000Z')

        expect(resolvePromptTimeContext('Date: {{currentDate}} {{isoDate}}', { now })).toBeNull()
        expect(resolvePromptTimeContext('', { now })).toBeNull()

        const context = resolvePromptTimeContext('Time: {{currentTime}}', { now })
        expect(context).toMatch(/^\[Current time\]\nLocal: .*\d:\d{2}.*\nUTC: 2026-05-06 07:08:09\n\[\/Current time\]$/)
    })

    test('leaves unknown or syntactically invalid tags unchanged', () => {
        expect(resolvePromptSmartTags('{{unknown}} {{ agentId }} {{1bad}}', { agentId: 'agent' }))
            .toBe('{{unknown}} agent {{1bad}}')
        expect(resolvePromptSmartTags('', {})).toBe('')
    })

    test('uses an override, appends sub-agent and suffix prompts, then resolves tags', async () => {
        await expect(resolveSystemPromptMessages({
            basePrompt: 'base',
            overridePrompt: 'Hello {{agentName}}',
            subAgents: [{ agentId: 'worker' }],
            suffix: 'Stay concise',
            smartTagContext: { agentName: 'Ada' },
        })).resolves.toEqual([{
            role: 'system',
            content: 'Hello Ada\nSub-agents: worker\nStay concise',
        }])
        await expect(resolveSystemPromptMessages({})).resolves.toEqual([])
    })

    test('sends the time as turn-local context instead of in the system prompt', async () => {
        const messages = await resolveSystemPromptMessages({
            basePrompt: 'It is {{currentTime}}.',
            smartTagContext: { now: new Date('2026-05-06T07:08:09.000Z') },
        })

        expect(messages).toHaveLength(2)
        expect(messages[0]).toEqual({ role: 'system', content: 'It is (see the latest [Current time] note).' })
        expect(messages[1]).toMatchObject({ role: 'user', metadata: { contextKind: 'current-time' } })
        expect(messages[1].content).toContain('UTC: 2026-05-06 07:08:09')
    })
})
