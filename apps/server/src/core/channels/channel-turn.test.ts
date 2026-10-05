import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { getEventBus } from '../telemetry/event-bus.js'
import type { ChannelSessionState } from './channel-session.js'
import type { ChannelTransport } from './channel-turn.js'

const mocks = vi.hoisted(() => ({
    run: vi.fn(),
    planExecution: vi.fn(),
    persistUser: vi.fn(),
    persistAssistant: vi.fn(),
}))

vi.mock('../../db/database.js', () => ({
    getDb: () => ({ prepare: () => ({ get: () => ({ tg: 1 }), run: () => {} }) }),
}))
vi.mock('../gateway/gateway.js', () => ({ getGateway: () => ({}) }))
vi.mock('../tools/tool-registry.js', () => ({ getToolRegistry: () => ({}) }))
vi.mock('../memory/memory-folder-scope.js', () => ({ getAssignedMemoryFolders: () => [] }))
vi.mock('../agents/agent-store.js', () => ({
    getAgent: (id: string) => id === 'agent' ? { id, name: 'Agent' } : null,
}))
vi.mock('../agent/pre-execution/execution-planner.js', () => ({ planExecution: mocks.planExecution }))
vi.mock('../agent/planning-state.js', () => ({ closePlanningRun: vi.fn() }))
vi.mock('../agent/post-execution.js', () => ({ generateTitle: vi.fn(async () => {}) }))
vi.mock('../agent/agent-executor.js', () => ({
    MAIN_AGENT_MAX_ROUNDS: 10,
    AgentExecutor: class { run = mocks.run },
}))
vi.mock('./channel-session.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('./channel-session.js')>(),
    getOrCreateChannelConversation: () => 'conversation',
}))
vi.mock('./channel-execution.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('./channel-execution.js')>(),
    applyChannelContextLimit: async (input: { messages: unknown[] }) => ({ messages: input.messages }),
    buildChannelHistory: () => ({ messages: [{ role: 'user', content: 'history' }] }),
    materializeChannelInputAudio: async (urls: string[]) => urls,
    materializeChannelInputImages: async (urls: string[]) => urls,
    persistChannelAssistantMessage: mocks.persistAssistant,
    persistChannelExecutionConfig: vi.fn(),
    persistChannelUserMessage: mocks.persistUser,
    publishChannelStreamError: vi.fn(),
}))

import { receiveChannelMessage } from './channel-turn.js'

function makeState(): ChannelSessionState<string> {
    return {
        channelType: 'discord',
        channelId: 'channel',
        agentId: 'agent',
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

/** In-memory transport; message handles are indexes into `messages`. */
function makeTransport() {
    const messages: string[] = []
    const transport: ChannelTransport<number> = {
        logTag: '[Test]',
        previewLimit: 10,
        messageLimit: 20,
        bold: (text) => `**${text}**`,
        reply: async (text) => messages.push(text) - 1,
        send: async (text) => messages.push(text) - 1,
        edit: async (handle, text) => { messages[handle] = text },
        sendLong: async (text) => { messages.push(text) },
        sendImages: vi.fn(async () => {}),
    }
    return { transport, messages }
}

function inbound(transport: ChannelTransport<number>, overrides: Record<string, unknown> = {}) {
    return {
        target: 'target',
        text: 'hello',
        senderName: 'User',
        hasMedia: false,
        extractMedia: async () => ({ imageDataUrls: [], audioDataUrls: [] }),
        transport,
        ...overrides,
    }
}

describe('channel turn', () => {
    beforeEach(() => {
        mocks.run.mockReset()
        mocks.planExecution.mockReset().mockResolvedValue({
            messages: [], tools: [], providerId: 'p', responseProvider: 'p', responseModel: 'm',
        })
        mocks.persistUser.mockReset()
        mocks.persistAssistant.mockReset()
    })
    afterEach(() => getEventBus().removeAllListeners())

    test('handled commands skip the agent turn', async () => {
        const state = makeState()
        const { transport, messages } = makeTransport()

        await receiveChannelMessage(state, inbound(transport, { handleCommand: async () => true }))

        expect(messages).toEqual([])
        expect(mocks.planExecution).not.toHaveBeenCalled()
    })

    test('buffers media-only messages and attaches them to the next text turn', async () => {
        const state = makeState()
        const { transport, messages } = makeTransport()
        mocks.run.mockResolvedValue({ content: 'ok', images: [] })

        await receiveChannelMessage(state, inbound(transport, {
            text: '',
            hasMedia: true,
            extractMedia: async () => ({ imageDataUrls: ['data:image/png;base64,AA'], audioDataUrls: [] }),
        }))
        expect(messages).toEqual(['📎 Attachment received. Send a message to use it with the agent.'])
        expect(state.pendingAttachments.get('target')?.imageDataUrls).toHaveLength(1)

        await receiveChannelMessage(state, inbound(transport))

        expect(state.pendingAttachments.has('target')).toBe(false)
        expect(mocks.persistUser).toHaveBeenCalledWith(expect.objectContaining({
            content: 'hello', images: ['data:image/png;base64,AA'],
        }))
    })

    test('runs a turn: status line, final response, persistence, cleanup', async () => {
        const state = makeState()
        const { transport, messages } = makeTransport()
        mocks.run.mockResolvedValue({ content: 'the answer', images: [] })

        await receiveChannelMessage(state, inbound(transport))

        expect(messages[0]).toMatch(/^✅ Done thinking \(\d+s\)$/)
        expect(messages[1]).toBe('the answer')
        expect(mocks.persistAssistant).toHaveBeenCalledOnce()
        expect(state.conversationTargets.get('conversation')).toBe('target')
        expect(state.activeExecutions.size).toBe(0)
        expect(state.conversationSendQueue.size).toBe(0)
        expect(state.targetLocks.size).toBe(0)
    })

    test('posts compact tool status lines in the turn\'s send order', async () => {
        const state = makeState()
        const { transport, messages } = makeTransport()
        mocks.run.mockImplementation(async () => {
            getEventBus().emit('step:executed', {
                conversationId: 'conversation',
                results: [{ name: 'search', success: true }, { name: 'fetch', success: false }],
            })
            return { content: 'done', images: [] }
        })

        await receiveChannelMessage(state, inbound(transport))

        expect(messages[1]).toBe('✅ `search` executed\n❌ `fetch` failed'.slice(0, 20))
        expect(messages[2]).toBe('done')
    })

    test('reports execution errors on the status line', async () => {
        const state = makeState()
        const { transport, messages } = makeTransport()
        mocks.run.mockRejectedValue(new Error('provider down'))
        vi.spyOn(console, 'error').mockImplementation(() => {})

        await receiveChannelMessage(state, inbound(transport))

        expect(messages).toEqual(['⚠️ Error: provider d'.slice(0, '⚠️ Error: '.length + 10)])
        expect(state.activeExecutions.size).toBe(0)
    })
})
