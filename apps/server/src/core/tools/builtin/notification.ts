import { createAppNotification } from '../../notifications/app-notifications.js'
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
            'Create an in-app notification for the user. Use this when you find something noteworthy, need the user to act, or want to schedule a reminder for a later time.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Short notification title (3-10 words)' },
                body: { type: 'string', description: 'Detailed notification body (1-3 sentences)' },
                priority: {
                    type: 'string',
                    enum: ['notice', 'action', 'alert'],
                    description: 'Intent-based priority: notice = passive information, action = user should do something, alert = important/immediate awareness.'
                },
                showAt: {
                    type: 'string',
                    description: 'Optional time to show the notification, as an ISO timestamp or epoch milliseconds. Omit to show immediately.'
                }
            },
            required: ['title', 'body']
        },
        timeout: 5_000,
        execute: async (params: unknown) => {
            const { title, body, priority, severity, showAt, scheduledAt } = params as {
                title: string
                body: string
                priority?: string
                severity?: string
                showAt?: string | number | null
                scheduledAt?: string | number | null
            }

            const notification = createAppNotification({
                agentId,
                conversationId,
                title,
                body,
                priority: priority ?? severity,
                showAt: showAt ?? scheduledAt,
                broadcast,
            })

            return {
                success: true,
                output: notification.scheduledAt
                    ? `Notification scheduled for ${new Date(notification.scheduledAt).toISOString()}: ${title}`
                    : `Notification created: ${title}`
            }
        }
    }
}
