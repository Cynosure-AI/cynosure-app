import { describe, expect, test, vi } from 'vitest'
import type { ChannelSessionState } from './channel-session.js'

const agents = vi.hoisted(() => [
    { id: 'default', name: 'Default', internalName: 'default' },
    { id: 'coder', name: 'Coder', internalName: 'code-helper' },
])

vi.mock('../agents/agent-store.js', () => ({
    listAgents: () => agents,
    getAgent: (id: string) => agents.find(a => a.id === id) ?? null,
}))
vi.mock('../../db/database.js', () => ({
    getDb: () => ({ prepare: () => ({ get: () => undefined, run: () => {} }) }),
}))
vi.mock('../activity/stop-all.js', () => ({ stopAllActivity: () => ({ total: 0 }) }))

import { handleChannelCommand } from './channel-commands.js'

const style = { bold: (text: string) => `*${text}*`, switchBackHint: 'Use !start to switch back.' }

function makeState(): ChannelSessionState<string> {
    return {
        channelType: 'slack',
        channelId: 'channel',
        agentId: 'default',
        broadcast: vi.fn(),
        allowedAgentIds: [],
        activeExecutions: new Map(),
        agentOverride: new Map(),
        lastUsedAgent: new Map(),
        conversationTargets: new Map(),
        targetLocks: new Map(),
        pendingAttachments: new Map(),
        conversationSendQueue: new Map(),
    }
}

describe('shared channel commands', () => {
    test('switches agents by command name, then !new keeps and !start resets the agent', async () => {
        const state = makeState()
        const replies: string[] = []
        const run = (text: string) => handleChannelCommand(state, 'T1', text, async (r) => { replies.push(r) }, style)

        expect(await run('!code_helper')).toBe(true)
        expect(state.agentOverride.get('T1')).toBe('coder')
        expect(replies.at(-1)).toBe('🔀 Switched to *Coder*. Starting a fresh conversation.\n\nUse !start to switch back.')

        expect(await run('!new')).toBe(true)
        expect(state.agentOverride.get('T1')).toBe('coder')

        expect(await run('!start')).toBe(true)
        expect(state.agentOverride.has('T1')).toBe(false)
        expect(state.lastUsedAgent.get('T1')).toBe('coder')
        expect(replies.at(-1)).toBe('🔄 Switched back to default agent: *Default*\n\nStarting a fresh conversation.')
    })

    test('respects the agent allow-list and ignores unknown commands', async () => {
        const state = makeState()
        state.allowedAgentIds = ['default']
        const reply = vi.fn(async () => {})

        expect(await handleChannelCommand(state, 'T1', '!code-helper', reply, style)).toBe(false)
        expect(await handleChannelCommand(state, 'T1', '/unknown', reply, style)).toBe(false)
        expect(reply).not.toHaveBeenCalled()
    })
})
