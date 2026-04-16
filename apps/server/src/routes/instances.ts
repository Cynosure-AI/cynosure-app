import type { FastifyInstance } from 'fastify'
import { getActiveCronRuns, cancelCronRun } from '../core/triggers/cron-scheduler.js'
import { getAgent } from '../core/agents/agent-files.js'
import { getActiveChatExecutions, cancelChatExecution } from './chat.js'
import { cancelPostActions } from '../core/agent/post-execution.js'
import { getHITLGate } from '../core/agent/hitl-gate.js'
import { getChannelManager } from '../core/channels/channel-manager.js'
import { getActiveWatcherRuns, cancelWatcherRun } from '../core/triggers/file-watcher.js'
import { getDb } from '../db/database.js'

export async function registerInstanceRoutes(app: FastifyInstance): Promise<void> {
    // GET /api/instances — list all actively running agent instances
    app.get('/', async () => {
        const db = getDb()
        const pendingHITLConversations = getHITLGate().getPendingConversationIds()
        const instances: {
            id: string
            type: 'chat' | 'multi-agent' | 'cron' | 'channel' | 'file-watcher'
            agentId: string
            agentName: string
            agentIconUrl: string | null
            model: string | null
            conversationId: string | null
            startedAt: number
            intervalMinutes: number
            status: 'running' | 'awaiting-approval'
        }[] = []

        // Active chat executions (user-initiated agent conversations)
        for (const exec of getActiveChatExecutions()) {
            const agent = exec.agentId ? getAgent(exec.agentId) : null
            instances.push({
                id: `chat-${exec.id}`,
                type: 'chat',
                agentId: exec.agentId || '',
                agentName: agent?.name || 'Default Agent',
                agentIconUrl: agent?.iconUrl || null,
                model: agent?.model || null,
                conversationId: exec.conversationId,
                startedAt: exec.startedAt,
                intervalMinutes: 0,
                status: pendingHITLConversations.has(exec.conversationId) ? 'awaiting-approval' : 'running'
            })
        }

        // Active cron runs
        for (const run of getActiveCronRuns()) {
            const agent = getAgent(run.agentId)
            instances.push({
                id: `cron-${run.jobId}`,
                type: 'cron',
                agentId: run.agentId,
                agentName: agent?.name || 'Unknown',
                agentIconUrl: agent?.iconUrl || null,
                model: agent?.model || null,
                conversationId: run.conversationId,
                startedAt: run.startedAt,
                intervalMinutes: 0,
                status: pendingHITLConversations.has(run.conversationId) ? 'awaiting-approval' : 'running'
            })
        }

        // Active channel executions (Telegram, etc.)
        for (const exec of getChannelManager().getActiveExecutions()) {
            const agent = getAgent(exec.agentId)
            instances.push({
                id: `channel-${exec.id}`,
                type: 'channel',
                agentId: exec.agentId,
                agentName: agent?.name || 'Unknown',
                agentIconUrl: agent?.iconUrl || null,
                model: agent?.model || null,
                conversationId: exec.conversationId,
                startedAt: exec.startedAt,
                intervalMinutes: 0,
                status: pendingHITLConversations.has(exec.conversationId) ? 'awaiting-approval' : 'running'
            })
        }

        // Active file-watcher runs
        for (const run of getActiveWatcherRuns()) {
            const agent = getAgent(run.agentId)
            instances.push({
                id: `file-watcher-${run.watcherId}`,
                type: 'file-watcher',
                agentId: run.agentId,
                agentName: agent?.name || 'Unknown',
                agentIconUrl: agent?.iconUrl || null,
                model: agent?.model || null,
                conversationId: run.conversationId,
                startedAt: run.startedAt,
                intervalMinutes: 0,
                status: pendingHITLConversations.has(run.conversationId) ? 'awaiting-approval' : 'running'
            })
        }

        return instances
    })

    // POST /api/instances/:id/stop — cancel a running instance
    app.post<{ Params: { id: string } }>('/:id/stop', async (req, reply) => {
        const { id } = req.params
        let cancelled = false

        if (id.startsWith('chat-')) {
            const executionId = id.slice(5)
            // Find the conversationId before cancelling (needed for post-actions)
            const execution = getActiveChatExecutions().find(e => e.id === executionId)
            cancelled = cancelChatExecution(executionId)
            if (execution) cancelPostActions(execution.conversationId)
        } else if (id.startsWith('cron-')) {
            const jobId = id.slice(5)
            cancelled = cancelCronRun(jobId)
        } else if (id.startsWith('channel-')) {
            const executionId = id.slice(8)
            cancelled = getChannelManager().cancelExecution(executionId)
        } else if (id.startsWith('file-watcher-')) {
            const watcherId = id.slice(13)
            cancelled = cancelWatcherRun(watcherId)
        }

        if (!cancelled) {
            return reply.status(404).send({ error: 'Instance not found or already finished' })
        }

        return { success: true }
    })
}
