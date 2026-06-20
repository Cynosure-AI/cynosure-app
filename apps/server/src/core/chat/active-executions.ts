import { interruptPlanningRun } from '../agent/planning-state.js'

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

export function listActiveChatExecutions(): ActiveChatExecution[] {
    return Array.from(activeChatExecutions.values())
}

export function registerActiveChatExecution(execution: ActiveChatExecution, controller: AbortController): void {
    activeChatExecutions.set(execution.id, execution)
    activeAbortControllers.set(execution.id, controller)
}

export function unregisterActiveChatExecution(executionId: string): void {
    activeAbortControllers.delete(executionId)
    activeChatExecutions.delete(executionId)
}

export function updateActiveChatExecution(executionId: string, patch: Partial<Pick<ActiveChatExecution, 'model' | 'planningRunId'>>): void {
    const execution = activeChatExecutions.get(executionId)
    if (!execution) return
    activeChatExecutions.set(executionId, { ...execution, ...patch })
}

export function cancelChatExecution(executionId: string): boolean {
    const controller = activeAbortControllers.get(executionId)
    if (!controller) return false

    const execution = activeChatExecutions.get(executionId)
    if (execution?.planningRunId) {
        interruptPlanningRun(execution.planningRunId, { error: 'Interrupted before completion.' })
    }
    controller.abort()
    activeAbortControllers.delete(executionId)
    return true
}

export function cancelChatExecutionByConversation(conversationId: string): boolean {
    for (const [executionId, execution] of activeChatExecutions) {
        if (execution.conversationId === conversationId) {
            return cancelChatExecution(executionId)
        }
    }
    return false
}
