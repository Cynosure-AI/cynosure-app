import { createAppNotification } from '../../notifications/app-notifications.js'
import type { ToolDefinition } from '../../gateway/providers/base.provider.js'

type BroadcastFn = (event: string, data: unknown) => void

export interface NotificationToolOptions {
    agentId: string
    conversationId: string
    broadcast: BroadcastFn
}

/**
 * Create a `notify_user_in_app` tool the LLM can call to alert the user.
 * Used during cron jobs and any autonomous agent run.
 */
export function makeNotificationTool(opts: NotificationToolOptions): ToolDefinition {
    const { agentId, conversationId, broadcast } = opts
    return {
        name: 'notify_user_in_app',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description:
            'Create an immediate in-app notification for the user. Use this when you find something noteworthy, need the user to act, or need important/immediate awareness.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Short notification title (3-10 words)' },
                body: { type: 'string', description: 'Detailed notification body (1-3 sentences)' },
                priority: {
                    type: 'string',
                    enum: ['notice', 'action', 'alert'],
                    description: 'Intent-based priority: notice = passive information, action = user should do something, alert = important/immediate awareness.'
                }
            },
            required: ['title', 'body']
        },
        timeout: 5_000,
        execute: async (params: unknown) => {
            const { title, body, priority, severity } = params as {
                title: string
                body: string
                priority?: string
                severity?: string
            }

            createAppNotification({
                agentId,
                conversationId,
                title,
                body,
                priority: priority ?? severity,
                broadcast,
            })

            return {
                success: true,
                output: `Notification created: ${title}`
            }
        }
    }
}
