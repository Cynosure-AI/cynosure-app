import {
    Client,
    GatewayIntentBits,
    Events,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    type Message,
    type Interaction
} from 'discord.js'
import type { ChannelProvider, ChannelStatus, ActiveChannelExecution } from './base.channel.js'
import { getDb } from '../../db/database.js'
import { getGateway } from '../gateway/gateway.js'
import { AgentExecutor } from '../agent/agent-executor.js'
import { prepareAgentExecution } from '../agent/prepare-execution.js'
import { generateTitle } from '../agent/post-execution.js'
import { getAgent, listAgents } from '../agents/agent-store.js'
import { getEventBus } from '../telemetry/event-bus.js'
import type { ChatMessage } from '../gateway/providers/base.provider.js'
import { nanoid } from 'nanoid'

interface DiscordConfig {
    botToken: string
}

type BroadcastFn = (event: string, data: unknown) => void

export class DiscordChannel implements ChannelProvider {
    private client: Client
    private botToken: string
    private agentId: string
    private channelId: string
    private broadcast: BroadcastFn
    private connected = false
    private errorMsg?: string
    private botUsername?: string
    private activeExecutions = new Map<string, { exec: ActiveChannelExecution; controller: AbortController }>()
    /** Per-Discord-channel agent override — maps discordChannelId → agentId */
    private channelAgentOverride = new Map<string, string>()
    /** Pending HITL approvals — maps taskId → PendingHITL */
    private pendingHITL = new Map<string, {
        discordChannelId: string
        messageId: string
        resolve: (result: { approved: boolean; reason?: string }) => void
    }>()
    /** Maps conversationId → discordChannelId for HITL routing */
    private conversationToChannel = new Map<string, string>()
    /** Per-channel message lock to prevent concurrent processing */
    private channelLocks = new Map<string, Promise<void>>()
    /** Per-conversation send queue for ordering HITL messages after tool details */
    private conversationSendQueue = new Map<string, (fn: () => Promise<void>) => void>()
    /** EventBus unsubscribe for hitl:request */
    private hitlUnsub?: () => void

