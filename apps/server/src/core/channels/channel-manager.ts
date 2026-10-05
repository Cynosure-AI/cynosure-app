import type { ChannelConfig, ChannelProvider, ChannelStatus, ChannelType, ActiveChannelExecution } from './base.channel.js'
import { TelegramChannel } from './telegram/telegram.channel.js'
import { DiscordChannel } from './discord/discord.channel.js'
import { SlackChannel } from './slack/slack.channel.js'
import { getDb } from '../../db/database.js'

type BroadcastFn = (event: string, data: unknown) => void

/** Singleton channel manager — manages lifecycle of all channel providers. */
class ChannelManager {
    private providers = new Map<string, ChannelProvider>()
    private broadcast: BroadcastFn = () => { }
    /** Per-channel notification queue — serialises proactive sends to avoid rate limits. */
    private notificationQueues = new Map<string, Promise<void>>()

    setBroadcast(fn: BroadcastFn): void {
        this.broadcast = fn
    }

    /** Load and start all enabled channels from the database. */
    async loadAll(): Promise<void> {
        const channels = this.listFromDb()
        for (const channel of channels) {
            if (channel.enabled) {
                await this.startChannel(channel)
            }
        }
    }

    /** Start a specific channel by its config. */
    async startChannel(channel: ChannelConfig): Promise<void> {
        // Stop existing instance if running
        await this.stopChannel(channel.id)

        const provider = this.createProvider(channel)
        if (!provider) return

        this.providers.set(channel.id, provider)
        try {
            await provider.start()
        } catch (err) {
            console.error(`[ChannelManager] Failed to start channel ${channel.name}: ${(err as Error).message}`)
        }
    }

    /** Stop a channel by ID. */
    async stopChannel(id: string): Promise<void> {
        const provider = this.providers.get(id)
        if (provider) {
            await provider.stop()
            this.providers.delete(id)
        }
    }

    /** Stop all channels. */
    async stopAll(): Promise<void> {
        // Let already-accepted proactive messages settle while their providers
        // are still connected. New sends cannot be created once cron shutdown
        // has completed.
        await Promise.allSettled(Array.from(this.notificationQueues.values()))
        for (const [id] of this.providers) {
            await this.stopChannel(id)
        }
    }

    /** Get the runtime status of a channel. */
    getStatus(id: string): ChannelStatus {
        const provider = this.providers.get(id)
        if (!provider) return { connected: false }
        return provider.status()
    }

    /** Test a channel config without starting it permanently. */
    async testChannel(channel: ChannelConfig): Promise<{ success: boolean; username?: string; error?: string }> {
        const provider = this.createProvider(channel)
        if (!provider) return { success: false, error: 'Unknown channel type' }
        return provider.test()
    }

    /** Return all active executions across all channels. */
    getActiveExecutions(): ActiveChannelExecution[] {
        const results: ActiveChannelExecution[] = []
        for (const provider of this.providers.values()) {
            results.push(...provider.getActiveExecutions())
        }
        return results
    }

    /** Cancel a channel execution by its ID. */
    cancelExecution(executionId: string): boolean {
        for (const provider of this.providers.values()) {
            if (provider.cancelExecution(executionId)) return true
        }
        return false
    }

    /** Cancel active agent executions without disconnecting their channels. */
    cancelAllExecutions(): number {
        let cancelled = 0
        for (const execution of this.getActiveExecutions()) {
            if (this.cancelExecution(execution.id)) cancelled++
        }
        return cancelled
    }

    /** Cancel channel executions when the UI only knows the conversation ID
     * (notably during pre-execution, before the stream-start event publishes a stream ID). */
    cancelExecutionByConversation(conversationId: string): boolean {
        let cancelled = false
        for (const provider of this.providers.values()) {
            for (const execution of provider.getActiveExecutions()) {
                if (execution.conversationId !== conversationId) continue
                cancelled = provider.cancelExecution(execution.id) || cancelled
            }
        }
        return cancelled
    }

