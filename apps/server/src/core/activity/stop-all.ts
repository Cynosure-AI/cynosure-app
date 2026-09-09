import { cancelPostActions, getAllActiveActions } from '../agent/post-execution.js'
import { cancelChatExecution, listActiveChatExecutions } from '../chat/active-executions.js'
import { getChannelManager } from '../channels/channel-manager.js'
import { cancelAllMemoryIndexJobs } from '../memory/memory-index-jobs.js'
import { cancelActiveMemoryReembedding } from '../memory/reembedding-operation.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { cancelAllCronRuns } from '../triggers/cron-scheduler.js'

export interface StopAllActivityCounts {
    chats: number
    cronRuns: number
    channelRuns: number
    memoryJobs: number
    memoryReembedding: number
    postActions: number
}

export interface StopAllActivityResult {
    success: true
    total: number
    counts: StopAllActivityCounts
}

/** Cancel current agent work while leaving cron schedules and channel connections enabled. */
export function stopAllActiveExecutions(): Pick<StopAllActivityCounts, 'chats' | 'cronRuns' | 'channelRuns'> {
    let chats = 0
    for (const execution of listActiveChatExecutions()) {
        getEventBus().emit('hitl:clear-conversation', { conversationId: execution.conversationId })
        if (cancelChatExecution(execution.id)) chats++
        cancelPostActions(execution.conversationId)
    }

    return {
        chats,
        cronRuns: cancelAllCronRuns(),
        channelRuns: getChannelManager().cancelAllExecutions(),
    }
}

/** Stop every kind of cancellable work shown on the Activity page. */
export function stopAllActivity(): StopAllActivityResult {
    const instances = stopAllActiveExecutions()
    const memoryJobs = cancelAllMemoryIndexJobs()
    const memoryReembedding = cancelActiveMemoryReembedding() ? 1 : 0
    let postActions = 0
    for (const conversationId of Object.keys(getAllActiveActions())) {
        if (cancelPostActions(conversationId)) postActions++
    }

    const counts = { ...instances, memoryJobs, memoryReembedding, postActions }
    return {
        success: true,
        total: Object.values(counts).reduce((sum, count) => sum + count, 0),
        counts,
    }
}
