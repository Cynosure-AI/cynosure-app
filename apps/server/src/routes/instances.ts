import type { FastifyInstance } from 'fastify'
import { getActiveCronRuns, cancelCronRun } from '../core/triggers/cron-scheduler.js'
import { getAgent } from '../core/agents/agent-store.js'
import { cancelChatExecution, listActiveChatExecutions } from '../core/chat/active-executions.js'
import { cancelPostActions } from '../core/agent/post-execution.js'
import { getHITLGate } from '../core/agent/hitl-gate.js'
import { getChannelManager } from '../core/channels/channel-manager.js'
import { getEventBus } from '../core/telemetry/event-bus.js'

type InstanceType = 'chat' | 'multi-agent' | 'cron' | 'channel'

const INSTANCE_ID_PREFIXES = {
    chat: 'chat-',
    'multi-agent': 'multi-agent-',
    cron: 'cron-',
    channel: 'channel-',
} as const satisfies Record<InstanceType, string>

interface ActiveInstance {
    id: string
    type: InstanceType
    agentId: string
    agentName: string
    agentIconUrl: string | null
    model: string | null
    conversationId: string | null
    startedAt: number
    intervalMinutes: number
    status: 'running' | 'awaiting-approval'
}

function instanceId(type: InstanceType, id: string): string {
    return `${INSTANCE_ID_PREFIXES[type]}${id}`
}

function parseInstanceId(value: string): { type: InstanceType; id: string } | undefined {
    for (const [type, prefix] of Object.entries(INSTANCE_ID_PREFIXES) as Array<[InstanceType, string]>) {
        if (value.startsWith(prefix)) {
            return { type, id: value.slice(prefix.length) }
        }
    }
    return undefined
}

function clearPendingHITLForConversation(conversationId: string): void {
    getEventBus().emit('hitl:clear-conversation', { conversationId })
}

export async function registerInstanceRoutes(app: FastifyInstance): Promise<void> {
    // GET /api/instances — list all actively running agent instances
    app.get('/', async () => {
        const pendingHITLConversations = getHITLGate().getPendingConversationIds()
        const instances: ActiveInstance[] = []

        // Active chat executions (user-initiated agent conversations)
        for (const exec of listActiveChatExecutions()) {
            const agent = exec.agentId ? getAgent(exec.agentId) : null
            instances.push({
                id: instanceId('chat', exec.id),
                type: 'chat',
                agentId: exec.agentId || '',
                agentName: agent?.name || 'Default Agent',
                agentIconUrl: agent?.iconUrl || null,
                model: exec.model || agent?.model || null,
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
                id: instanceId('cron', run.jobId),
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
                id: instanceId('channel', exec.id),
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

        return instances
    })

    // POST /api/instances/:id/stop — cancel a running instance
    app.post<{ Params: { id: string } }>('/:id/stop', async (req, reply) => {
        const { id } = req.params
        const parsed = parseInstanceId(id)
        let cancelled = false

        if (parsed?.type === 'chat') {
            const executionId = parsed.id
            // Find the conversationId before cancelling (needed for post-actions)
            const execution = listActiveChatExecutions().find(e => e.id === executionId)
            if (execution) clearPendingHITLForConversation(execution.conversationId)
            cancelled = cancelChatExecution(executionId)
            if (execution) cancelPostActions(execution.conversationId)
        } else if (parsed?.type === 'cron') {
            cancelled = cancelCronRun(parsed.id)
        } else if (parsed?.type === 'channel') {
            cancelled = getChannelManager().cancelExecution(parsed.id)
        }

        if (!cancelled) {
            return reply.status(404).send({ error: 'Instance not found or already finished' })
        }

        return { success: true }
    })
}
