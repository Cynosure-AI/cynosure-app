import { afterEach, describe, expect, test, vi } from 'vitest'

const planningMocks = vi.hoisted(() => ({ interrupt: vi.fn() }))
vi.mock('../agent/planning-state.js', () => ({
    interruptPlanningRun: planningMocks.interrupt,
}))

import {
    cancelChatExecution,
    cancelChatExecutionByConversation,
    listActiveChatExecutions,
    registerActiveChatExecution,
    unregisterActiveChatExecution,
    updateActiveChatExecution,
} from './active-executions.js'

describe('active chat execution lifecycle', () => {
    afterEach(() => {
        for (const execution of listActiveChatExecutions()) unregisterActiveChatExecution(execution.id)
        vi.clearAllMocks()
    })

    test('registers, updates, and unregisters execution metadata', () => {
        registerActiveChatExecution({
            id: 'execution', conversationId: 'conversation', agentId: null, model: null, startedAt: 10,
        }, new AbortController())
        updateActiveChatExecution('execution', { model: 'model', planningRunId: 'plan' })
        updateActiveChatExecution('missing', { model: 'ignored' })

        expect(listActiveChatExecutions()).toEqual([expect.objectContaining({
            id: 'execution', model: 'model', planningRunId: 'plan',
        })])
        unregisterActiveChatExecution('execution')
        expect(listActiveChatExecutions()).toEqual([])
    })

    test('cancels the controller and interrupts its visible planning run', () => {
        const controller = new AbortController()
        registerActiveChatExecution({
            id: 'execution', conversationId: 'conversation', agentId: null,
            model: 'model', planningRunId: 'plan', startedAt: 10,
        }, controller)

        expect(cancelChatExecution('execution')).toBe(true)
        expect(controller.signal.aborted).toBe(true)
        expect(planningMocks.interrupt).toHaveBeenCalledWith('plan', { error: 'Interrupted before completion.' })
        expect(cancelChatExecution('execution')).toBe(false)
    })

    test('finds a running execution by conversation', () => {
        const controller = new AbortController()
        registerActiveChatExecution({
            id: 'execution', conversationId: 'conversation', agentId: null, model: null, startedAt: 10,
        }, controller)

        expect(cancelChatExecutionByConversation('conversation')).toBe(true)
        expect(controller.signal.aborted).toBe(true)
        expect(cancelChatExecutionByConversation('missing')).toBe(false)
    })
})
