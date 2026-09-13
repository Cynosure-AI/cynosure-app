import { describe, expect, test, vi } from 'vitest'

vi.mock('../sub-agent-tools.js', () => ({
    buildSubAgentPrompt: (agents: Array<{ agentId: string }>) => `Sub-agents: ${agents.map(({ agentId }) => agentId).join(', ')}`,
}))

import { resolveSystemPromptMessages } from './execution-prompts.js'
import { resolvePromptSmartTags } from './prompt-smart-tags.js'

describe('prompt smart tags', () => {
    test('resolves execution identity, ISO time, and unique memory categories', () => {
        const result = resolvePromptSmartTags(
            '{{userName}} + {{agentName}}/{{providerId}}/{{model}} at {{isoDate}} {{isoTime}}. {{selectedMemFolderNames}}',
            {
                userName: 'Ada',
                agentName: 'Researcher',
                providerId: 'provider',
                model: 'model',
                selectedMemFolderNames: [' Project ', '', 'Project', 'Shared'],
                now: new Date('2026-05-06T07:08:09.000Z'),
            },
        )

        expect(result).toBe(
            'Ada + Researcher/provider/model at 2026-05-06 07:08:09. Provided Memory Categories are: Project, Shared',
        )
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
})
