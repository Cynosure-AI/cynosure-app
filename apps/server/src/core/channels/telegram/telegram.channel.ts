import type { ChannelProvider, ChannelStatus, ActiveChannelExecution, ActiveChannelExecutionEntry } from '../base.channel.js'
import { currentChannelProject, handleChannelCommand, projectSuggestions, runProjectSuggestion, type ChannelCommandStyle } from '../channel-commands.js'
import { cancelChannelExecution, cancelChannelExecutionsWhere } from '../channel-execution.js'
import { agentCommandName, getAvailableAgents, parseHITLActionId, resolveChannelHITL, findHomeConversation, resolveHomeConversation, sessionIdleMsFromConfig, subscribeChannelHITL, type ActiveChannelTurn, type BroadcastFn, type ChannelMedia, type ChannelSessionState, type ConversationSendFn } from '../channel-session.js'
import { receiveChannelMessage, type ChannelTransport } from '../channel-turn.js'
import { getCynoProfile } from '../../cyno/cyno-profile.js'
import { findDeliveryConversation, recordChannelDeliveries } from '../channel-delivery.js'
import {
    TELEGRAM_API,
    answerCallbackQuery,
    deleteMessage,
    editMessage,
    extractAttachments,
    sendChatAction,
    sendLongMessage,
    sendMessage,
    sendMessageReturningId,
    sendPhoto,
    setMessageReaction,
} from './telegram.api.js'

/** Telegram delivers each photo of an album as its own message; collect them this long. */
const MEDIA_GROUP_WINDOW_MS = 800

export interface TelegramConfig {
    botToken: string
    allowedAgentIds?: string[]
    /** Hours without a user message after which a chat starts over; 0 never. */
    sessionIdleHours?: number
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
        reply_to_message?: { message_id: number }
        media_group_id?: string
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
    actions?: string
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
    /** Album parts waiting to be handled as one message. */
    mediaGroups: Map<string, TelegramMessage[]>
}

