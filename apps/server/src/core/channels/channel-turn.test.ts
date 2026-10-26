import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { getEventBus } from '../telemetry/event-bus.js'
import type { ChannelSessionState } from './channel-session.js'
import type { ChannelTransport } from './channel-turn.js'

const mocks = vi.hoisted(() => ({
    run: vi.fn(),
    planExecution: vi.fn(),
    persistUser: vi.fn(),
    persistAssistant: vi.fn(),
    enqueueChat: vi.fn(),
    requestSteering: vi.fn(),
}))

vi.mock('../../db/database.js', () => ({
    getDb: () => ({ prepare: () => ({ get: () => ({ tg: 1 }), run: () => {} }) }),
}))
vi.mock('../gateway/gateway.js', () => ({ getGateway: () => ({}) }))
vi.mock('../tools/tool-registry.js', () => ({ getToolRegistry: () => ({}) }))
vi.mock('../memory/memory-folder-scope.js', () => ({ getAssignedMemoryFolders: () => [], getAssignedMemoryFolderIds: () => [] }))
vi.mock('../agents/agent-store.js', () => ({
    getAgent: (id: string) => id === 'agent' ? { id, name: 'Agent' } : null,
}))
vi.mock('../cyno/cyno-profile.js', () => ({ getCynoProfile: () => ({ name: 'Cyno' }) }))
vi.mock('../cyno/cyno-run.js', () => ({
    cynoExecutionConfig: () => ({ model: 'cyno-model', systemPrompt: 'Cyno prompt', thinkingEnabled: true, reasoningEffort: 'medium' }),
}))
vi.mock('../agent/pre-execution/execution-planner.js', () => ({ planExecution: mocks.planExecution }))
vi.mock('../agent/planning-state.js', () => ({ closePlanningRun: vi.fn() }))
vi.mock('../agent/post-execution.js', () => ({ generateTitle: vi.fn(async () => {}) }))
vi.mock('../agent/agent-executor.js', () => ({
    MAIN_AGENT_MAX_ROUNDS: 10,
    AgentExecutor: class { run = mocks.run; requestSteering = mocks.requestSteering },
}))
vi.mock('../chat/message-queue.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('../chat/message-queue.js')>(),
    enqueueChatMessage: mocks.enqueueChat,
    registerChatSteeringHandler: () => () => {},
}))
vi.mock('./channel-session.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('./channel-session.js')>(),
    getOrCreateChannelConversation: () => 'conversation',
    resolveContinuedConversation: (_state: unknown, id: string) =>
        id === 'cron-run' ? { conversationId: 'cron-run', agentId: null } : null,
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

vi.mock('../triggers/cron-scheduler.js', () => ({ cancelConversationWait: vi.fn() }))

import { cancelConversationWait } from '../triggers/cron-scheduler.js'
import { receiveChannelMessage } from './channel-turn.js'
import { publishChannelStreamError } from './channel-execution.js'
import { subscribeChannelHITL } from './channel-session.js'

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
        activeTurns: new Map(),
        conversationSendQueue: new Map(),
        sessionIdleMs: 0,
    }
}

const DELETED = '[deleted]'

