import type { ChannelProvider, ChannelStatus, ActiveChannelExecution } from './base.channel.js'
import { getDb } from '../../db/database.js'
import { getGateway } from '../gateway/gateway.js'
import { AgentExecutor } from '../agent/agent-executor.js'
import { prepareAgentExecution } from '../agent/prepare-execution.js'
import { getAgent, listAgents } from '../agents/agent-store.js'
import { getEventBus } from '../telemetry/event-bus.js'
import type { ChatMessage } from '../gateway/providers/base.provider.js'
import { nanoid } from 'nanoid'

const TELEGRAM_API = 'https://api.telegram.org'

interface TelegramConfig {
    botToken: string
}

interface TelegramUpdate {
    update_id: number
    message?: {
        message_id: number
        from?: { id: number; first_name: string; last_name?: string; username?: string }
        chat: { id: number; type: string; title?: string; first_name?: string }
        date: number
        text?: string
    }
    callback_query?: {
        id: string
        from: { id: number; first_name: string }
        message?: { message_id: number; chat: { id: number } }
        data?: string
    }
}

/** Tracks a pending HITL approval in a Telegram chat */
interface PendingHITL {
    chatId: number
    messageId: number
    resolve: (result: { approved: boolean; reason?: string }) => void
}

type BroadcastFn = (event: string, data: unknown) => void

