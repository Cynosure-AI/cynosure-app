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

// The mocked database creates a fresh conversation per lookup, so the project assignment is tracked here.
const projectState = vi.hoisted(() => ({
    projects: [{ id: 'p1', name: 'Nintendo News' }, { id: 'p2', name: 'Garden' }],
    currentId: null as string | null,
}))
vi.mock('../projects/project-store.js', () => ({
    listProjects: () => projectState.projects,
    getProjectForConversation: () => projectState.projects.find((project) => project.id === projectState.currentId),
    setConversationProject: (_conversationId: string, projectId: string | null) => { projectState.currentId = projectId; return true },
}))

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

    test('!cyno switches to Cyno even when the channel defaults to another agent', async () => {
        const state = makeState()
        const replies: string[] = []

        expect(await handleChannelCommand(state, 'T1', '!cyno', async (r) => { replies.push(r) }, style)).toBe(true)

        expect(state.agentOverride.get('T1')).toBe('__agentless__')
        expect(replies.at(-1)).toBe('🔀 Switched to *Cyno*. Starting a fresh conversation.\n\nUse !start to switch back.')
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

describe('project command', () => {
    test('lists projects, switches by number or name, and leaves', async () => {
        projectState.currentId = null
        const state = makeState()
        const replies: string[] = []
        const run = (text: string) => handleChannelCommand(state, 'T1', text, async (r) => { replies.push(r) }, style)

        expect(await run('!project')).toBe(true)
        expect(replies.at(-1)).toBe('This chat is not in a project.\n\n1. Nintendo News\n2. Garden\n\nSend /project <name or number> to switch, or /project off to leave.')

        await run('!project 2')
        expect(projectState.currentId).toBe('p2')
        await run('!project nintendo')
        expect(projectState.currentId).toBe('p1')
        expect(replies.at(-1)).toBe('📁 Now working in *Nintendo News*. Its brief, open tasks, and instructions apply from your next message.')

        await run('!project')
        expect(replies.at(-1)).toContain('1. Nintendo News (current)')
        await run('!project unknown')
        expect(replies.at(-1)).toBe('No project matches "unknown". Send /project to see the list.')
        await run('!project off')
        expect(projectState.currentId).toBeNull()
        expect(replies.at(-1)).toBe('Left *Nintendo News*.')
    })
})