/** In-memory transport; message handles are indexes into `log`, `messages` is what is still visible. */
function makeTransport() {
    const log: string[] = []
    const transport: ChannelTransport<number> = {
        logTag: '[Test]',
        messageLimit: 4000,
        reply: async (text) => log.push(text) - 1,
        send: async (text) => log.push(text) - 1,
        edit: async (handle, text) => { log[handle] = text },
        delete: async (handle) => { log[handle] = DELETED },
        react: vi.fn(async () => {}),
        sendImages: vi.fn(async () => {}),
    }
    const messages = new Proxy(log, {
        get: (target, key) => Reflect.get(target.filter(text => text !== DELETED), key),
    })
    return { transport, messages, log }
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
        mocks.enqueueChat.mockReset().mockResolvedValue({})
        mocks.requestSteering.mockReset()
    })
    afterEach(() => {
        getEventBus().removeAllListeners()
        vi.useRealTimers()
    })

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
        expect(messages).toEqual(['📎 Got it. What should I do with this?'])
        expect(state.pendingAttachments.get('target')?.imageDataUrls).toHaveLength(1)

        await receiveChannelMessage(state, inbound(transport))

        expect(state.pendingAttachments.has('target')).toBe(false)
        expect(mocks.persistUser).toHaveBeenCalledWith(expect.objectContaining({
            content: 'hello', images: ['data:image/png;base64,AA'],
        }))
    })

    test('runs a quick turn: seen reaction, final response only, persistence, cleanup', async () => {
        const state = makeState()
        const { transport, messages } = makeTransport()
        mocks.run.mockResolvedValue({ content: 'the answer', images: [] })

        await receiveChannelMessage(state, inbound(transport))

        expect(messages).toEqual(['the answer'])
        expect(vi.mocked(transport.react!).mock.calls).toEqual([['👀'], [null]])
        expect(state.activeTurns.size).toBe(0)
        expect(mocks.persistAssistant).toHaveBeenCalledOnce()
        expect(state.conversationTargets.get('conversation')).toBe('target')
        expect(state.activeExecutions.size).toBe(0)
        expect(state.conversationSendQueue.size).toBe(0)
        expect(state.targetLocks.size).toBe(0)
    })

    test('cancels pending conversation waits when a turn starts', async () => {
        const state = makeState()
        const { transport } = makeTransport()
        mocks.run.mockResolvedValue({ content: 'done', images: [] })
        await receiveChannelMessage(state, inbound(transport))
        expect(cancelConversationWait).toHaveBeenCalledWith('conversation')
    })

    test('keeps tool logs and intermediate images out of the channel', async () => {
        const state = makeState()
        const { transport, messages } = makeTransport()
        mocks.run.mockImplementation(async () => {
            getEventBus().emit('step:executed', {
                conversationId: 'conversation',
                results: [{ name: 'search', success: true, imageDataUrls: ['data:image/png;base64,AA'] }, { name: 'fetch', success: false }],
            })
            return { content: 'done', images: [] }
        })

        await receiveChannelMessage(state, inbound(transport))

        expect(messages).toEqual(['done'])
        expect(transport.sendImages).not.toHaveBeenCalled()
    })

    test('posts one complete answer after work, without streamed previews or late edits', async () => {
        vi.useFakeTimers()
        const state = makeState()
        const { transport, messages, log } = makeTransport()
        const edit = vi.spyOn(transport, 'edit')
        mocks.run.mockImplementation(async () => {
            getEventBus().emit('step:content', { conversationId: 'conversation', content: 'First I will…' })
            getEventBus().emit('step:content', { conversationId: 'conversation', content: 'Private findings', maCodename: 'researcher' })
            await vi.advanceTimersByTimeAsync(3_000)
            expect(messages).toHaveLength(0)
            await vi.advanceTimersByTimeAsync(13_000)
            expect(messages).toHaveLength(1)
            expect(messages[0]).toContain('15s')
            return { content: 'The finished answer', images: [] }
        })

        await receiveChannelMessage(state, inbound(transport))

        expect(messages).toEqual(['The finished answer'])
        expect(log[0]).toBe(DELETED)
        expect(edit.mock.calls.every(([handle]) => handle === 0)).toBe(true)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(messages).toEqual(['The finished answer'])
        expect(vi.getTimerCount()).toBe(0)
    })

    test('pauses progress and typing during approval, then sends the answer after the prompt', async () => {
        vi.useFakeTimers()
        const state = makeState()
        const { transport, messages } = makeTransport()
        const sendTyping = vi.fn(async () => {})
        transport.sendTyping = sendTyping
        const unsubscribe = subscribeChannelHITL(state, async () => { await transport.send('Approval needed') })
        mocks.run.mockImplementation(async () => {
            const typingBefore = sendTyping.mock.calls.length
            getEventBus().emit('hitl:request', { conversationId: 'other', taskId: 'other', toolCalls: [] })
            getEventBus().emit('hitl:request', { conversationId: 'conversation', taskId: 'approval', toolCalls: [] })
            await vi.advanceTimersByTimeAsync(30_000)
            // The prompt is the only UI while paused; no status card lands below it.
            expect(messages).toEqual(['Approval needed'])
            expect(sendTyping).toHaveBeenCalledTimes(typingBefore)
            getEventBus().emit('hitl:resolved', { taskId: 'approval' })
            await vi.advanceTimersByTimeAsync(5_000)
            expect(messages[1]).toContain('Working')
            expect(sendTyping.mock.calls.length).toBeGreaterThan(typingBefore)
            return { content: 'All done', images: [] }
        })

        await receiveChannelMessage(state, inbound(transport))

        expect(messages).toEqual(['Approval needed', 'All done'])
        expect(state.conversationSendQueue.size).toBe(0)
        unsubscribe()
    })

    test('sends generated images before the final text and tracks replies to every long-answer chunk', async () => {
        const state = makeState()
        const { transport, messages } = makeTransport()
        transport.messageLimit = 20
        const answer = 'Here is your result.\n\nMore details follow.\n\nAnd the final detail.'
        const onFinalReply = vi.fn()
        vi.mocked(transport.sendImages).mockImplementation(async () => { messages.push('[image]') })
        mocks.run.mockResolvedValue({ content: answer, images: ['data:image/png;base64,AA'] })

        await receiveChannelMessage(state, inbound(transport, { onFinalReply }))

        expect(messages[0]).toBe('[image]')
        expect(messages.slice(1).join('')).toBe(answer)
        expect(messages.slice(1).every(chunk => chunk.length <= 20)).toBe(true)
        expect(onFinalReply.mock.calls).toEqual(messages.slice(1).map((_, i) => [i + 1, 'conversation']))
        expect(transport.sendImages).toHaveBeenCalledOnce()
    })

    test('keeps a saved answer intact and reports delivery failure without claiming completion', async () => {
        const state = makeState()
        const { transport, messages } = makeTransport()
        transport.send = async () => null
        mocks.run.mockResolvedValue({ content: 'Saved answer', images: [] })
        vi.spyOn(console, 'error').mockImplementation(() => {})

        await receiveChannelMessage(state, inbound(transport))

        expect(mocks.persistAssistant).toHaveBeenCalledOnce()
        expect(publishChannelStreamError).not.toHaveBeenCalled()
        expect(messages.at(-1)).toContain('saved in Cynosure')
        expect(messages.join('')).not.toContain('Finished')
        expect(state.activeExecutions.size).toBe(0)
        expect(state.conversationSendQueue.size).toBe(0)
    })

    test('cancellation ends at the bottom and removes timers and outbound state', async () => {
        vi.useFakeTimers()
        const state = makeState()
        const { transport, messages } = makeTransport()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        mocks.run.mockImplementation(async () => {
            await transport.send('Approval needed')
            state.activeExecutions.values().next().value!.controller.abort()
            throw new DOMException('Cancelled', 'AbortError')
        })

        await receiveChannelMessage(state, inbound(transport))

        expect(messages).toEqual(['Approval needed', '⏹ Stopped.'])
        expect(state.conversationSendQueue.size).toBe(0)
        expect(state.activeExecutions.size).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
    })

    test('a reply to a delivered message continues that conversation and reports the final reply', async () => {
        const state = makeState()
        const { transport, messages } = makeTransport()
        const onFinalReply = vi.fn()
        mocks.run.mockResolvedValue({ content: 'more detail', images: [] })

        await receiveChannelMessage(state, inbound(transport, { continueConversationId: 'cron-run', onFinalReply }))

        expect(mocks.persistUser).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'cron-run' }))
        expect(mocks.planExecution).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'cron-run' }))
        expect(state.conversationTargets.get('cron-run')).toBe('target')
        expect(onFinalReply).toHaveBeenCalledWith(messages.indexOf('more detail'), 'cron-run')
    })

    test('a channel set to Cyno runs without an agent, with Cyno\'s settings', async () => {
        const state = makeState()
        state.agentId = '__agentless__'
        const { transport, messages } = makeTransport()
        mocks.run.mockResolvedValue({ content: 'hi from Cyno', images: [] })

        await receiveChannelMessage(state, inbound(transport))

        expect(mocks.planExecution).toHaveBeenCalledWith(expect.objectContaining({
            resolvedAgent: null, run: expect.objectContaining({ systemPrompt: 'Cyno prompt', modelOverride: 'cyno-model' }),
        }))
        expect(mocks.persistAssistant).toHaveBeenCalledWith(expect.objectContaining({ agentId: null }))
        expect(messages).toContain('hi from Cyno')
    })

    test('an unknown continued conversation falls back to the active one', async () => {
        const state = makeState()
        const { transport } = makeTransport()
        mocks.run.mockResolvedValue({ content: 'ok', images: [] })

        await receiveChannelMessage(state, inbound(transport, { continueConversationId: 'deleted' }))

        expect(mocks.persistUser).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conversation' }))
    })

    test('reports execution errors once, at the bottom', async () => {
        const state = makeState()
        const { transport, messages } = makeTransport()
        mocks.run.mockRejectedValue(new Error('provider down'))
        vi.spyOn(console, 'error').mockImplementation(() => {})

        await receiveChannelMessage(state, inbound(transport))

        expect(messages).toEqual(["⚠️ I couldn't finish this request: provider down"])
        expect(state.activeExecutions.size).toBe(0)
    })

    test('shows tool steps on a status card and removes it with the answer', async () => {
        const state = makeState()
        const { transport, messages, log } = makeTransport()
        mocks.run.mockImplementation(async () => {
            getEventBus().emit('step:tools-chosen', { conversationId: 'conversation', toolCalls: [
                { id: 'c1', name: 'directory_create', arguments: '{"path":"/recipes/53-wurst-topf"}' },
                { id: 'c2', name: 'Foto.jpg', arguments: '{"type":"attachment-index"}' },
                { id: 'c3', name: 'shell_execute', arguments: '{"command":"ls","explanation":"List the recipes"}' },
            ] })
            getEventBus().emit('step:tools-chosen', { conversationId: 'conversation', maCodename: 'helper', toolCalls: [{ id: 's1', name: 'sub_tool' }] })
            await vi.waitFor(() => expect(messages[0]).toContain('› Directory create · `53-wurst-topf`'))
            expect(messages[0]).not.toContain('Foto')
            expect(messages[0]).toContain('› 💻 List the recipes')
            expect(messages[0]).not.toContain('Sub tool')
            getEventBus().emit('step:executed', { conversationId: 'conversation', results: [{ toolCallId: 'c1', success: true }] })
            await vi.waitFor(() => expect(messages[0]).toContain('✓ Directory create'))
            return { content: 'Saved the recipe.', images: [] }
        })

        await receiveChannelMessage(state, inbound(transport))

        expect(log[0]).toBe(DELETED)
        expect(messages).toEqual(['Saved the recipe.'])
    })

    test('a follow-up during a turn steers it and declines the open approval', async () => {
        const state = makeState()
        const first = makeTransport()
        const followUp = makeTransport()
        const resolveApproval = vi.fn()
        let finish!: (value: unknown) => void
        mocks.run.mockImplementation(() => {
            getEventBus().emit('hitl:request', { conversationId: 'conversation', taskId: 'approval', resolve: resolveApproval,
                toolCalls: [{ id: 'c1', function: { name: 'file_move', arguments: '{}' } }] })
            return new Promise(resolve => { finish = resolve })
        })

        const running = receiveChannelMessage(state, inbound(first.transport))
        await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled())
        await receiveChannelMessage(state, inbound(followUp.transport, { text: 'Put it in the soups folder instead' }))

        expect(mocks.planExecution).toHaveBeenCalledOnce()
        expect(mocks.enqueueChat).toHaveBeenCalledWith('conversation', expect.objectContaining({
            content: 'Put it in the soups folder instead', delivery: 'steer',
        }))
        expect(resolveApproval).toHaveBeenCalledWith({ approved: false, reason: expect.stringContaining('follow-up') })
        expect(followUp.transport.react).toHaveBeenCalledWith('👀')
        expect(followUp.messages).toEqual([])
        await vi.waitFor(() => expect(first.messages[0]).toContain('Got your follow-up'))

        finish({ content: 'Moved it to soups.', images: [] })
        await running

        expect(first.messages).toEqual(['Moved it to soups.'])
        expect(followUp.transport.react).toHaveBeenLastCalledWith(null)
        expect(state.activeTurns.size).toBe(0)
    })

    test('a message after the turn finished starts a new turn', async () => {
        const state = makeState()
        const { transport } = makeTransport()
        mocks.run.mockResolvedValue({ content: 'ok', images: [] })

        await receiveChannelMessage(state, inbound(transport))
        await receiveChannelMessage(state, inbound(transport, { text: 'next' }))

        expect(mocks.planExecution).toHaveBeenCalledTimes(2)
        expect(mocks.enqueueChat).not.toHaveBeenCalled()
    })

    test('a voice note runs a turn on its own and is downloaded once', async () => {
        const state = makeState()
        const { transport, messages } = makeTransport()
        const extractMedia = vi.fn(async () => ({ imageDataUrls: [], audioDataUrls: ['data:audio/ogg;base64,AA'] }))
        mocks.run.mockResolvedValue({ content: 'heard you', images: [] })

        await receiveChannelMessage(state, inbound(transport, { text: '', hasMedia: true, extractMedia }))

        expect(extractMedia).toHaveBeenCalledOnce()
        expect(mocks.persistUser).toHaveBeenCalledWith(expect.objectContaining({
            content: '(voice message)', audio: ['data:audio/ogg;base64,AA'],
        }))
        expect(messages).toEqual(['heard you'])
    })
})
