import type { ChannelProvider, ChannelStatus, ActiveChannelExecution, ActiveChannelExecutionEntry } from '../base.channel.js'
import { handleChannelCommand, type ChannelCommandStyle } from '../channel-commands.js'
import { cancelChannelExecution, cancelChannelExecutionsWhere } from '../channel-execution.js'
import { agentCommandName, getAvailableAgents, parseHITLActionId, resolveChannelHITL, subscribeChannelHITL, type BroadcastFn, type ChannelMedia, type ChannelSessionState, type ConversationSendFn } from '../channel-session.js'
import { receiveChannelMessage, type ChannelTransport } from '../channel-turn.js'
import {
    TELEGRAM_API,
    answerCallbackQuery,
    editMessage,
    extractAttachments,
    sendChatAction,
    sendLongMessage,
    sendMessage,
    sendMessageReturningId,
    sendPhoto,
} from './telegram.api.js'

export interface TelegramConfig {
    botToken: string
    allowedAgentIds?: string[]
    /** Numeric Telegram user IDs permitted to use this bot. Empty means deny all. */
    allowedUserIds?: Array<string | number>
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
        message?: { message_id: number; chat: { id: number; type?: string } }
        data?: string
    }
}

export interface PendingHITL {
    conversationId: string
    chatId: number
    userId: number
    messageId: number
    resolve: (result: { approved: boolean; reason?: string }) => void
}

/** Telegram state; targets are numeric private-chat ids. */
export interface TelegramCtx extends ChannelSessionState<number> {
    botToken: string
    allowedUserIds: ReadonlySet<string>
    pendingHITL: Map<string, PendingHITL>
    /** Telegram user behind each conversation; HITL prompts are only answerable by them. */
    conversationToUser: Map<string, number>
}

/** Normalize Telegram user IDs from persisted, user-supplied channel config. */
export function normalizeTelegramUserIds(value: unknown): string[] {
    if (!Array.isArray(value)) return []

    const ids = value
        .map((id) => typeof id === 'number' ? String(id) : typeof id === 'string' ? id.trim() : '')
        .filter((id) => /^\d+$/.test(id) && id !== '0')

    return Array.from(new Set(ids))
}

export function isTelegramUserAllowed(allowedUserIds: ReadonlySet<string>, userId: number | undefined): boolean {
    return userId !== undefined && allowedUserIds.has(String(userId))
}

const TELEGRAM_COMMAND_STYLE: ChannelCommandStyle = {
    bold: (text) => `**${text}**`,
    switchBackHint: 'Use /start to switch back to the default agent.',
}