    constructor(
        channelId: string,
        agentId: string,
        config: DiscordConfig,
        broadcast: BroadcastFn
    ) {
        this.channelId = channelId
        this.agentId = agentId
        this.botToken = config.botToken
        this.broadcast = broadcast
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages
            ]
        })
    }

    async start(): Promise<void> {
        const testResult = await this.test()
        if (!testResult.success) {
            this.connected = false
            this.errorMsg = testResult.error
            return
        }
        this.botUsername = testResult.username

        this.client.on(Events.MessageCreate, (msg) => {
            this.handleMessage(msg).catch((err) => {
                console.error(`[Discord] Error handling message: ${(err as Error).message}`)
            })
        })

        this.client.on(Events.InteractionCreate, (interaction) => {
            this.handleInteraction(interaction).catch(() => { })
        })

        try {
            await this.client.login(this.botToken)
            this.connected = true
            this.errorMsg = undefined
            this.subscribeToHITL()
        } catch (err) {
            this.connected = false
            this.errorMsg = (err as Error).message
        }
    }

    async stop(): Promise<void> {
        this.connected = false
        this.hitlUnsub?.()
        this.hitlUnsub = undefined
        for (const [id, entry] of this.activeExecutions) {
            entry.controller.abort()
            this.activeExecutions.delete(id)
        }
        this.conversationToChannel.clear()
        this.channelLocks.clear()
        try { this.client.destroy() } catch { /* ignore */ }
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
        const testClient = new Client({ intents: [GatewayIntentBits.Guilds] })
        try {
            await testClient.login(this.botToken)
            const username = testClient.user?.username || testClient.user?.tag
            testClient.destroy()
            return { success: true, username: username || 'Discord Bot' }
        } catch (err) {
            try { testClient.destroy() } catch { /* ignore */ }
            return { success: false, error: (err as Error).message }
        }
    }

    // ─── Private ──────────────────────────────────────────────

    private async handleMessage(msg: Message): Promise<void> {
        // Ignore own messages
        if (msg.author.id === this.client.user?.id) return
        // Ignore bot messages
        if (msg.author.bot) return
        // Require text content
        if (!msg.content?.trim()) return

        const discordChannelId = msg.channel.id
        const text = msg.content.trim()

        // Handle bang commands immediately — bypass the channel lock so
        // !stop, !new, agent switches etc. can execute without waiting
        // for a running execution to finish
        if (text.startsWith('!')) {
            const handled = await this.handleCommand(msg, text)
            if (handled) return
            // Unknown command → fall through to process as a regular message
        }

        // Serialize messages per channel
        const prev = this.channelLocks.get(discordChannelId) || Promise.resolve()
        let unlock: () => void
        const lock = new Promise<void>(resolve => { unlock = resolve })
        this.channelLocks.set(discordChannelId, lock)
        await prev

        try {
            await this.processMessage(msg)
        } finally {
            unlock!()
            if (this.channelLocks.get(discordChannelId) === lock) this.channelLocks.delete(discordChannelId)
        }
    }

    private async processMessage(msg: Message): Promise<void> {
        const discordChannelId = msg.channel.id
        const userText = msg.content.trim()
        const senderName = msg.author.displayName || msg.author.username

        // ── Handle commands ──
        if (userText.startsWith('!')) {
            const handled = await this.handleCommand(msg, userText)
            if (handled) return
        }

        const effectiveAgentId = this.channelAgentOverride.get(discordChannelId) || this.agentId

        // Send thinking indicator
        let thinkingMsg: Message | null = null
        try {
            thinkingMsg = await msg.reply('🤔 Thinking...')
        } catch { /* can't reply */ }

        const conversationId = this.getOrCreateConversation(discordChannelId, senderName, effectiveAgentId)
        this.conversationToChannel.set(conversationId, discordChannelId)

        const db = getDb()
        const now = Date.now()

        // Save user message
        const userMsgId = nanoid()
        db.prepare(
            'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(userMsgId, conversationId, 'user', userText, now)
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)

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

        const resolvedAgent = getAgent(effectiveAgentId)
        if (!resolvedAgent) {
            if (thinkingMsg) await thinkingMsg.edit('⚠️ Agent not found.').catch(() => { })
            else await msg.reply('⚠️ Agent not found.').catch(() => { })
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

        // EventBus listeners for tool progress
        const eventBus = getEventBus()
        const unsubs: Array<() => void> = []
        const discordChannel = msg.channel

        // Accumulated thinking text for live-editing the thinking message
        let accumulatedThinking = ''
        let thinkingEditQueued = false
        const THINKING_EDIT_INTERVAL_MS = 2000

        // ── Message send queue: ensures all Discord messages for this execution
        //    are sent in order, preventing tool results from appearing after the final response ──
        let sendChain = Promise.resolve()
        const enqueueSend = (fn: () => Promise<void>): void => {
            sendChain = sendChain.then(fn, fn)
        }
        // Register so subscribeToHITL can route approval messages through the same queue
        this.conversationSendQueue.set(conversationId, enqueueSend)

        if (thinkingMsg) {
            // Live thinking updates → edit the thinking message periodically
            unsubs.push(eventBus.on('step:thinking', (...args: unknown[]) => {
                const data = args[0] as { conversationId: string; thinking: string }
                if (data.conversationId !== conversationId) return
                accumulatedThinking += data.thinking

                if (!thinkingEditQueued) {
                    thinkingEditQueued = true
                    setTimeout(() => {
                        thinkingEditQueued = false
                        const MAX_THINKING = 1900
                        const display = accumulatedThinking.length > MAX_THINKING
                            ? '…' + accumulatedThinking.slice(-MAX_THINKING)
                            : accumulatedThinking
                        thinkingMsg!.edit(`💭 **Thinking**\n\n${display}`).catch(() => { })
                    }, THINKING_EDIT_INTERVAL_MS)
                }
            }))

            // Tool calls chosen → tool names with arguments
            unsubs.push(eventBus.on('step:tools-chosen', (...args: unknown[]) => {
                const data = args[0] as { conversationId: string; iteration: number; toolCalls: { name: string; arguments: string }[] }
                if (data.conversationId !== conversationId) return
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
                const text = `🔧 ${toolLines.join('\n')}`
                enqueueSend(() => thinkingMsg!.reply(text.slice(0, 2000)).catch(() => { }) as Promise<any>)
            }))

            // Tool execution results → only show failures and images
            unsubs.push(eventBus.on('step:executed', (...args: unknown[]) => {
                const data = args[0] as { conversationId: string; iteration: number; results: { name: string; success: boolean; output: string; imageDataUrls?: string[] }[] }
                if (data.conversationId !== conversationId) return
                const failures = data.results.filter(r => !r.success)
                enqueueSend(async () => {
                    if (failures.length) {
                        const lines = failures.map(r => {
                            const preview = r.output.length > 150 ? r.output.slice(0, 150) + '…' : r.output
                            return `❌ \`${r.name}\`: ${preview}`
                        })
                        await thinkingMsg!.reply(lines.join('\n').slice(0, 2000)).catch(() => { })
                    }
                    for (const r of data.results) {
                        if (r.imageDataUrls?.length && 'send' in discordChannel) {
                            const files = r.imageDataUrls.map((dataUrl, i) => {
                                const { buffer, ext } = this.dataUrlToBuffer(dataUrl)
                                return { attachment: buffer, name: `tool_${r.name}_${i + 1}.${ext}` }
                            })
                            await (discordChannel as { send: Function }).send({ files }).catch((e: Error) =>
                                console.warn('[Discord] Failed to send tool image:', e.message)
                            )
                        }
                    }
                })
            }))

            // Typing indicator
            const typingInterval = setInterval(() => {
                if ('sendTyping' in discordChannel) discordChannel.sendTyping().catch(() => { })
            }, 5000)
            unsubs.push(() => clearInterval(typingInterval))
        }

        // Live response content streaming
        let accumulatedContent = ''
        const responseState: { msg: Message | null } = { msg: null }
        let contentEditQueued = false
        let contentEditTimer: ReturnType<typeof setTimeout> | null = null
        let executionFinished = false
        const CONTENT_EDIT_INTERVAL_MS = 1500

        unsubs.push(eventBus.on('step:content', (...args: unknown[]) => {
            const data = args[0] as { conversationId: string; content: string }
            if (data.conversationId !== conversationId) return
            accumulatedContent += data.content

            if (!contentEditQueued && !executionFinished) {
                contentEditQueued = true
                contentEditTimer = setTimeout(async () => {
                    contentEditTimer = null
                    contentEditQueued = false
                    if (executionFinished) return
                    const MAX_LEN = 1900
                    const display = accumulatedContent.length > MAX_LEN
                        ? accumulatedContent.slice(0, MAX_LEN) + '…'
                        : accumulatedContent
                    if (!responseState.msg && 'send' in discordChannel) {
                        try {
                            responseState.msg = await (discordChannel as { send: Function }).send(display + ' ▍') as Message
                        } catch { /* can't send */ }
                    } else if (responseState.msg) {
                        await responseState.msg.edit(display + ' ▍').catch(() => { })
                    }
                }, CONTENT_EDIT_INTERVAL_MS)
            }
        }))

        try {
            const result = await executor.run(messages)

            // Prevent any pending content-edit timers from firing after we send the final response
            executionFinished = true
            if (contentEditTimer) { clearTimeout(contentEditTimer); contentEditTimer = null }

            // Clean up the per-conversation send queue
            this.conversationSendQueue.delete(conversationId)

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

            // ── Auto-generate conversation title on first exchange (fire-and-forget) ──
            const convMeta = db.prepare("SELECT json_extract(config_json, '$.titleGenerated') as tg FROM conversations WHERE id = ?")
                .get(conversationId) as { tg: number | null } | undefined
            if (!convMeta?.tg) {
                db.prepare("UPDATE conversations SET config_json = json_set(COALESCE(config_json, '{}'), '$.titleGenerated', 1) WHERE id = ?")
                    .run(conversationId)
                generateTitle({
                    conversationId,
                    userMessage: userText,
                    assistantResponse: result.content,
                    broadcast: this.broadcast,
                    providerId: prepared.providerId,
                    model: prepared.model
                }).catch(() => { })
            }

            const responseText = result.content || '(no response)'
            if (thinkingMsg) {
                const durationSec = Math.round((Date.now() - now) / 1000)
                const summary = result.toolRounds
                    ? `✅ Done (${result.toolRounds} tool round${result.toolRounds > 1 ? 's' : ''}, ${durationSec}s)`
                    : `✅ Done (${durationSec}s)`
                if (accumulatedThinking) {
                    const MAX_THINKING = 1900
                    const thinking = accumulatedThinking.length > MAX_THINKING
                        ? '…' + accumulatedThinking.slice(-MAX_THINKING)
                        : accumulatedThinking
                    await thinkingMsg.edit(`💭 **Thinking**\n\n${thinking}\n\n${summary}`).catch(() => { })
                } else {
                    await thinkingMsg.edit(summary).catch(() => { })
                }
            }

            // Finalize response message
            if (responseState.msg) {
                if (responseText.length <= 2000) {
                    await responseState.msg.edit(responseText).catch(() => { })
                } else {
                    await responseState.msg.edit(responseText.slice(0, 2000)).catch(() => { })
                    if ('send' in discordChannel) await this.sendLongMessage(discordChannel as { send: Function }, responseText.slice(2000))
                }
            } else if ('send' in discordChannel) {
                await this.sendLongMessage(discordChannel as { send: Function }, responseText)
            }

            // Send any images produced by the agent
            if (result.images?.length && 'send' in discordChannel) {
                const files = result.images.map((dataUrl, i) => {
                    const { buffer, ext } = this.dataUrlToBuffer(dataUrl)
                    return { attachment: buffer, name: `image_${i + 1}.${ext}` }
                })
                await (discordChannel as { send: Function }).send({ files }).catch((e: Error) =>
                    console.warn('[Discord] Failed to send images:', e.message)
                )
            }
        } catch (err) {
            const errorMsg = (err as Error).message || 'Unknown error'
            console.error(`[Discord] Agent execution error: ${errorMsg}`)
            if (thinkingMsg) {
                await thinkingMsg.edit(`⚠️ Error: ${errorMsg.slice(0, 1900)}`).catch(() => { })
            } else {
                await msg.reply(`⚠️ Error: ${errorMsg.slice(0, 1900)}`).catch(() => { })
            }
        } finally {
            this.activeExecutions.delete(streamId)
            for (const unsub of unsubs) unsub()
        }
    }

    private async handleCommand(msg: Message, text: string): Promise<boolean> {
        const command = text.slice(1).split(/\s/)[0].toLowerCase()
        const discordChannelId = msg.channel.id

        if (command === 'stop') {
            let cancelled = 0
            for (const [id, entry] of this.activeExecutions) {
                entry.controller.abort()
                this.activeExecutions.delete(id)
                cancelled++
            }
            if (cancelled > 0) {
                await msg.reply(`⏹ Stopped ${cancelled} running execution(s).`).catch(() => { })
            } else {
                await msg.reply('✅ No executions are currently running.').catch(() => { })
            }
            return true
        }

        if (command === 'new') {
            this.cancelExecutionsForChannel(discordChannelId)
            const effectiveAgentId = this.channelAgentOverride.get(discordChannelId) || this.agentId
            this.archiveConversation(discordChannelId, effectiveAgentId)
            const agent = getAgent(effectiveAgentId)
            await msg.reply(`🆕 Starting a fresh conversation with **${agent?.name || 'Unknown'}**.`).catch(() => { })
            return true
        }

        if (command === 'start') {
            this.cancelExecutionsForChannel(discordChannelId)
            const prevAgentId = this.channelAgentOverride.get(discordChannelId) || this.agentId
            this.channelAgentOverride.delete(discordChannelId)
            this.archiveConversation(discordChannelId, prevAgentId)
            const agent = getAgent(this.agentId)
            await msg.reply(`🔄 Switched back to default agent: **${agent?.name || 'Unknown'}**\n\nStarting a fresh conversation.`).catch(() => { })
            return true
        }

        // Try to match an agent codename
        const agents = listAgents()
        const matchedAgent = agents.find(a => {
            const lc = a.codename.toLowerCase()
            const agentCmd = lc.replace(/[^a-z0-9_]/g, '_')
            return agentCmd === command || lc === command
        })

        if (matchedAgent) {
            this.cancelExecutionsForChannel(discordChannelId)
            const prevAgentId = this.channelAgentOverride.get(discordChannelId) || this.agentId
            this.archiveConversation(discordChannelId, prevAgentId)
            this.channelAgentOverride.set(discordChannelId, matchedAgent.id)
            await msg.reply(`🔀 Switched to **${matchedAgent.name}**. Starting a fresh conversation.\n\nUse \`!start\` to switch back.`).catch(() => { })
            return true
        }

        return false
    }

    private subscribeToHITL(): void {
        const eventBus = getEventBus()
        this.hitlUnsub = eventBus.on('hitl:request', (...args: unknown[]) => {
            const data = args[0] as {
                taskId: string
                conversationId: string
                toolCalls: { id: string; function: { name: string; arguments: string } }[]
                resolve: (result: { approved: boolean; reason?: string }) => void
            }
            const discordChannelId = this.conversationToChannel.get(data.conversationId)
            if (!discordChannelId) return

            const channel = this.client.channels.cache.get(discordChannelId)
            if (!channel || !('send' in channel)) return

            const toolNames = data.toolCalls.map(tc => `\`${tc.function.name}\``).join(', ')
            const text = `🔐 **Tool approval required**\n\nThe agent wants to use: ${toolNames}\n\nApprove or deny?`

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`hitl:${data.taskId}:approve`)
                    .setLabel('Approve')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('✅'),
                new ButtonBuilder()
                    .setCustomId(`hitl:${data.taskId}:deny`)
                    .setLabel('Deny')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('❌')
            )

            const sendHITL = async (): Promise<void> => {
                try {
                    const sentMsg = await (channel as { send: Function }).send({ content: text, components: [row] }) as Message
                    this.pendingHITL.set(data.taskId, {
                        discordChannelId,
                        messageId: sentMsg.id,
                        resolve: data.resolve
                    })
                } catch { /* ignore send failures */ }
            }

            // Route through the per-execution send queue so the approval gate
            // always appears AFTER the tool-details message from step:tools-chosen
            const enqueue = this.conversationSendQueue.get(data.conversationId)
            if (enqueue) {
                enqueue(sendHITL)
            } else {
                sendHITL()
            }
        })
    }

    private async handleInteraction(interaction: Interaction): Promise<void> {
        if (!interaction.isButton()) return

        const customId = interaction.customId
        if (!customId.startsWith('hitl:')) return

        const parts = customId.split(':')
        const taskId = parts[1]
        const action = parts[2]
        const pending = this.pendingHITL.get(taskId)

        if (!pending) {
            await interaction.reply({ content: 'This approval has already been handled.', ephemeral: true }).catch(() => { })
            return
        }

        this.pendingHITL.delete(taskId)
        const approved = action === 'approve'

        pending.resolve({ approved, reason: approved ? undefined : 'Denied via Discord' })

        this.broadcast('agent:hitl-resolved', { taskId, approved })
        getEventBus().emit('hitl:resolved', { taskId })
        try { getDb().prepare('DELETE FROM pending_hitl WHERE task_id = ?').run(taskId) } catch { /* ignore */ }

        const statusText = approved ? '✅ **Approved** — proceeding...' : '❌ **Denied** — the agent will try a different approach.'
        await interaction.update({ content: statusText, components: [] }).catch(() => { })
    }

    private getOrCreateConversation(discordChannelId: string, senderName: string, agentId?: string): string {
        const db = getDb()
        const resolvedAgentId = agentId || this.agentId
        const channelKey = `discord:${this.channelId}:${discordChannelId}`

        // Look up by channelKey stored in config_json (new approach)
        const existing = db
            .prepare("SELECT id FROM conversations WHERE origin = 'channel' AND agent_id = ? AND json_extract(config_json, '$.channelKey') = ? AND json_extract(config_json, '$.archived') IS NULL")
            .get(resolvedAgentId, channelKey) as { id: string } | undefined

        if (existing) return existing.id

        // Fallback: check legacy title-based lookup for pre-migration conversations
        const legacy = db
            .prepare('SELECT id FROM conversations WHERE origin = ? AND agent_id = ? AND title LIKE ? AND title NOT LIKE ?')
            .get('channel', resolvedAgentId, `${channelKey}%`, '%|archived:%') as { id: string } | undefined

        if (legacy) return legacy.id

        const id = nanoid()
        const now = Date.now()
        const configJson = JSON.stringify({ channelKey })
        db.prepare(
            'INSERT INTO conversations (id, title, agent_id, origin, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(id, senderName, resolvedAgentId, 'channel', configJson, now, now)

        return id
    }

    private archiveConversation(discordChannelId: string, agentId: string): void {
        const db = getDb()
        const channelKey = `discord:${this.channelId}:${discordChannelId}`

        // Try new config_json-based lookup first
        let existing = db
            .prepare("SELECT id FROM conversations WHERE origin = 'channel' AND agent_id = ? AND json_extract(config_json, '$.channelKey') = ? AND json_extract(config_json, '$.archived') IS NULL")
            .get(agentId, channelKey) as { id: string } | undefined

        // Fallback to legacy title-based lookup
        if (!existing) {
            existing = db
                .prepare('SELECT id FROM conversations WHERE origin = ? AND agent_id = ? AND title LIKE ? AND title NOT LIKE ?')
                .get('channel', agentId, `${channelKey}%`, '%|archived:%') as { id: string } | undefined
        }

        if (existing) {
            db.prepare("UPDATE conversations SET config_json = json_set(COALESCE(config_json, '{}'), '$.archived', ?), updated_at = ? WHERE id = ?")
                .run(Date.now(), Date.now(), existing.id)
            this.conversationToChannel.delete(existing.id)
        }
    }

    /** Cancel all active executions whose conversationId maps to the given Discord channelId. */
    private cancelExecutionsForChannel(discordChannelId: string): void {
        for (const [id, entry] of this.activeExecutions) {
            const execChannelId = this.conversationToChannel.get(entry.exec.conversationId)
            if (execChannelId === discordChannelId) {
                entry.controller.abort()
                this.activeExecutions.delete(id)
            }
        }
    }

    private async sendLongMessage(channel: { send: Function }, text: string): Promise<void> {
        // Discord max message length is 2000
        const MAX_LEN = 1900
        if (text.length <= MAX_LEN) {
            await channel.send(text).catch(() => { })
            return
        }
        let remaining = text
        while (remaining.length > 0) {
            if (remaining.length <= MAX_LEN) {
                await channel.send(remaining).catch(() => { })
                break
            }
            let splitAt = remaining.lastIndexOf('\n\n', MAX_LEN)
            if (splitAt < MAX_LEN / 2) splitAt = remaining.lastIndexOf('\n', MAX_LEN)
            if (splitAt < MAX_LEN / 2) splitAt = MAX_LEN
            await channel.send(remaining.slice(0, splitAt)).catch(() => { })
            remaining = remaining.slice(splitAt).trimStart()
        }
    }

    /** Convert a base64 data-URL to a Node.js Buffer and extension. */
    private dataUrlToBuffer(dataUrl: string): { buffer: Buffer; ext: string } {
        const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
        if (!match) return { buffer: Buffer.alloc(0), ext: 'png' }
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
        return { buffer: Buffer.from(match[2], 'base64'), ext }
    }
}
