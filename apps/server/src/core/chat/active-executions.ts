import { interruptPlanningRun } from '../agent/planning-state.js'
import { getEventBus } from '../telemetry/event-bus.js'
import type { ChatEventDraft } from '@shared/types'

export interface ActiveChatExecution {
    id: string
    conversationId: string
    agentId: string | null
    model: string | null
    planningRunId?: string
    startedAt: number
}

const activeChatExecutions = new Map<string, ActiveChatExecution>()
const activeAbortControllers = new Map<string, AbortController>()

function emitExecutionState(execution: ActiveChatExecution, state: 'running' | 'stopped' | 'finished'): void {
    getEventBus().emit('chat:event', {
        conversationId: execution.conversationId,
        executionId: execution.id,
        payload: { type: 'execution-state', agentId: execution.agentId, state },
    } satisfies ChatEventDraft)
}

export function listActiveChatExecutions(): ActiveChatExecution[] {
    return Array.from(activeChatExecutions.values()).filter((execution) =>
        activeAbortControllers.get(execution.id)?.signal.aborted !== true
    )
}

export function getChatExecutionIdsByConversation(conversationId: string): string[] {
    return Array.from(activeChatExecutions.values())
        .filter((execution) => execution.conversationId === conversationId)
        .map((execution) => execution.id)
}

export function registerActiveChatExecution(execution: ActiveChatExecution, controller: AbortController): void {
    activeChatExecutions.set(execution.id, execution)
    activeAbortControllers.set(execution.id, controller)
    emitExecutionState(execution, 'running')
}

export function unregisterActiveChatExecution(executionId: string): void {
    const execution = activeChatExecutions.get(executionId)
    const controller = activeAbortControllers.get(executionId)
    activeAbortControllers.delete(executionId)
    activeChatExecutions.delete(executionId)
    if (execution && controller && !controller.signal.aborted) {
        emitExecutionState(execution, 'finished')
    }
}

export function updateActiveChatExecution(executionId: string, patch: Partial<Pick<ActiveChatExecution, 'model' | 'planningRunId'>>): void {
    const execution = activeChatExecutions.get(executionId)
    if (!execution) return
    activeChatExecutions.set(executionId, { ...execution, ...patch })
}

export function cancelChatExecution(executionId: string): boolean {
    const controller = activeAbortControllers.get(executionId)
    if (!controller) return false
    if (controller.signal.aborted) return true

    const execution = activeChatExecutions.get(executionId)
    if (execution?.planningRunId) {
        interruptPlanningRun(execution.planningRunId, { error: 'Interrupted before completion.' })
    }
    controller.abort()
    // Keep the aborted controller registered until the request stack has fully
    // unwound. This makes cancellation a durable execution-generation barrier:
    // repeated Stop requests remain idempotent and no continuation can lose the
    // authoritative aborted signal while asynchronous work settles.
    if (execution) {
        emitExecutionState(execution, 'stopped')
    }
    return true
}

export function cancelChatExecutionByConversation(conversationId: string): boolean {
    const executionIds = Array.from(activeChatExecutions.values())
        .filter((execution) => execution.conversationId === conversationId)
        .map((execution) => execution.id)
    let cancelled = false
    for (const executionId of executionIds) {
        cancelled = cancelChatExecution(executionId) || cancelled
    }
    return cancelled
}