type TelegramMessage = NonNullable<TelegramUpdate['message']>

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
        { command: 'new', description: 'Start a fresh conversation with the last used agent' },
        { command: 'cyno', description: `Switch to ${getCynoProfile().name}, your default assistant` },
        { command: 'project', description: 'Show or switch the project this chat works in' },
    ]
    for (const agent of getAvailableAgents(ctx)) {
        const cmd = agentCommandName(agent.internalName).slice(0, 32)
        // Built-in commands win; a duplicate would make Telegram reject the whole menu.
        if (cmd && !commands.some((command) => command.command === cmd)) {
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
    // A bare /project shows its choices as buttons rather than as a numbered list.
    if (/^\/project(?:@\w+)?\s*$/i.test(text) && await sendProjectPicker(ctx, chatId)) return true
    return handleChannelCommand(ctx, chatId, text, async (reply) => { await sendMessage(ctx, chatId, reply) }, TELEGRAM_COMMAND_STYLE)
}

const PROJECTS_PER_PAGE = 20

/** Status line and a paginated keyboard of the projects; the current one is checked. Null without projects. */
function projectPicker(ctx: TelegramCtx, chatId: number, requestedPage: number) {
    const current = currentChannelProject(ctx, chatId)
    // Leaving is offered only from inside a project.
    const choices = projectSuggestions('', Number.MAX_SAFE_INTEGER).filter(item => item.value !== 'off' || current)
    if (!choices.some(item => item.value !== 'off')) return null
    const pages = Math.ceil(choices.length / PROJECTS_PER_PAGE)
    const page = Math.max(0, Math.min(requestedPage, pages - 1))
    const rows = choices.slice(page * PROJECTS_PER_PAGE, (page + 1) * PROJECTS_PER_PAGE).map(item => [{
        text: item.value === 'off' ? '↩️ Leave project' : item.value === `id:${current?.id}` ? `✓ ${item.name}` : item.name,
        callback_data: `project:${item.value}`,
    }])
    const navigation = []
    if (page > 0) navigation.push({ text: '‹ Previous', callback_data: `project:page:${page - 1}` })
    if (page + 1 < pages) navigation.push({ text: 'Next ›', callback_data: `project:page:${page + 1}` })
    if (navigation.length) rows.push(navigation)
    const text = current
        ? `📁 Working in **${current.name}**. Switch to:`
        : '📁 This chat isn’t in a project yet. Pick one:'
    return { text, markup: { reply_markup: { inline_keyboard: rows } } }
}

/** Telegram has no argument autocomplete; the buttons are the list. Returns false when there is nothing to pick. */
export async function sendProjectPicker(ctx: TelegramCtx, chatId: number): Promise<boolean> {
    const picker = projectPicker(ctx, chatId, 0)
    if (!picker) return false
    await sendMessageReturningId(ctx, chatId, picker.text, picker.markup)
    return true
}

function createTransport(ctx: TelegramCtx, chatId: number, inboundMessageId: number): ChannelTransport<number> {
    return {
        logTag: '[Telegram]',
        messageLimit: 4000,
        reply: (text) => sendMessageReturningId(ctx, chatId, text),
        send: (text) => sendMessageReturningId(ctx, chatId, text),
        edit: async (messageId, text) => { await editMessage(ctx, chatId, messageId, text) },
        delete: async (messageId) => { await deleteMessage(ctx, chatId, messageId) },
        react: (emoji) => setMessageReaction(ctx, chatId, inboundMessageId, emoji),
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

function hasMedia(msg: TelegramMessage): boolean {
    return !!(msg.photo || msg.document || msg.audio || msg.voice || msg.video || msg.video_note)
}

export async function handleMessage(ctx: TelegramCtx, update: TelegramUpdate): Promise<void> {
    const msg = update.message!
    if (msg.chat.type !== 'private' || !isTelegramUserAllowed(ctx.allowedUserIds, msg.from?.id)) return
    const groupId = msg.media_group_id
    if (!groupId) return receiveMessages(ctx, [msg])

    // The first part of an album waits for the rest, then handles them together.
    const group = ctx.mediaGroups.get(groupId)
    if (group) {
        group.push(msg)
        return
    }
    ctx.mediaGroups.set(groupId, [msg])
    await new Promise(resolve => setTimeout(resolve, MEDIA_GROUP_WINDOW_MS))
    const parts = ctx.mediaGroups.get(groupId) ?? [msg]
    ctx.mediaGroups.delete(groupId)
    await receiveMessages(ctx, parts)
}

/** Handle one message, or the parts of one album, as a single inbound message. */
async function receiveMessages(ctx: TelegramCtx, parts: TelegramMessage[]): Promise<void> {
    // An album carries its caption on one of its parts.
    const lead = parts.find(part => part.text || part.caption) ?? parts[0]
    const chatId = lead.chat.id
    const userId = lead.from!.id
    const text = lead.text || lead.caption || ''
    // Replying to a delivered result or an earlier answer continues that conversation.
    const repliedTo = lead.reply_to_message?.message_id
    const continueConversationId = repliedTo === undefined
        ? undefined
        : findDeliveryConversation(ctx.channelId, String(chatId), String(repliedTo)) ?? undefined

    await receiveChannelMessage(ctx, {
        target: chatId,
        text,
        senderName: lead.from?.first_name || 'User',
        hasMedia: parts.some(hasMedia),
        extractMedia: async () => {
            const media: ChannelMedia = { imageDataUrls: [], audioDataUrls: [] }
            for (const part of parts) {
                const extracted = await extractAttachments(ctx, part)
                media.imageDataUrls.push(...extracted.imageDataUrls)
                media.audioDataUrls.push(...extracted.audioDataUrls)
            }
            return media
        },
        handleCommand: text.startsWith('/') ? () => handleCommand(ctx, chatId, text) : undefined,
        transport: createTransport(ctx, chatId, lead.message_id),
        onConversation: (conversationId) => ctx.conversationToUser.set(conversationId, userId),
        continueConversationId,
        onFinalReply: (messageId, conversationId) => recordChannelDeliveries({
            channelId: ctx.channelId, target: String(chatId), platformMessageIds: [String(messageId)], conversationId,
        }),
    })
}

/** Remove an answered approval prompt; the status card records the outcome. Old messages that cannot be deleted are collapsed. */
async function retireApprovalPrompt(ctx: TelegramCtx, pending: PendingHITL, fallback: string): Promise<void> {
    if (await deleteMessage(ctx, pending.chatId, pending.messageId)) return
    await editMessage(ctx, pending.chatId, pending.messageId,
        [fallback, pending.actions].filter(Boolean).join('\n\n'), { reply_markup: { inline_keyboard: [] } })
}

/** Forward HITL approval requests to Telegram as inline buttons. Returns unsub function. */
export function subscribeToHITL(ctx: TelegramCtx): () => void {
    return subscribeChannelHITL(ctx, async (request, chatId, actions) => {
        const userId = ctx.conversationToUser.get(request.conversationId)
        if (userId === undefined || !isTelegramUserAllowed(ctx.allowedUserIds, userId)) return

        const messageId = await sendMessageReturningId(
            ctx,
            chatId,
            `🔐 **Approve to continue?**\n\n${actions}`,
            {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Approve', callback_data: `hitl:${request.taskId}:approve` },
                        { text: '✖️ Decline', callback_data: `hitl:${request.taskId}:deny` }
                    ]]
                }
            }
        )
        if (messageId !== null) {
            ctx.pendingHITL.set(request.taskId, {
                conversationId: request.conversationId,
                actions,
                chatId,
                userId,
                messageId,
                resolve: request.resolve,
            })
        }
    }, async (taskId, cancelled) => {
        const pending = ctx.pendingHITL.get(taskId)
        if (!pending) return
        ctx.pendingHITL.delete(taskId)
        await retireApprovalPrompt(ctx, pending, cancelled ? '⏹ Approval no longer needed.' : '✓ Approval answered elsewhere.')
    })
}

