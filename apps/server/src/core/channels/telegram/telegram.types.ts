import type { ActiveChannelExecution } from '../base.channel.js'

export const TELEGRAM_API = 'https://api.telegram.org'

export interface TelegramConfig {
    botToken: string
    allowedAgentIds?: string[]
}

export interface TelegramUpdate {
    update_id: number
    message?: {
        message_id: number
        from?: { id: number; first_name: string; last_name?: string; username?: string }
        chat: { id: number; type: string; title?: string; first_name?: string }
        date: number
        text?: string
        caption?: string
        photo?: { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }[]
        document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
        audio?: { file_id: string; file_name?: string; mime_type?: string; duration: number; file_size?: number }
        voice?: { file_id: string; mime_type?: string; duration: number; file_size?: number }
        video?: { file_id: string; file_name?: string; mime_type?: string; duration: number; width: number; height: number; file_size?: number }
        video_note?: { file_id: string; duration: number; length: number; file_size?: number }
    }
    callback_query?: {
        id: string
        from: { id: number; first_name: string }
        message?: { message_id: number; chat: { id: number } }
        data?: string
    }
}

export interface PendingHITL {
    chatId: number
    messageId: number
    resolve: (result: { approved: boolean; reason?: string }) => void
}

export type BroadcastFn = (event: string, data: unknown) => void

/** Shared state accessible by all telegram sub-modules */
export interface TelegramCtx {
    botToken: string
    agentId: string
    channelId: string
    broadcast: BroadcastFn
    allowedAgentIds: string[]
    activeExecutions: Map<string, { exec: ActiveChannelExecution; controller: AbortController }>
    chatAgentOverride: Map<number, string>
    chatLastUsedAgent: Map<number, string>
    pendingHITL: Map<string, PendingHITL>
    conversationToChat: Map<string, number>
    chatLocks: Map<number, Promise<void>>
    conversationSendQueue: Map<string, (fn: () => Promise<void>) => void>
    pendingAttachments: Map<number, { imageDataUrls: string[]; audioDataUrls: string[] }>
}
