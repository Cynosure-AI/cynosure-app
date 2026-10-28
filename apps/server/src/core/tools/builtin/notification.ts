import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import type { ChannelType } from '../../channels/base.channel.js'
import { getAvailableNotificationChannels, isNotificationChannelType, NOTIFICATION_CHANNEL_TYPES, notifyOnChannel } from './channel-notification.js'

export interface NotificationToolOptions {
    conversationId: string
    availableChannels?: ChannelType[]
    notify?: (channel: ChannelType, message: string, sourceConversationId?: string) => Promise<{ channelId: string; target: string }>
}

/** Notify the user through a connected messaging channel. Hydration hides the tool while none is connected. */
export function makeNotificationTool(opts: NotificationToolOptions): ToolDefinition {
    const resolveChannels = (): ChannelType[] => opts.availableChannels ?? getAvailableNotificationChannels()
    const availableChannels = resolveChannels()
    // The registry spec is built before channels connect; list every supported type there.
    const channelEnum = availableChannels.length > 0 ? availableChannels : [...NOTIFICATION_CHANNEL_TYPES]
    return {
        name: 'notify_user',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        description:
            `Send a notification to the user on a connected messaging channel, so it reaches them outside the app. Use it when something needs their attention or a background task finished. Available channels: ${channelEnum.join(', ')}. Availability is checked again when sending.`,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                title: { type: 'string', description: 'Short notification title (3-10 words)' },
                body: { type: 'string', description: 'Notification body (1-3 sentences)' },
                channel: {
                    type: 'string',
                    enum: channelEnum,
                    default: channelEnum[0],
                    description: `Delivery channel. Defaults to ${channelEnum[0]} when omitted.`,
                },
            },
            required: ['title', 'body'],
        },
        timeout: 30_000,
        execute: async (params: unknown) => {
            const input = params && typeof params === 'object' ? params as Record<string, unknown> : {}
            const title = typeof input.title === 'string' ? input.title.trim() : ''
            const body = typeof input.body === 'string' ? input.body.trim() : ''
            if (!title || !body) return { success: false, output: 'title and body must not be empty' }
            const connected = resolveChannels()
            if (connected.length === 0) return { success: false, output: 'No messaging channel is connected with a known recipient.' }
            const channel = input.channel === undefined ? connected[0] : input.channel
            if (!isNotificationChannelType(channel) || !connected.includes(channel)) {
                return { success: false, output: `channel must be one of the available channels: ${connected.join(', ')}.` }
            }
            try {
                const delivered = await (opts.notify ?? notifyOnChannel)(channel, `${title}\n\n${body}`, opts.conversationId)
                return { success: true, output: `Notification sent on ${channel} (channel ${delivered.channelId}).` }
            } catch (err) {
                return { success: false, output: (err as Error).message }
            }
        },
    }
}
