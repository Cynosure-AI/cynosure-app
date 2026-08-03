import type { ActiveChannelExecutionEntry } from '../base.channel.js'
import type { Client } from 'discord.js'

export const DISCORD_API_BASE = 'https://discord.com/api'

export interface DiscordConfig {
    botToken: string
    allowedAgentIds?: string[]
}

export type BroadcastFn = (event: string, data: unknown) => void

export interface PendingHITL {
    conversationId: string
    discordChannelId: string
    messageId: string
    resolve: (result: { approved: boolean; reason?: string }) => void
}

export interface DiscordCtx {
    client: Client
    botToken: string
    agentId: string
    channelId: string
    broadcast: BroadcastFn
    allowedAgentIds: string[]
    activeExecutions: Map<string, ActiveChannelExecutionEntry>
    channelAgentOverride: Map<string, string>
    channelLastUsedAgent: Map<string, string>
    pendingHITL: Map<string, PendingHITL>
    conversationToChannel: Map<string, string>
    channelLocks: Map<string, Promise<void>>
    conversationSendQueue: Map<string, (fn: () => Promise<void>) => void>
    pendingAttachments: Map<string, { imageDataUrls: string[]; audioDataUrls: string[] }>
}