/** Handle a Telegram callback query (inline button press). */
export async function handleCallbackQuery(ctx: TelegramCtx, query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    if (query.data?.startsWith('project:')) {
        const chat = query.message?.chat
        if (!isTelegramUserAllowed(ctx.allowedUserIds, query.from.id) || !chat
            || chat.type !== 'private' || chat.id !== query.from.id) {
            await answerCallbackQuery(ctx, query.id)
            return
        }
        await answerCallbackQuery(ctx, query.id)
        const value = query.data.slice('project:'.length)
        const messageId = query.message!.message_id
        // The picker message turns into the outcome, so switching leaves no trail of menus.
        if (/^page:\d+$/.test(value)) {
            const picker = projectPicker(ctx, chat.id, Number(value.slice(5)))
            if (picker) await editMessage(ctx, chat.id, messageId, picker.text, picker.markup)
        } else {
            await editMessage(ctx, chat.id, messageId, runProjectSuggestion(ctx, chat.id, value, TELEGRAM_COMMAND_STYLE),
                { reply_markup: { inline_keyboard: [] } })
        }
        return
    }
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

    await answerCallbackQuery(ctx, query.id, action.approved ? '✅ Approved — continuing' : 'Declined — continuing without it')
    await retireApprovalPrompt(ctx, pending, action.approved ? '✅ **Approved**' : '✖️ **Declined**')
}

export class TelegramChannel implements ChannelProvider {
    botToken: string
    agentId: string
    channelId: string
    broadcast: BroadcastFn
    allowedAgentIds: string[]
    sessionIdleMs: number
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
    activeTurns = new Map<number, ActiveChannelTurn>()
    mediaGroups = new Map<string, TelegramMessage[]>()

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
        this.sessionIdleMs = sessionIdleMsFromConfig(config)
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
        this.mediaGroups.clear()
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

    async sendNotification(target: string, text: string): Promise<string[]> {
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
        const messageIds = await sendLongMessage(this, chatId, text)
        return messageIds.map(String)
    }

    homeConversation(target: string, create: boolean): { conversationId: string; agentId: string } | null {
        const chatId = parseInt(target, 10)
        if (isNaN(chatId) || !isTelegramUserAllowed(this.allowedUserIds, chatId)) return null
        return create ? resolveHomeConversation(this, chatId) : findHomeConversation(this, chatId)
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
