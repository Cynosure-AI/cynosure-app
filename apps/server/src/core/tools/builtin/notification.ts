import { nanoid } from 'nanoid'
import { getDb } from '../../../db/database.js'
import type { ToolDefinition } from '../../gateway/providers/base.provider.js'

type BroadcastFn = (event: string, data: unknown) => void

export interface NotificationToolOptions {
    agentId: string
    conversationId: string
    broadcast: BroadcastFn
}

/**
 * Create a `create_app_notification` tool the LLM can call to alert the user.
 * Used during cron jobs and any autonomous agent run.
 */
export function makeNotificationTool(opts: NotificationToolOptions): ToolDefinition {
    const { agentId, conversationId, broadcast } = opts
    return {
        name: 'create_app_notification',
        description:
            'Create a notification for the user. Use this when you find something noteworthy — e.g. completed tasks, new findings, errors, or anything the user should be aware of.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Short notification title (3-10 words)' },
                body: { type: 'string', description: 'Detailed notification body (1-3 sentences)' },
                severity: { type: 'string', enum: ['info', 'warning', 'critical'], description: 'Notification severity level' }
            },
            required: ['title', 'body']
        },
        timeout: 5_000,
        execute: async (params: unknown) => {
            const { title, body, severity } = params as { title: string; body: string; severity?: string }
            const db = getDb()
            const id = nanoid()
            const now = Date.now()
            const sev = ['info', 'warning', 'critical'].includes(severity || '') ? severity! : 'info'

            db.prepare(
                `INSERT INTO notifications (id, agent_id, conversation_id, title, body, severity, read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
            ).run(id, agentId, conversationId, title, body, sev, now)

            broadcast('notification:created', { id, agentId, conversationId, title, body, severity: sev, read: false, createdAt: now })
            return { success: true, output: `Notification created: ${title}` }
        }
    }
}
