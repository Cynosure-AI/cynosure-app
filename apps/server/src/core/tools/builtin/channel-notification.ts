import type { ChannelConfig, ChannelType } from '../../channels/base.channel.js'
import { getChannelManager } from '../../channels/channel-manager.js'
import { normalizeTelegramUserIds } from '../../channels/telegram/telegram.security.js'
import { resolveChannelTarget } from '../../triggers/channel-target-resolver.js'

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

export function isNotificationChannelType(value: unknown): value is ChannelType {
    return value === 'telegram' || value === 'discord' || value === 'slack'
}

export async function notifyOnChannel(channel: ChannelType, message: string): Promise<{ channelId: string; target: string }> {
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
