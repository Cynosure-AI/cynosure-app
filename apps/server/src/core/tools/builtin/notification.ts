import { createAppNotification } from '../../notifications/app-notifications.js'
import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import type { ChannelType } from '../../channels/base.channel.js'
import { getAvailableNotificationChannels, isNotificationChannelType, notifyOnChannel } from './channel-notification.js'

type BroadcastFn = (event: string, data: unknown) => void

export interface NotificationToolOptions {
    agentId: string
    conversationId: string
    broadcast: BroadcastFn
    availableChannels?: ChannelType[]
    notify?: (channel: ChannelType, message: string) => Promise<{ channelId: string; target: string }>
}

/** Notify the user in the app by default, or through a configured messaging channel. */
export function makeNotificationTool(opts: NotificationToolOptions): ToolDefinition {
    const resolveChannels = (): ChannelType[] => opts.availableChannels ?? getAvailableNotificationChannels()
    const availableChannels = ['app', ...resolveChannels()]
    return {
        name: 'notify_user',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        description:
            `Send an immediate notification to the user. The app is always available and is the default channel. Available channels: ${availableChannels.join(', ')}. Messaging channels must be connected and have a known recipient; availability is checked again when sending.`,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                title: { type: 'string', description: 'Short notification title (3-10 words)' },
                body: { type: 'string', description: 'Notification body (1-3 sentences)' },
                channel: {
                    type: 'string',
                    enum: availableChannels,
                    default: 'app',
                    description: 'Delivery channel. Defaults to app when omitted.',
                },
            },
            required: ['title', 'body'],
        },
        timeout: 30_000,
        execute: async (params: unknown) => {
            const input = params && typeof params === 'object' ? params as Record<string, unknown> : {}
            const channel = input.channel === undefined ? 'app' : input.channel
            const title = typeof input.title === 'string' ? input.title.trim() : ''
            const body = typeof input.body === 'string' ? input.body.trim() : ''
            if (!title || !body) return { success: false, output: 'title and body must not be empty' }
            if (channel !== 'app' && (!isNotificationChannelType(channel) || !resolveChannels().includes(channel))) {
                return { success: false, output: `channel must be one of the available channels: ${['app', ...resolveChannels()].join(', ')}.` }
            }
            try {
                if (channel === 'app') {
                    createAppNotification({
                        agentId: opts.agentId,
                        conversationId: opts.conversationId,
                        title,
                        body,
                        broadcast: opts.broadcast,
                    })
                    return { success: true, output: `Notification created in app: ${title}` }
                }
                const delivered = await (opts.notify ?? notifyOnChannel)(channel as ChannelType, `${title}\n\n${body}`)
                return { success: true, output: `Notification sent on ${channel} (channel ${delivered.channelId}).` }
            } catch (err) {
                return { success: false, output: (err as Error).message }
            }
        },
    }
}
