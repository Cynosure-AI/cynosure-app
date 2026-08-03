import type { ActiveChannelExecutionEntry } from '../base.channel.js'
import type { App } from '@slack/bolt'

export interface SlackConfig {
    botToken: string
    appToken: string
    allowedAgentIds?: string[]
}

export type BroadcastFn = (event: string, data: unknown) => void

export interface PendingHITL {
    conversationId: string
    slackChannelId: string
    messageTs: string
    resolve: (result: { approved: boolean; reason?: string }) => void
}

export interface SlackCtx {
    app: App
    botToken: string
    appToken: string
    agentId: string
    channelId: string
    broadcast: BroadcastFn
    allowedAgentIds: string[]
    botUserId?: string
    activeExecutions: Map<string, ActiveChannelExecutionEntry>
    channelAgentOverride: Map<string, string>
    channelLastUsedAgent: Map<string, string>
    pendingHITL: Map<string, PendingHITL>
    conversationToChannel: Map<string, string>
    channelLocks: Map<string, Promise<void>>
    conversationSendQueue: Map<string, (fn: () => Promise<void>) => void>
    pendingAttachments: Map<string, { imageDataUrls: string[]; audioDataUrls: string[] }>
}
