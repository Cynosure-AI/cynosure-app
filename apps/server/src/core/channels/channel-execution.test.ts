import { afterEach, describe, expect, test, vi } from 'vitest'
import { getEventBus } from '../telemetry/event-bus.js'
import type { AgentData } from '../agents/agent-store.js'
import type { ActiveChannelExecutionEntry } from './base.channel.js'
import {
    beginChannelExecution,
    cancelChannelExecutionsWhere,
    finishChannelExecution,
} from './channel-execution.js'

function entry(id: string, conversationId: string): ActiveChannelExecutionEntry {
    return {
        exec: {
            id,
            channelId: 'provider',
            agentId: 'agent',
            conversationId,
            model: 'model',
            startedAt: Date.now(),
        },
        controller: new AbortController(),
    }
}

describe('channel execution lifecycle', () => {
    afterEach(() => getEventBus().removeAllListeners())

    test('registers before work and announces discovery metadata', () => {
        const executions = new Map<string, ActiveChannelExecutionEntry>()
        const broadcast = vi.fn()
        const agent = { id: 'agent', model: 'model' } as AgentData

        const started = beginChannelExecution({
            executions,
            channelId: 'provider',
            agent,
            conversationId: 'conversation',
            broadcast,
        })

        expect(executions.get(started.streamId)?.controller).toBe(started.controller)
        expect(broadcast).toHaveBeenCalledWith('channel:conversation-state', {
            conversationId: 'conversation',
            agentId: 'agent',
            running: true,
        })
    })

    test('cancels only matching executions and retains them until final cleanup', () => {
        const first = entry('first', 'conversation-a')
        const second = entry('second', 'conversation-b')
        const executions = new Map([
            ['first', first],
            ['second', second],
        ])
        const cleared: string[] = []
        getEventBus().on('hitl:clear-conversation', (data) => {
            cleared.push((data as { conversationId: string }).conversationId)
        })

        const count = cancelChannelExecutionsWhere(
            executions,
            ({ exec }) => exec.conversationId === 'conversation-a',
        )

        expect(count).toBe(1)
        expect(first.controller.signal.aborted).toBe(true)
        expect(second.controller.signal.aborted).toBe(false)
        expect(executions.has('first')).toBe(true)
        expect(cleared).toEqual(['conversation-a'])
    })

    test('removes the execution and announces completion only in finally', () => {
        const executions = new Map([['first', entry('first', 'conversation-a')]])
        const broadcast = vi.fn()

        finishChannelExecution({
            executions,
            executionId: 'first',
            conversationId: 'conversation-a',
            agentId: 'agent',
            broadcast,
        })

        expect(executions.size).toBe(0)
        expect(broadcast).toHaveBeenCalledWith('channel:conversation-state', {
            conversationId: 'conversation-a',
            agentId: 'agent',
            running: false,
        })
    })
})