    /** Re-register platform commands on all running channels (e.g. after agent rename). */
    async refreshAllCommands(): Promise<void> {
        for (const provider of this.providers.values()) {
            provider.refreshCommands?.().catch(() => { })
        }
    }

    /**
     * Queue a proactive notification to a specific target within a channel.
     * Notifications for the same channel are serialised to avoid rate-limit issues.
     * @param channelId  The channel DB id.
     * @param target     Platform-specific target (Telegram chat ID, Discord/Slack channel ID).
     * @param text       Message text to send.
     */
    queueNotification(channelId: string, target: string, text: string): Promise<boolean> {
        const provider = this.providers.get(channelId)
        if (!provider) {
            console.warn(`[ChannelManager] Cannot send notification for channel ${channelId}: channel is not running`)
            return Promise.resolve(false)
        }
        if (!provider.sendNotification) {
            console.warn(`[ChannelManager] Cannot send notification for channel ${channelId}: provider does not support notifications`)
            return Promise.resolve(false)
        }

        const prev = this.notificationQueues.get(channelId) ?? Promise.resolve()
        const next = prev
            .then(() => provider.sendNotification!(target, text))
            .catch((err) => {
                console.error(`[ChannelManager] Notification failed for channel ${channelId}: ${(err as Error).message}`)
                throw err
            })
        // Store a settled chain so one delivery failure does not poison later
        // notifications for the channel.
        this.notificationQueues.set(channelId, next.catch(() => undefined))
        // Clean up the queue entry once the chain settles
        const settled = this.notificationQueues.get(channelId)!
        void settled.then(() => {
            if (this.notificationQueues.get(channelId) === settled) {
                this.notificationQueues.delete(channelId)
            }
        })
        return next.then(() => true, () => false)
    }

    // ─── DB helpers ───────────────────────────────────────────

    listFromDb(): ChannelConfig[] {
        const db = getDb()
        const rows = db.prepare('SELECT * FROM channels ORDER BY created_at DESC').all() as {
            id: string; name: string; type: string; agent_id: string; config_json: string
            enabled: number; created_at: number; updated_at: number
        }[]
        return rows.map(rowToConfig)
    }

    getFromDb(id: string): ChannelConfig | null {
        const db = getDb()
        const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as {
            id: string; name: string; type: string; agent_id: string; config_json: string
            enabled: number; created_at: number; updated_at: number
        } | undefined
        return row ? rowToConfig(row) : null
    }

    // ─── Private ──────────────────────────────────────────────

    private createProvider(channel: ChannelConfig): ChannelProvider | null {
        switch (channel.type) {
            case 'telegram':
                return new TelegramChannel(
                    channel.id,
                    channel.agentId,
                    channel.config as { botToken: string; allowedAgentIds?: string[]; allowedUserIds?: Array<string | number> },
                    this.broadcast
                )
            case 'discord':
                return new DiscordChannel(
                    channel.id,
                    channel.agentId,
                    channel.config as { botToken: string; allowedAgentIds?: string[]; allowedUserIds?: string[] },
                    this.broadcast
                )
            case 'slack':
                return new SlackChannel(
                    channel.id,
                    channel.agentId,
                    channel.config as { botToken: string; appToken: string; allowedAgentIds?: string[] },
                    this.broadcast
                )
            default:
                console.error(`[ChannelManager] Unknown channel type: ${channel.type}`)
                return null
        }
    }
}

function rowToConfig(row: {
    id: string; name: string; type: string; agent_id: string; config_json: string
    enabled: number; created_at: number; updated_at: number
}): ChannelConfig {
    return {
        id: row.id,
        name: row.name,
        type: row.type as ChannelType,
        agentId: row.agent_id,
        config: JSON.parse(row.config_json),
        enabled: row.enabled === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

// ─── Singleton ────────────────────────────────────────────

let manager: ChannelManager | null = null

export function getChannelManager(): ChannelManager {
    if (!manager) {
        manager = new ChannelManager()
    }
    return manager
}
