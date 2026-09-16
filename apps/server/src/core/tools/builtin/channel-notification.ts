import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import type { ChannelConfig, ChannelType } from '../../channels/base.channel.js'
import { getChannelManager } from '../../channels/channel-manager.js'
import { normalizeTelegramUserIds } from '../../channels/telegram/telegram.security.js'
import { resolveChannelTarget } from '../../triggers/channel-target-resolver.js'

export interface ChannelNotificationToolOptions {
    availableChannels?: ChannelType[]
    notify?: (channel: ChannelType, message: string) => Promise<{ channelId: string; target: string }>
}

/** Create a manually-selectable tool for sending a proactive message to a configured channel. */
export function makeChannelNotificationTool(opts: ChannelNotificationToolOptions): ToolDefinition {
    const staticChannels = opts.availableChannels
    const resolveChannels = (): ChannelType[] => staticChannels ?? getAvailableNotificationChannels()
    return {
        name: 'notify_user_on_channel',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        description:
            'Send an immediate message to the user through an enabled messaging channel. The channel must be connected and have a configured or previously active recipient.',
        parameters: {
            type: 'object',
            properties: {
                channel: {
                    type: 'string',
                    // Enum must always be non-empty: JSON Schema forbids `enum: []`
                    // (Ajv rejects the whole schema). When no channel is currently
                    // available, fall back to all known channel types so the schema
                    // stays valid — execute() enforces the real availability check.
                    enum: resolveChannels().length ? resolveChannels() : (['telegram', 'discord', 'slack'] as ChannelType[]),
                    description: 'Available configured messaging channel to use. If none of these are actually configured/connected, the tool will return an error explaining what is missing.'
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
            // Recompute availability at call time: channel connectivity can change
            // between tool hydration (start of the turn) and actual execution.
            const availableChannels = resolveChannels()
            if (!isChannelType(channel) || !availableChannels.includes(channel)) {
                const choices = availableChannels.length ? availableChannels.join(', ') : 'none'
                return { success: false, output: `channel must be one of the available configured channels: ${choices}.` }
            }
            if (!message?.trim()) {
                return { success: false, output: 'message must not be empty' }
            }

            try {
                const delivered = await (opts.notify ?? notify)(channel, message.trim())
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

/** Configured channels that are currently capable of delivering a notification. */
export function getAvailableNotificationChannels(): ChannelType[] {
    const manager = getChannelManager()
    const types = new Set<ChannelType>()
    for (const channel of manager.listFromDb()) {
        if (!channel.enabled) continue
        if (!manager.getStatus(channel.id).connected || !resolveNotificationTarget(channel)) continue
        types.add(channel.type)
    }
    return ['telegram', 'discord', 'slack'].filter((type): type is ChannelType => types.has(type as ChannelType))
}

function isChannelType(value: unknown): value is ChannelType {
    return value === 'telegram' || value === 'discord' || value === 'slack'
}

async function notify(channel: ChannelType, message: string): Promise<{ channelId: string; target: string }> {
    const manager = getChannelManager()
    const candidates = manager.listFromDb().filter((candidate) => {
        return candidate.enabled && candidate.type === channel
    })

    if (candidates.length === 0) {
        throw new Error(`No enabled ${channel} channel is configured.`)
    }

    for (const candidate of candidates) {
        const target = resolveNotificationTarget(candidate)
        if (!target) continue
        if (await manager.queueNotification(candidate.id, target, message)) {
            return { channelId: candidate.id, target }
        }
    }

    throw new Error(`No known recipient is available on an enabled ${channel} channel.`)
}

/** Prefer the most recently active recipient, then use Telegram's configured user allow-list. */
export function resolveNotificationTarget(channel: Pick<ChannelConfig, 'id' | 'type' | 'config'>): string | null {
    const recentTarget = resolveChannelTarget(channel.id)
    if (recentTarget) return recentTarget
    if (channel.type === 'telegram') {
        return normalizeTelegramUserIds(channel.config.allowedUserIds)[0] ?? null
    }
    return null
}