export class TelegramChannel implements ChannelProvider {
    private botToken: string
    private agentId: string
    private channelId: string
    private broadcast: BroadcastFn
    private polling = false
    private pollTimer: ReturnType<typeof setTimeout> | null = null
    private lastUpdateId = 0
    private connected = false
    private errorMsg?: string
    private botUsername?: string
    private abortController: AbortController | null = null
    private activeExecutions = new Map<string, { exec: ActiveChannelExecution; controller: AbortController }>()
    /** Per-chat agent override — maps telegramChatId → agentId */
    private chatAgentOverride = new Map<number, string>()
    /** Pending HITL approvals — maps taskId → PendingHITL */
    private pendingHITL = new Map<string, PendingHITL>()
    /** Maps conversationId → telegramChatId for HITL routing */
    private conversationToChat = new Map<string, number>()
    /** Per-chat message lock to prevent concurrent processing races */
    private chatLocks = new Map<number, Promise<void>>()
    /** EventBus unsubscribe for hitl:request */
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
    }

    async start(): Promise<void> {
        // Validate token first
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
        this.registerBotCommands().catch(() => { })
        this.subscribeToHITL()
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
        this.conversationToChat.clear()
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
        const entry = this.activeExecutions.get(executionId)
        if (entry) {
            entry.controller.abort()
            this.activeExecutions.delete(executionId)
            return true
        }
        return false
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

    // ─── Private ──────────────────────────────────────────────

    /** Re-register Telegram bot commands after agent changes. */
    async refreshCommands(): Promise<void> {
        await this.registerBotCommands()
    }

    /** Register Telegram bot commands from the agent list for slash-command autocompletion. */
    private async registerBotCommands(): Promise<void> {
        const agents = listAgents()
        const commands: { command: string; description: string }[] = [
            { command: 'stop', description: 'Cancel the currently running execution' },
            { command: 'new', description: 'Start a fresh conversation with the current agent' }
        ]
        for (const agent of agents) {
            const cmd = agent.codename.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32)
            if (cmd) {
                commands.push({ command: cmd, description: `Switch to ${agent.name}` })
            }
        }
        await fetch(`${TELEGRAM_API}/bot${this.botToken}/setMyCommands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commands })
        }).catch(() => { })
    }

    private poll(): void {
        if (!this.polling) return

        this.abortController = new AbortController()
        const signal = this.abortController.signal

        // Long polling with 30s timeout
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
                        if (update.callback_query) {
                            this.handleCallbackQuery(update.callback_query).catch(() => { })
                        } else if (update.message?.text) {
                            this.handleMessage(update).catch((err) => {
                                console.error(`[Telegram] Error handling message: ${(err as Error).message}`)
                            })
                        }
                    }
                }
                this.errorMsg = undefined
                this.scheduleNextPoll(100) // Quickly poll again
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

    private async handleMessage(update: TelegramUpdate): Promise<void> {
        const msg = update.message!
        const chatId = msg.chat.id
        const text = msg.text || ''

        // Handle /stop immediately — bypass the chat lock so it can
        // cancel an in-flight execution without waiting for it to finish
        if (text.startsWith('/stop')) {
            await this.handleCommand(chatId, text)
            return
        }

        // Serialize messages per chat to prevent race conditions
        const prev = this.chatLocks.get(chatId) || Promise.resolve()
        let unlock: () => void
        const lock = new Promise<void>(resolve => { unlock = resolve })
        this.chatLocks.set(chatId, lock)
        await prev

        try {
            await this.processMessage(update)
        } finally {
            unlock!()
            if (this.chatLocks.get(chatId) === lock) this.chatLocks.delete(chatId)
        }
    }

    private async processMessage(update: TelegramUpdate): Promise<void> {
        const msg = update.message!
        const chatId = msg.chat.id
        const userText = msg.text!
        const senderName = msg.from?.first_name || 'User'

        // ── Handle slash commands ──
        if (userText.startsWith('/')) {
            const handled = await this.handleCommand(chatId, userText)
            if (handled) return
        }

        // Resolve which agent to use (override or default)
        const effectiveAgentId = this.chatAgentOverride.get(chatId) || this.agentId

        // Send initial "thinking" message and get its id for threading
        const thinkingMsgId = await this.sendMessageReturningId(chatId, '🤔 Thinking...')

        // Find or create a conversation for this Telegram chat
        const conversationId = await this.getOrCreateConversation(chatId, senderName, effectiveAgentId)
        this.conversationToChat.set(conversationId, chatId)

        const db = getDb()

        // Save user message
        const userMsgId = nanoid()
        const now = Date.now()
        db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
        ).run(userMsgId, conversationId, 'user', userText, now)
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)

        // Broadcast to UI
        this.broadcast('chat:new-message', {
            conversationId,
            message: { id: userMsgId, conversationId, role: 'user', content: userText, createdAt: now }
        })

        // Build history
        const historyRows = db
            .prepare('SELECT role, content, tool_calls_json, tool_call_id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
            .all(conversationId) as { role: string; content: string; tool_calls_json: string | null; tool_call_id: string | null }[]

        let messages: ChatMessage[] = historyRows.map((row) => ({
            role: row.role as ChatMessage['role'],
            content: row.content,
            toolCalls: row.tool_calls_json ? JSON.parse(row.tool_calls_json) : undefined,
            toolCallId: row.tool_call_id || undefined
        }))

        // Resolve agent
        const resolvedAgent = getAgent(effectiveAgentId)
        if (!resolvedAgent) {
            if (thinkingMsgId) await this.editMessage(chatId, thinkingMsgId, '⚠️ Agent not found.')
            else await this.sendMessage(chatId, '⚠️ Agent not found.')
            return
        }

        // Prepare execution: tools, memory, system prompt, provider/model
        const isFirstUserMessage = historyRows.filter(r => r.role === 'user').length === 1
        const prepared = await prepareAgentExecution({
            agent: resolvedAgent,
            conversationId,
            broadcast: this.broadcast,
            userQuery: userText,
            isFirstMessage: isFirstUserMessage,
            signal: AbortSignal.timeout(300_000),
        })
        messages = [...prepared.systemMessages, ...messages]

        const streamId = nanoid()
        const execAbort = new AbortController()
        this.activeExecutions.set(streamId, {
            exec: { id: streamId, channelId: this.channelId, agentId: effectiveAgentId, conversationId, startedAt: Date.now() },
            controller: execAbort
        })

        const executor = new AgentExecutor({
            gateway: getGateway(),
            tools: prepared.tools,
            conversationId,
            broadcast: this.broadcast,
            providerId: prepared.providerId,
            model: prepared.model,
            hitl: !resolvedAgent.autoApproveTools,
            maxRounds: prepared.hasSubAgents ? 30 : 15,
            thinkingEnabled: resolvedAgent.thinkingEnabled !== false,
            streamMode: 'single',
            signal: execAbort.signal,
            streamId,
            agentId: effectiveAgentId,
            agentName: resolvedAgent.name,
            agentIconUrl: resolvedAgent.iconUrl || null,
        })

        // ── Set up EventBus listeners for threaded Telegram output ──
        const eventBus = getEventBus()
        const unsubs: Array<() => void> = []

        // Accumulated thinking text for live-editing the thinking message
        let accumulatedThinking = ''
        let thinkingEditQueued = false
        const THINKING_EDIT_INTERVAL_MS = 2000

        // ── Message send queue: ensures all Telegram messages for this execution
        //    are sent in order, preventing tool results from appearing after the final response ──
        let sendChain = Promise.resolve()
        const enqueueSend = (fn: () => Promise<void>): void => {
            sendChain = sendChain.then(fn, fn)
        }

        if (thinkingMsgId) {
            // Live thinking updates → edit the thinking message periodically
            unsubs.push(eventBus.on('step:thinking', (...args: unknown[]) => {
                const data = args[0] as { conversationId: string; thinking: string }
                if (data.conversationId !== conversationId) return
                accumulatedThinking += data.thinking

                // Throttle edits to avoid Telegram rate limits
                if (!thinkingEditQueued) {
                    thinkingEditQueued = true
                    setTimeout(() => {
                        thinkingEditQueued = false
                        const MAX_THINKING = 3800
                        const display = accumulatedThinking.length > MAX_THINKING
                            ? '…' + accumulatedThinking.slice(-MAX_THINKING)
                            : accumulatedThinking
                        this.editMessage(chatId, thinkingMsgId!, `💭 *Thinking*\n\n${display}`).catch(() => { })
                    }, THINKING_EDIT_INTERVAL_MS)
                }
            }))

            // Tool calls chosen → send thread reply with tool name + parameters
            unsubs.push(eventBus.on('step:tools-chosen', (...args: unknown[]) => {
                const data = args[0] as { conversationId: string; iteration: number; toolCalls: { name: string; arguments: string }[]; maCodename?: string }
                if (data.conversationId !== conversationId) return
                const prefix = data.maCodename ? `🤖 [${data.maCodename}] ` : ''
                const toolLines = data.toolCalls.map(tc => {
                    let params = ''
                    try {
                        const parsed = JSON.parse(tc.arguments)
                        params = Object.entries(parsed).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')
                    } catch { params = tc.arguments }
                    return params
                        ? `\`${tc.name}\`:\n\`\`\`\n${params}\n\`\`\``
                        : `\`${tc.name}\``
                })
                const text = `${prefix}🔧 Round ${data.iteration}:\n${toolLines.join('\n')}`
                enqueueSend(() => this.sendReply(chatId, thinkingMsgId, text.slice(0, 4000)).catch(() => { }))
            }))

            // Tool execution results → send thread reply with return text + images
            unsubs.push(eventBus.on('step:executed', (...args: unknown[]) => {
                const data = args[0] as { conversationId: string; iteration: number; results: { name: string; success: boolean; output: string; imageDataUrls?: string[] }[]; maCodename?: string }
                if (data.conversationId !== conversationId) return
                const prefix = data.maCodename ? `🤖 [${data.maCodename}] ` : ''
                const lines = data.results.map(r => {
                    const icon = r.success ? '✅' : '❌'
                    const preview = r.output.length > 200 ? r.output.slice(0, 200) + '…' : r.output
                    return `${icon} \`${r.name}\`: ${preview}`
                })
                const text = `${prefix}${lines.join('\n')}`
                enqueueSend(async () => {
                    await this.sendReply(chatId, thinkingMsgId!, text.slice(0, 4000)).catch(() => { })
                    // Send tool-result images
                    for (const r of data.results) {
                        if (r.imageDataUrls?.length) {
                            for (const dataUrl of r.imageDataUrls) {
                                await this.sendPhoto(chatId, dataUrl, thinkingMsgId!).catch(e =>
                                    console.warn('[Telegram] Failed to send tool image:', (e as Error).message)
                                )
                            }
                        }
                    }
                })
            }))

            // Keep sending typing indicator during execution
            const typingInterval = setInterval(() => {
                this.sendChatAction(chatId, 'typing').catch(() => { })
            }, 4000)
            unsubs.push(() => clearInterval(typingInterval))
        }

        // Live response content streaming
        let accumulatedContent = ''
        let responseMsgId: number | null = null
        let contentEditQueued = false
        const CONTENT_EDIT_INTERVAL_MS = 1500

        unsubs.push(eventBus.on('step:content', (...args: unknown[]) => {
            const data = args[0] as { conversationId: string; content: string }
            if (data.conversationId !== conversationId) return
            accumulatedContent += data.content

            if (!contentEditQueued) {
                contentEditQueued = true
                setTimeout(async () => {
                    contentEditQueued = false
                    const MAX_LEN = 4000
                    const display = accumulatedContent.length > MAX_LEN
                        ? accumulatedContent.slice(0, MAX_LEN) + '…'
                        : accumulatedContent
                    if (!responseMsgId) {
                        responseMsgId = await this.sendMessageReturningId(chatId, display + ' ▍')
                    } else {
                        await this.editMessage(chatId, responseMsgId, display + ' ▍').catch(() => { })
                    }
                }, CONTENT_EDIT_INTERVAL_MS)
            }
        }))

        try {
            const result = await executor.run(messages)

            // Wait for all queued tool-result messages to finish sending
            // before sending the final response — ensures correct ordering
            await sendChain

            // Save assistant message
            const assistantMsgId = nanoid()
            db.prepare(
                `INSERT INTO messages (id, conversation_id, role, content, thinking, agent_id, provider, model, prompt_tokens, completion_tokens, context_tokens, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
                assistantMsgId, conversationId, 'assistant', result.content,
                result.thinking || null, effectiveAgentId,
                prepared.providerId || null, prepared.model || null,
                result.usage?.promptTokens ?? null, result.usage?.completionTokens ?? null,
                result.contextTokens ?? null,
                Date.now() - now, Date.now()
            )

            // ── Finalize thinking message ──
            if (thinkingMsgId) {
                const durationSec = Math.round((Date.now() - now) / 1000)
                const summary = result.toolRounds
                    ? `✅ Done (${result.toolRounds} tool round${result.toolRounds > 1 ? 's' : ''}, ${durationSec}s)`
                    : `✅ Done (${durationSec}s)`
                if (accumulatedThinking) {
                    const MAX_THINKING = 3800
                    const thinking = accumulatedThinking.length > MAX_THINKING
                        ? '…' + accumulatedThinking.slice(-MAX_THINKING)
                        : accumulatedThinking
                    await this.editMessage(chatId, thinkingMsgId, `💭 *Thinking*\n\n${thinking}\n\n${summary}`)
                } else {
                    await this.editMessage(chatId, thinkingMsgId, summary)
                }
            }

            // ── Send final response text ──
            const responseText = result.content || '(no response)'
            if (responseMsgId) {
                // Edit the live-streamed response message with final content
                if (responseText.length <= 4000) {
                    await this.editMessage(chatId, responseMsgId, responseText)
                } else {
                    // Content too long for a single message — delete streaming msg and send chunked
                    await this.editMessage(chatId, responseMsgId, responseText.slice(0, 4000))
                    await this.sendLongMessage(chatId, responseText.slice(4000))
                }
            } else {
                await this.sendLongMessage(chatId, responseText)
            }

            // ── Send response images if present ──
            if (result.images?.length) {
                for (const dataUrl of result.images) {
                    await this.sendPhoto(chatId, dataUrl).catch(e =>
                        console.warn('[Telegram] Failed to send response image:', (e as Error).message)
                    )
                }
            }
        } catch (err) {
            const errorMsg = (err as Error).message || 'Unknown error'
            console.error(`[Telegram] Agent execution error: ${errorMsg}`)
            if (thinkingMsgId) {
                await this.editMessage(chatId, thinkingMsgId, `⚠️ Error: ${errorMsg}`)
            } else {
                await this.sendMessage(chatId, `⚠️ Error: ${errorMsg}`)
            }
        } finally {
            // Clean up execution tracking and EventBus listeners
            this.activeExecutions.delete(streamId)
            for (const unsub of unsubs) unsub()
        }
    }

    /** Handle slash commands. Returns true if the message was a command and was handled. */
    private async handleCommand(chatId: number, text: string): Promise<boolean> {
        const command = text.split(/\s|@/)[0].slice(1).toLowerCase()

        if (command === 'stop') {
            // Cancel all active executions for this channel
            let cancelled = 0
            for (const [id, entry] of this.activeExecutions) {
                entry.controller.abort()
                this.activeExecutions.delete(id)
                cancelled++
            }
            if (cancelled > 0) {
                await this.sendMessage(chatId, `⏹ Stopped ${cancelled} running execution(s).`)
            } else {
                await this.sendMessage(chatId, '✅ No executions are currently running.')
            }
            return true
        }

        if (command === 'new') {
            // Cancel any active executions for this chat before archiving
            this.cancelExecutionsForChat(chatId)
            // Archive current conversation, start a fresh one with the same agent
            const effectiveAgentId = this.chatAgentOverride.get(chatId) || this.agentId
            this.archiveConversation(chatId, effectiveAgentId)
            const agent = getAgent(effectiveAgentId)
            await this.sendMessage(chatId, `🆕 Starting a fresh conversation with *${agent?.name || 'Unknown'}*.`)
            return true
        }

        if (command === 'start') {
            // Cancel any active executions for this chat before archiving
            this.cancelExecutionsForChat(chatId)
            // Reset to the default channel agent — archive old conversation, start fresh
            const prevAgentId = this.chatAgentOverride.get(chatId) || this.agentId
            this.chatAgentOverride.delete(chatId)
            this.archiveConversation(chatId, prevAgentId)
            const agent = getAgent(this.agentId)
            await this.sendMessage(chatId, `🔄 Switched back to default agent: *${agent?.name || 'Unknown'}*\n\nStarting a fresh conversation.`)
            return true
        }

        // Try to match an agent codename
        const agents = listAgents()
        const normalizedCmd = command.replace(/_/g, '-')
        const matchedAgent = agents.find(a => {
            const lc = a.codename.toLowerCase()
            const agentCmd = lc.replace(/[^a-z0-9_]/g, '_')
            return agentCmd === command || lc === normalizedCmd || lc === command
        })

        if (matchedAgent) {
            // Cancel any active executions and archive the current conversation before switching
            this.cancelExecutionsForChat(chatId)
            const prevAgentId = this.chatAgentOverride.get(chatId) || this.agentId
            this.archiveConversation(chatId, prevAgentId)
            this.chatAgentOverride.set(chatId, matchedAgent.id)
            await this.sendMessage(chatId, `🔀 Switched to *${matchedAgent.name}*. Starting a fresh conversation.\n\nUse /start to switch back to the default agent.`)
            return true
        }

        // Unknown command — don't consume it, let it fall through as a regular message
        return false
    }

    /** Subscribe to HITL approval requests and forward them to Telegram as inline buttons. */
    private subscribeToHITL(): void {
        const eventBus = getEventBus()
        this.hitlUnsub = eventBus.on('hitl:request', (...args: unknown[]) => {
            const data = args[0] as {
                taskId: string
                conversationId: string
                toolCalls: { id: string; function: { name: string; arguments: string } }[]
                resolve: (result: { approved: boolean; reason?: string }) => void
            }
            const chatId = this.conversationToChat.get(data.conversationId)
            if (chatId === undefined) return // Not our conversation

            const toolNames = data.toolCalls.map(tc => `\`${tc.function.name}\``).join(', ')
            const text = `🔐 *Tool approval required*\n\nThe agent wants to use: ${toolNames}\n\nApprove or deny?`

            const keyboard = {
                inline_keyboard: [[
                    { text: '✅ Approve', callback_data: `hitl:${data.taskId}:approve` },
                    { text: '❌ Deny', callback_data: `hitl:${data.taskId}:deny` }
                ]]
            }

            fetch(`${TELEGRAM_API}/bot${this.botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text,
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                })
            })
                .then(async (res) => {
                    const body = await res.json() as { ok: boolean; result?: { message_id: number } }
                    if (body.ok && body.result) {
                        this.pendingHITL.set(data.taskId, {
                            chatId,
                            messageId: body.result.message_id,
                            resolve: data.resolve
                        })
                    }
                })
                .catch(() => { })
        })
    }

    /** Handle a Telegram callback query (inline button press). */
    private async handleCallbackQuery(query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
        const callbackData = query.data
        if (!callbackData?.startsWith('hitl:')) {
            await this.answerCallbackQuery(query.id)
            return
        }

        const parts = callbackData.split(':')
        const taskId = parts[1]
        const action = parts[2]
        const pending = this.pendingHITL.get(taskId)

        if (!pending) {
            await this.answerCallbackQuery(query.id, 'This approval has already been handled.')
            return
        }

        this.pendingHITL.delete(taskId)
        const approved = action === 'approve'

        // Resolve the HITL gate
        pending.resolve({ approved, reason: approved ? undefined : 'Denied via Telegram' })

        // Sync with web UI: broadcast dismissal + clean DB + emit EventBus event for server-side cleanup
        this.broadcast('agent:hitl-resolved', { taskId, approved })
        getEventBus().emit('hitl:resolved', { taskId })
        try { getDb().prepare('DELETE FROM pending_hitl WHERE task_id = ?').run(taskId) } catch { /* ignore */ }

        // Edit the approval message to show the result
        const statusText = approved ? '✅ *Approved* — proceeding...' : '❌ *Denied* — the agent will try a different approach.'
        await this.editMessage(pending.chatId, pending.messageId, statusText)
        await this.answerCallbackQuery(query.id, approved ? 'Approved!' : 'Denied.')
    }

    /** Answer a Telegram callback query (acknowledge a button press). */
    private async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
        await fetch(`${TELEGRAM_API}/bot${this.botToken}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId, text })
        }).catch(() => { })
    }

    private async getOrCreateConversation(telegramChatId: number, senderName: string, agentId?: string): Promise<string> {
        const db = getDb()
        const resolvedAgentId = agentId || this.agentId
        const lookupKey = `telegram:${this.channelId}:${telegramChatId}`

        // Check if we have an existing conversation for this Telegram chat
        // We store the mapping in the conversation title prefix
        const existing = db
            .prepare('SELECT id FROM conversations WHERE origin = ? AND agent_id = ? AND title LIKE ? AND title NOT LIKE ?')
            .get('channel', resolvedAgentId, `${lookupKey}%`, '%|archived:%') as { id: string } | undefined

        if (existing) return existing.id

        const id = nanoid()
        const now = Date.now()
        const title = `${lookupKey}|${senderName}`
        db.prepare(
            'INSERT INTO conversations (id, title, agent_id, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(id, title, resolvedAgentId, 'channel', now, now)

        return id
    }

    /** Archive the active conversation for a Telegram chat so a fresh one is created next time. */
    private archiveConversation(telegramChatId: number, agentId: string): void {
        const db = getDb()
        const lookupKey = `telegram:${this.channelId}:${telegramChatId}`
        const existing = db
            .prepare('SELECT id, title FROM conversations WHERE origin = ? AND agent_id = ? AND title LIKE ? AND title NOT LIKE ?')
            .get('channel', agentId, `${lookupKey}%`, '%|archived:%') as { id: string; title: string } | undefined
        if (existing) {
            // Append a timestamp to the title so the lookup won't match it anymore
            const archivedTitle = `${existing.title}|archived:${Date.now()}`
            db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
                .run(archivedTitle, Date.now(), existing.id)
            this.conversationToChat.delete(existing.id)
        }
    }

    /** Cancel all active executions whose conversationId maps to the given Telegram chatId. */
    private cancelExecutionsForChat(chatId: number): void {
        for (const [id, entry] of this.activeExecutions) {
            const execChatId = this.conversationToChat.get(entry.exec.conversationId)
            if (execChatId === chatId) {
                entry.controller.abort()
                this.activeExecutions.delete(id)
            }
        }
    }

    private async sendMessage(chatId: number, text: string): Promise<void> {
        await fetch(`${TELEGRAM_API}/bot${this.botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
        })
    }

    private async sendLongMessage(chatId: number, text: string): Promise<void> {
        // Telegram max message length is 4096
        const MAX_LEN = 4000
        if (text.length <= MAX_LEN) {
            await this.sendMessage(chatId, text)
            return
        }
        // Split at paragraph boundaries
        const chunks: string[] = []
        let remaining = text
        while (remaining.length > 0) {
            if (remaining.length <= MAX_LEN) {
                chunks.push(remaining)
                break
            }
            let splitAt = remaining.lastIndexOf('\n\n', MAX_LEN)
            if (splitAt < MAX_LEN / 2) splitAt = remaining.lastIndexOf('\n', MAX_LEN)
            if (splitAt < MAX_LEN / 2) splitAt = MAX_LEN
            chunks.push(remaining.slice(0, splitAt))
            remaining = remaining.slice(splitAt).trimStart()
        }
        for (const chunk of chunks) {
            await this.sendMessage(chatId, chunk)
        }
    }

    private async sendMessageReturningId(chatId: number, text: string): Promise<number | null> {
        try {
            const res = await fetch(`${TELEGRAM_API}/bot${this.botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
            })
            const data = await res.json() as { ok: boolean; result?: { message_id: number } }
            return data.ok ? data.result?.message_id ?? null : null
        } catch {
            return null
        }
    }

    private async sendReply(chatId: number, replyToMsgId: number, text: string): Promise<void> {
        await fetch(`${TELEGRAM_API}/bot${this.botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                reply_to_message_id: replyToMsgId,
                parse_mode: 'Markdown'
            })
        }).catch(() => { })
    }

    private async editMessage(chatId: number, messageId: number, text: string): Promise<boolean> {
        try {
            const res = await fetch(`${TELEGRAM_API}/bot${this.botToken}/editMessageText`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    message_id: messageId,
                    text,
                    parse_mode: 'Markdown'
                })
            })
            const data = await res.json() as { ok: boolean }
            return data.ok
        } catch {
            return false
        }
    }

    private async sendChatAction(chatId: number, action: string): Promise<void> {
        await fetch(`${TELEGRAM_API}/bot${this.botToken}/sendChatAction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, action })
        })
    }

    /** Send a base64 data-URL image as a photo to a Telegram chat. */
    private async sendPhoto(chatId: number, dataUrl: string, replyToMsgId?: number): Promise<void> {
        const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
        if (!match) return
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
        const buffer = Buffer.from(match[2], 'base64')
        const boundary = '----OABoundary' + Date.now()
        const parts: Buffer[] = []
        // chat_id field
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`))
        // reply_to_message_id field (optional, for threading)
        if (replyToMsgId) {
            parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="reply_to_message_id"\r\n\r\n${replyToMsgId}\r\n`))
        }
        // photo field (file upload)
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="image.${ext}"\r\nContent-Type: image/${match[1]}\r\n\r\n`))
        parts.push(buffer)
        parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
        const body = Buffer.concat(parts)
        await fetch(`${TELEGRAM_API}/bot${this.botToken}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body
        })
    }
}
