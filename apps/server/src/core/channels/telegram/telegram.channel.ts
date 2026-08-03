import type { ChannelProvider, ChannelStatus, ActiveChannelExecution, ActiveChannelExecutionEntry } from '../base.channel.js'
import { cancelChannelExecution, cancelChannelExecutionsWhere } from '../channel-execution.js'
import type { TelegramConfig, TelegramUpdate, PendingHITL, BroadcastFn } from './telegram.types.js'
import { TELEGRAM_API } from './telegram.types.js'
import { registerBotCommands } from './telegram.commands.js'
import { handleMessage, handleCallbackQuery, subscribeToHITL } from './telegram.messaging.js'
import { sendLongMessage } from './telegram.api.js'
import { isTelegramUserAllowed, normalizeTelegramUserIds } from './telegram.security.js'

export class TelegramChannel implements ChannelProvider {
    botToken: string
    agentId: string
    channelId: string
    broadcast: BroadcastFn
    allowedAgentIds: string[]
    allowedUserIds: ReadonlySet<string>
    activeExecutions = new Map<string, ActiveChannelExecutionEntry>()
    chatAgentOverride = new Map<number, string>()
    chatLastUsedAgent = new Map<number, string>()
    pendingHITL = new Map<string, PendingHITL>()
    conversationToChat = new Map<string, number>()
    conversationToUser = new Map<string, number>()
    chatLocks = new Map<number, Promise<void>>()
    conversationSendQueue = new Map<string, (fn: () => Promise<void>) => void>()
    pendingAttachments = new Map<number, { imageDataUrls: string[]; audioDataUrls: string[] }>()

    private polling = false
    private pollTimer: ReturnType<typeof setTimeout> | null = null
    private lastUpdateId = 0
    private connected = false
    private errorMsg?: string
    private botUsername?: string
    private abortController: AbortController | null = null
    private hitlUnsub?: () => void

    constructor(
        channelId: string,
        agentId: string,
        config: TelegramConfig,
        broadcast: BroadcastFn
    ) {
        this.channelId = channelId
        this.agentId = agentId
        this.botToken = config.botToken
        this.broadcast = broadcast
        this.allowedAgentIds = config.allowedAgentIds ?? []
        this.allowedUserIds = new Set(normalizeTelegramUserIds(config.allowedUserIds))
    }

    async start(): Promise<void> {
        if (this.allowedUserIds.size === 0) {
            this.connected = false
            this.errorMsg = 'Telegram access is locked: add at least one allowed Telegram user ID.'
            return
        }
        const testResult = await this.test()
        if (!testResult.success) {
            this.connected = false
            this.errorMsg = testResult.error
            return
        }
        this.botUsername = testResult.username
        this.connected = true
        this.errorMsg = undefined
        this.polling = true
        registerBotCommands(this).catch(() => { })
        this.hitlUnsub = subscribeToHITL(this)
        this.poll()
    }

    async stop(): Promise<void> {
        this.polling = false
        this.connected = false
        this.hitlUnsub?.()
        this.hitlUnsub = undefined
        if (this.pollTimer) {
            clearTimeout(this.pollTimer)
            this.pollTimer = null
        }
        if (this.abortController) {
            this.abortController.abort()
            this.abortController = null
        }
        cancelChannelExecutionsWhere(this.activeExecutions, () => true)
        this.conversationToChat.clear()
        this.conversationToUser.clear()
        this.chatLocks.clear()
    }

    status(): ChannelStatus {
        return {
            connected: this.connected,
            error: this.errorMsg,
            username: this.botUsername
        }
    }

    getActiveExecutions(): ActiveChannelExecution[] {
        return Array.from(this.activeExecutions.values()).map(v => v.exec)
    }

    cancelExecution(executionId: string): boolean {
        return cancelChannelExecution(this.activeExecutions, executionId)
    }

    async test(): Promise<{ success: boolean; username?: string; error?: string }> {
        try {
            const res = await fetch(`${TELEGRAM_API}/bot${this.botToken}/getMe`)
            if (!res.ok) {
                return { success: false, error: `Telegram API error: ${res.status} ${res.statusText}` }
            }
            const data = await res.json() as { ok: boolean; result?: { username?: string; first_name?: string } }
            if (!data.ok) {
                return { success: false, error: 'Invalid bot token' }
            }
            return { success: true, username: data.result?.username || data.result?.first_name }
        } catch (err) {
            return { success: false, error: (err as Error).message }
        }
    }

    async refreshCommands(): Promise<void> {
        await registerBotCommands(this)
    }

    async sendNotification(target: string, text: string): Promise<void> {
        if (!this.connected) {
            throw new Error('Telegram channel is not connected')
        }
        const chatId = parseInt(target, 10)
        if (isNaN(chatId)) {
            throw new Error(`Invalid Telegram chat target: ${target}`)
        }
        if (!isTelegramUserAllowed(this.allowedUserIds, chatId)) {
            throw new Error('Telegram notification target is not an allowed user')
        }
        await sendLongMessage(this, chatId, text)
    }

    // ─── Polling ──────────────────────────────────────────────

    private poll(): void {
        if (!this.polling) return

        this.abortController = new AbortController()
        const signal = this.abortController.signal

        const url = `${TELEGRAM_API}/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30`

        fetch(url, { signal })
            .then(async (res) => {
                if (!res.ok) {
                    this.errorMsg = `Polling error: ${res.status}`
                    this.scheduleNextPoll(5000)
                    return
                }
                const data = await res.json() as { ok: boolean; result?: TelegramUpdate[] }
                if (data.ok && data.result) {
                    for (const update of data.result) {
                        this.lastUpdateId = update.update_id
                        if (update.callback_query && isTelegramUserAllowed(this.allowedUserIds, update.callback_query.from.id)) {
                            handleCallbackQuery(this, update.callback_query).catch(() => { })
                        } else if (
                            update.message?.chat.type === 'private'
                            && isTelegramUserAllowed(this.allowedUserIds, update.message.from?.id)
                            && (update.message.text || update.message.photo || update.message.document || update.message.audio || update.message.voice || update.message.video || update.message.video_note)
                        ) {
                            handleMessage(this, update).catch((err) => {
                                console.error(`[Telegram] Error handling message: ${(err as Error).message}`)
                            })
                        }
                    }
                }
                this.errorMsg = undefined
                this.scheduleNextPoll(100)
            })
            .catch((err) => {
                if ((err as Error).name === 'AbortError') return
                this.errorMsg = (err as Error).message
                this.scheduleNextPoll(5000)
            })
    }

    private scheduleNextPoll(delayMs: number): void {
        if (!this.polling) return
        this.pollTimer = setTimeout(() => this.poll(), delayMs)
    }
}
