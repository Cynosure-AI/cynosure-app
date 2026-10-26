import { afterEach, describe, expect, test, vi } from 'vitest'
import { getEventBus } from '../telemetry/event-bus.js'
import { describeChannelApproval, subscribeChannelHITL, type ChannelHITLRequest, type ChannelSessionState } from './channel-session.js'

const request = (overrides: Partial<ChannelHITLRequest> = {}): ChannelHITLRequest => ({
    taskId: 'approval', conversationId: 'conversation', resolve: vi.fn(),
    toolCalls: [{ id: 'call', function: { name: 'file_write', arguments: JSON.stringify({ path: '/recipes/muffins.md', content: 'Private file contents' }) } }],
    ...overrides,
})

describe('channel approvals', () => {
    afterEach(() => getEventBus().removeAllListeners())

    test('shows actions and targets without exposing payloads', () => {
        const text = describeChannelApproval(request())
        expect(text).toContain('file write')
        expect(text).toContain('/recipes/muffins.md')
        expect(text).not.toContain('Private file contents')
    })

    test('handles malformed arguments, provider titles and large batches', () => {
        const calls = Array.from({ length: 9 }, (_, i) => ({ id: String(i),
            function: { name: 'some_tool', arguments: '{invalid' }, annotations: { title: 'Useful action' } }))
        const text = describeChannelApproval(request({ toolCalls: calls }))
        expect(text).toContain('Useful action')
        expect(text).toContain('3 more actions')
        expect(text).toContain('Review the full request in Cynosure')
    })

    function setup() {
        const queue: Array<() => Promise<void>> = []
        const state = {
            conversationTargets: new Map([['conversation', 'target']]),
            conversationSendQueue: new Map([['conversation', (fn: () => Promise<void>) => queue.push(fn)]]),
        } as unknown as ChannelSessionState<string>
        const send = vi.fn(async () => {})
        const settled = vi.fn(async () => {})
        const unsubscribe = subscribeChannelHITL(state, send, settled)
        return { queue, send, settled, unsubscribe, bus: getEventBus() }
    }

    test('retires buttons when answered elsewhere, and ignores other conversations', async () => {
        const { queue, send, settled, unsubscribe, bus } = setup()
        bus.emit('hitl:request', request({ conversationId: 'other' }))
        bus.emit('hitl:request', request())
        await queue[0]()
        expect(send).toHaveBeenCalledOnce()
        bus.emit('hitl:resolved', { taskId: 'approval' })
        expect(settled).toHaveBeenCalledWith('approval', false)
        unsubscribe()
        bus.emit('hitl:request', request())
        expect(queue).toHaveLength(1)
    })

    test('does not deliver an approval cancelled while queued', async () => {
        const { queue, send, settled, bus } = setup()
        bus.emit('hitl:request', request())
        bus.emit('hitl:cancel-request', { taskId: 'approval' })
        await queue[0]()
        expect(send).not.toHaveBeenCalled()
        expect(settled).toHaveBeenCalledWith('approval', true)
    })

    test('cancelling a conversation retires its pending approvals', async () => {
        const { queue, settled, bus } = setup()
        bus.emit('hitl:request', request())
        await queue[0]()
        bus.emit('hitl:clear-conversation', { conversationId: 'conversation' })
        expect(settled).toHaveBeenCalledWith('approval', true)
    })

    test('retires a prompt if the request ends while the platform is sending it', async () => {
        const { queue, send, settled, bus } = setup()
        let finishSend!: () => void
        send.mockImplementation(() => new Promise<void>(resolve => { finishSend = resolve }))
        bus.emit('hitl:request', request())
        const delivery = queue[0]()
        bus.emit('hitl:resolved', { taskId: 'approval' })
        finishSend()
        await delivery
        expect(settled).toHaveBeenCalledTimes(2)
    })
})
