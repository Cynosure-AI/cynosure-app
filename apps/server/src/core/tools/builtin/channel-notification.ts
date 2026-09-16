import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import type { ChannelType } from '../../channels/base.channel.js'
import { getChannelManager } from '../../channels/channel-manager.js'
import { resolveChannelTarget } from '../../triggers/channel-target-resolver.js'

export interface ChannelNotificationToolOptions {
    agentId: string
    availableChannels?: ChannelType[]
    notify?: (channel: ChannelType, message: string) => Promise<{ channelId: string; target: string }>
}

/** Create a manually-selectable tool for sending a proactive message to a configured channel. */
export function makeChannelNotificationTool(opts: ChannelNotificationToolOptions): ToolDefinition {
    const availableChannels = opts.availableChannels ?? getAvailableNotificationChannels(opts.agentId)
    return {
        name: 'notify_user_on_channel',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        description:
            'Send an immediate message to the user through an enabled messaging channel. The channel must be configured and must have a known recipient from an earlier conversation.',
        parameters: {
            type: 'object',
            properties: {
                channel: {
                    type: 'string',
                    enum: availableChannels,
                    description: 'Available configured messaging channel to use.'
                },
                message: {
                    type: 'string',
                    description: 'Message to send to the user.'
                }
            },
            required: ['channel', 'message']
        },
        timeout: 30_000,
        execute: async (params: unknown) => {
            const { channel, message } = params as { channel?: string; message?: string }
            if (!isChannelType(channel) || !availableChannels.includes(channel)) {
                const choices = availableChannels.length ? availableChannels.join(', ') : 'none'
                return { success: false, output: `channel must be one of the available configured channels: ${choices}` }
            }
            if (!message?.trim()) {
                return { success: false, output: 'message must not be empty' }
            }

            try {
                const delivered = await (opts.notify ?? ((type, text) => notify(type, text, opts.agentId)))(channel, message.trim())
                return {
                    success: true,
                    output: `Notification sent on ${channel} (channel ${delivered.channelId}).`
                }
            } catch (err) {
                return { success: false, output: (err as Error).message }
            }
        }
    }
}

/** Channels that are currently capable of delivering a notification for this agent. */
export function getAvailableNotificationChannels(agentId: string): ChannelType[] {
    const manager = getChannelManager()
    const types = new Set<ChannelType>()
    for (const channel of manager.listFromDb()) {
        if (!channel.enabled || !channelIsAvailableToAgent(channel, agentId)) continue
        if (!manager.getStatus(channel.id).connected || !resolveChannelTarget(channel.id)) continue
        types.add(channel.type)
    }
    return ['telegram', 'discord', 'slack'].filter((type): type is ChannelType => types.has(type as ChannelType))
}

function channelIsAvailableToAgent(channel: { agentId: string; config: Record<string, unknown> }, agentId: string): boolean {
    const allowed = channel.config.allowedAgentIds
    return channel.agentId === agentId || (Array.isArray(allowed) && allowed.includes(agentId))
}

function isChannelType(value: unknown): value is ChannelType {
    return value === 'telegram' || value === 'discord' || value === 'slack'
}

async function notify(channel: ChannelType, message: string, agentId: string): Promise<{ channelId: string; target: string }> {
    const manager = getChannelManager()
    const candidates = manager.listFromDb().filter((candidate) => {
        if (!candidate.enabled || candidate.type !== channel) return false
        return channelIsAvailableToAgent(candidate, agentId)
    })

    if (candidates.length === 0) {
        throw new Error(`No enabled ${channel} channel is configured for this agent.`)
    }

    for (const candidate of candidates) {
        const target = resolveChannelTarget(candidate.id)
        if (!target) continue
        if (await manager.queueNotification(candidate.id, target, message)) {
            return { channelId: candidate.id, target }
        }
    }

    throw new Error(`No known recipient is available on an enabled ${channel} channel for this agent.`)
}