/** Register Telegram bot commands from the agent list for slash-command autocompletion. */
export async function registerBotCommands(ctx: TelegramCtx): Promise<void> {
    const commands: { command: string; description: string }[] = [
        { command: 'start', description: 'Start a fresh conversation with the default agent' },
        { command: 'stop', description: 'Cancel the currently running execution' },
        { command: 'kill', description: 'Stop all running executions' },
        { command: 'new', description: 'Start a fresh conversation with the last used agent' }
    ]
    for (const agent of getAvailableAgents(ctx)) {
        const cmd = agentCommandName(agent.internalName).slice(0, 32)
        if (cmd) {
            commands.push({ command: cmd, description: `Switch to ${agent.name}` })
        }
    }
    await fetch(`${TELEGRAM_API}/bot${ctx.botToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands })
    }).catch(() => { })
}

/** Handle slash commands. Returns true if the message was a command and was handled. */
export async function handleCommand(ctx: TelegramCtx, chatId: number, text: string): Promise<boolean> {
    return handleChannelCommand(ctx, chatId, text, (reply) => sendMessage(ctx, chatId, reply), TELEGRAM_COMMAND_STYLE)
}

function createTransport(ctx: TelegramCtx, chatId: number): ChannelTransport<number> {
    return {
        logTag: '[Telegram]',
        previewLimit: 4000,
        messageLimit: 4000,
        bold: (text) => `**${text}**`,
        reply: (text) => sendMessageReturningId(ctx, chatId, text),
        send: (text) => sendMessageReturningId(ctx, chatId, text),
        edit: async (messageId, text) => { await editMessage(ctx, chatId, messageId, text) },
        sendLong: (text) => sendLongMessage(ctx, chatId, text).catch(e =>
            console.warn('[Telegram] Failed to send message:', (e as Error).message)),
        sendImages: async (images, replyTo) => {
            for (const { dataUrl } of images) {
                await sendPhoto(ctx, chatId, dataUrl, replyTo ?? undefined).catch(e =>
                    console.warn('[Telegram] Failed to send image:', (e as Error).message))
            }
        },
        sendTyping: () => sendChatAction(ctx, chatId, 'typing').catch(() => { }),
        typingIntervalMs: 4000,
    }
}

export async function handleMessage(ctx: TelegramCtx, update: TelegramUpdate): Promise<void> {
    const msg = update.message!
    if (msg.chat.type !== 'private' || !isTelegramUserAllowed(ctx.allowedUserIds, msg.from?.id)) return
    const chatId = msg.chat.id
    const userId = msg.from!.id
    const text = msg.text || msg.caption || ''

    await receiveChannelMessage(ctx, {
        target: chatId,
        text,
        senderName: msg.from?.first_name || 'User',
        hasMedia: !!(msg.photo || msg.document || msg.audio || msg.voice || msg.video || msg.video_note),
        extractMedia: () => extractAttachments(ctx, msg),
        handleCommand: text.startsWith('/') ? () => handleCommand(ctx, chatId, text) : undefined,
        transport: createTransport(ctx, chatId),
        onConversation: (conversationId) => ctx.conversationToUser.set(conversationId, userId),
    })
}

/** Forward HITL approval requests to Telegram as inline buttons. Returns unsub function. */
export function subscribeToHITL(ctx: TelegramCtx): () => void {
    return subscribeChannelHITL(ctx, async (request, chatId, toolNames) => {
        const userId = ctx.conversationToUser.get(request.conversationId)
        if (userId === undefined || !isTelegramUserAllowed(ctx.allowedUserIds, userId)) return

        const messageId = await sendMessageReturningId(
            ctx,
            chatId,
            `🔐 **Tool approval required**\n\nThe agent wants to use: ${toolNames}\n\nApprove or deny?`,
            {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Approve', callback_data: `hitl:${request.taskId}:approve` },
                        { text: '❌ Deny', callback_data: `hitl:${request.taskId}:deny` }
                    ]]
                }
            }
        )
        if (messageId !== null) {
            ctx.pendingHITL.set(request.taskId, {
                conversationId: request.conversationId,
                chatId,
                userId,
                messageId,
                resolve: request.resolve,
            })
        }
    })
}

/** Handle a Telegram callback query (inline button press). */
export async function handleCallbackQuery(ctx: TelegramCtx, query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const action = query.data ? parseHITLActionId(query.data) : null
    if (!isTelegramUserAllowed(ctx.allowedUserIds, query.from.id) || !action) {
        await answerCallbackQuery(ctx, query.id)
        return
    }

    const pending = ctx.pendingHITL.get(action.taskId)
    if (!pending) {
        await answerCallbackQuery(ctx, query.id, 'This approval has already been handled.')
        return
    }
    if (pending.userId !== query.from.id || pending.chatId !== query.message?.chat.id) {
        await answerCallbackQuery(ctx, query.id, 'This approval is not assigned to you.')
        return
    }

    ctx.pendingHITL.delete(action.taskId)
    resolveChannelHITL(ctx.broadcast, pending, action.taskId, action.approved, 'Telegram')

    const statusText = action.approved ? '✅ **Approved** — proceeding...' : '❌ **Denied** — the agent will try a different approach.'
    await editMessage(ctx, pending.chatId, pending.messageId, statusText)
    await answerCallbackQuery(ctx, query.id, action.approved ? 'Approved!' : 'Denied.')
}

export class TelegramChannel implements ChannelProvider {
    botToken: string
    agentId: string
    channelId: string
    broadcast: BroadcastFn
    allowedAgentIds: string[]
    allowedUserIds: ReadonlySet<string>
    readonly channelType = 'telegram'
    activeExecutions = new Map<string, ActiveChannelExecutionEntry>()
    agentOverride = new Map<number, string>()
    lastUsedAgent = new Map<number, string>()
    pendingHITL = new Map<string, PendingHITL>()
    conversationTargets = new Map<string, number>()
    conversationToUser = new Map<string, number>()
    targetLocks = new Map<number, Promise<void>>()
    conversationSendQueue = new Map<string, ConversationSendFn>()
    pendingAttachments = new Map<number, ChannelMedia>()

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
        this.conversationTargets.clear()
        this.conversationToUser.clear()
        this.targetLocks.clear()
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
