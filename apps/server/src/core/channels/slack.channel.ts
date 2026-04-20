import { App } from '@slack/bolt'
import type { WebClient } from '@slack/web-api'
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

interface SlackConfig {
    botToken: string
    appToken: string
}

type BroadcastFn = (event: string, data: unknown) => void

export class SlackChannel implements ChannelProvider {
    private app: App
    private botToken: string
    private appToken: string
    private agentId: string
    private channelId: string
    private broadcast: BroadcastFn
    private connected = false
    private errorMsg?: string
    private botUsername?: string
    private botUserId?: string
    private activeExecutions = new Map<string, { exec: ActiveChannelExecution; controller: AbortController }>()
    /** Per-Slack-channel agent override */
    private channelAgentOverride = new Map<string, string>()
    /** Pending HITL approvals */
    private pendingHITL = new Map<string, {
        slackChannelId: string
        messageTs: string
        resolve: (result: { approved: boolean; reason?: string }) => void
    }>()
    /** Maps conversationId → slackChannelId for HITL routing */
    private conversationToChannel = new Map<string, string>()
    /** Per-channel message lock */
    private channelLocks = new Map<string, Promise<void>>()
    /** EventBus unsubscribe for hitl:request */
    private hitlUnsub?: () => void

    constructor(
        channelId: string,
        agentId: string,
        config: SlackConfig,
        broadcast: BroadcastFn
    ) {
        this.channelId = channelId
        this.agentId = agentId
        this.botToken = config.botToken
        this.appToken = config.appToken
        this.broadcast = broadcast

        this.app = new App({
            token: this.botToken,
            appToken: this.appToken,
            socketMode: true
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

        // Register message listener
        this.app.message(async ({ message, client }) => {
            // Only handle regular user messages (not bot messages, not edits)
            if (message.subtype) return
            const msg = message as { text?: string; user?: string; channel: string; ts: string; subtype?: string }
            if (!msg.text?.trim() || !msg.user) return

            this.handleMessage(msg, client).catch((err) => {
                console.error(`[Slack] Error handling message: ${(err as Error).message}`)
            })
        })

        // Register button action handler for HITL
        this.app.action(/^hitl:.+/, async ({ action, ack, client, body }) => {
            await ack()
            if (action.type !== 'button') return
            const actionId = 'action_id' in action ? (action as { action_id: string }).action_id : ''
            await this.handleHITLAction(actionId, client, body as unknown as Record<string, unknown>).catch(() => { })
        })

        try {
            await this.app.start()
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
        try { await this.app.stop() } catch { /* ignore */ }
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
            const testApp = new App({
                token: this.botToken,
                appToken: this.appToken,
                socketMode: true
            })
            const authResult = await testApp.client.auth.test({ token: this.botToken })
            // Store bot user ID for mention detection
            if (authResult.user_id) this.botUserId = authResult.user_id
            try { await testApp.stop() } catch { /* ignore */ }
            return { success: true, username: (authResult.user as string) || (authResult.bot_id as string) || 'Slack Bot' }
        } catch (err) {
            return { success: false, error: (err as Error).message }
        }
    }

    // ─── Private ──────────────────────────────────────────────

    private async handleMessage(
        msg: { text?: string; user?: string; channel: string; ts: string; subtype?: string },
        client: WebClient
    ): Promise<void> {
        const slackChannelId = msg.channel
        const text = (msg.text || '').trim()

        // Handle !stop immediately — bypass the channel lock so it can
        // cancel an in-flight execution without waiting for it to finish
        if (text.startsWith('!stop')) {
            await this.handleCommand(slackChannelId, text, client, msg.ts)
            return
        }

        const prev = this.channelLocks.get(slackChannelId) || Promise.resolve()
        let unlock: () => void
        const lock = new Promise<void>(resolve => { unlock = resolve })
        this.channelLocks.set(slackChannelId, lock)
        await prev

        try {
            await this.processMessage(msg, client)
        } finally {
            unlock!()
            if (this.channelLocks.get(slackChannelId) === lock) this.channelLocks.delete(slackChannelId)
        }
    }

    private async processMessage(
        msg: { text?: string; user?: string; channel: string; ts: string; subtype?: string },
        client: WebClient
    ): Promise<void> {
        const slackChannelId = msg.channel
        const userText = msg.text!.trim()
        const senderName = msg.user || 'User'

        // ── Handle commands ──
        if (userText.startsWith('!')) {
            const handled = await this.handleCommand(slackChannelId, userText, client, msg.ts)
            if (handled) return
        }

        const effectiveAgentId = this.channelAgentOverride.get(slackChannelId) || this.agentId

        // Send thinking indicator as threaded reply
        let thinkingTs: string | null = null
        try {
            const thinkingResult = await client.chat.postMessage({
                channel: slackChannelId,
                text: '🤔 Thinking...',
                thread_ts: msg.ts
            })
            thinkingTs = thinkingResult.ts || null
        } catch { /* can't post */ }

        const conversationId = this.getOrCreateConversation(slackChannelId, senderName, effectiveAgentId)
        this.conversationToChannel.set(conversationId, slackChannelId)

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
            await this.postOrUpdate(client, slackChannelId, thinkingTs, '⚠️ Agent not found.', msg.ts)
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

        // Accumulated thinking text for live-editing the thinking message
        let accumulatedThinking = ''
        let thinkingEditQueued = false
        const THINKING_EDIT_INTERVAL_MS = 2000

        // ── Message send queue: ensures all Slack messages for this execution
        //    are sent in order, preventing tool results from appearing after the final response ──
        let sendChain = Promise.resolve()
        const enqueueSend = (fn: () => Promise<void>): void => {
            sendChain = sendChain.then(fn, fn)
        }

        // Live thinking updates → edit the thinking message periodically
        unsubs.push(eventBus.on('step:thinking', (...args: unknown[]) => {
            const data = args[0] as { conversationId: string; thinking: string }
            if (data.conversationId !== conversationId) return
            accumulatedThinking += data.thinking

            if (!thinkingEditQueued && thinkingTs) {
                thinkingEditQueued = true
                setTimeout(() => {
                    thinkingEditQueued = false
                    const MAX_THINKING = 2900
                    const display = accumulatedThinking.length > MAX_THINKING
                        ? '…' + accumulatedThinking.slice(-MAX_THINKING)
                        : accumulatedThinking
                    client.chat.update({
                        channel: slackChannelId,
                        ts: thinkingTs!,
                        text: `💭 *Thinking*\n\n${display}`
                    }).catch(() => { })
                }, THINKING_EDIT_INTERVAL_MS)
            }
        }))

        // Tool calls chosen → threaded reply with tool name + parameters
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
            const text = `🔧 Round ${data.iteration}:\n${toolLines.join('\n')}`
            enqueueSend(() => client.chat.postMessage({ channel: slackChannelId, text: text.slice(0, 3000), thread_ts: msg.ts }).catch(() => { }) as Promise<any>)
        }))

        // Tool execution results → threaded reply with return text + images
        unsubs.push(eventBus.on('step:executed', (...args: unknown[]) => {
            const data = args[0] as { conversationId: string; iteration: number; results: { name: string; success: boolean; output: string; imageDataUrls?: string[] }[] }
            if (data.conversationId !== conversationId) return
            const lines = data.results.map(r => {
                const icon = r.success ? '✅' : '❌'
                const preview = r.output.length > 200 ? r.output.slice(0, 200) + '…' : r.output
                return `${icon} \`${r.name}\`: ${preview}`
            })
            enqueueSend(async () => {
                await client.chat.postMessage({ channel: slackChannelId, text: lines.join('\n').slice(0, 3000), thread_ts: msg.ts }).catch(() => { })
                // Upload tool-result images
                for (const r of data.results) {
                    if (r.imageDataUrls?.length) {
                        for (let i = 0; i < r.imageDataUrls.length; i++) {
                            await this.uploadImage(client, slackChannelId, r.imageDataUrls[i], `tool_${r.name}_${i + 1}`, msg.ts).catch(e =>
                                console.warn('[Slack] Failed to upload tool image:', (e as Error).message)
                            )
                        }
                    }
                }
            })
        }))

        // Live response content streaming
        let accumulatedContent = ''
        let responseTs: string | null = null
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
                    const MAX_LEN = 3000
                    const display = accumulatedContent.length > MAX_LEN
                        ? accumulatedContent.slice(0, MAX_LEN) + '…'
                        : accumulatedContent
                    if (!responseTs) {
                        try {
                            const res = await client.chat.postMessage({
                                channel: slackChannelId,
                                text: display + ' ▍',
                                thread_ts: msg.ts
                            })
                            responseTs = res.ts || null
                        } catch { /* can't post */ }
                    } else {
                        await client.chat.update({
                            channel: slackChannelId,
                            ts: responseTs,
                            text: display + ' ▍'
                        }).catch(() => { })
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
            if (thinkingTs) {
                const durationSec = Math.round((Date.now() - now) / 1000)
                const summary = result.toolRounds
                    ? `✅ Done (${result.toolRounds} tool round${result.toolRounds > 1 ? 's' : ''}, ${durationSec}s)`
                    : `✅ Done (${durationSec}s)`
                if (accumulatedThinking) {
                    const MAX_THINKING = 2900
                    const thinking = accumulatedThinking.length > MAX_THINKING
                        ? '…' + accumulatedThinking.slice(-MAX_THINKING)
                        : accumulatedThinking
                    await client.chat.update({ channel: slackChannelId, ts: thinkingTs, text: `💭 *Thinking*\n\n${thinking}\n\n${summary}` }).catch(() => { })
                } else {
                    await client.chat.update({ channel: slackChannelId, ts: thinkingTs, text: summary }).catch(() => { })
                }
            }

            // Finalize response message
            if (responseTs) {
                if (responseText.length <= 3000) {
                    await client.chat.update({ channel: slackChannelId, ts: responseTs, text: responseText }).catch(() => { })
                } else {
                    await client.chat.update({ channel: slackChannelId, ts: responseTs, text: responseText.slice(0, 3000) }).catch(() => { })
                    await this.sendLongSlackMessage(client, slackChannelId, responseText.slice(3000), msg.ts)
                }
            } else {
                await this.sendLongSlackMessage(client, slackChannelId, responseText, msg.ts)
            }

            // Send any images produced by the agent
            if (result.images?.length) {
                for (let i = 0; i < result.images.length; i++) {
                    await this.uploadImage(client, slackChannelId, result.images[i], `image_${i + 1}`, msg.ts).catch(e =>
                        console.warn('[Slack] Failed to upload image:', (e as Error).message)
                    )
                }
            }
        } catch (err) {
            const errorMsg = (err as Error).message || 'Unknown error'
            console.error(`[Slack] Agent execution error: ${errorMsg}`)
            await this.postOrUpdate(client, slackChannelId, thinkingTs, `⚠️ Error: ${errorMsg.slice(0, 2900)}`, msg.ts)
        } finally {
            this.activeExecutions.delete(streamId)
            for (const unsub of unsubs) unsub()
        }
    }

    private async handleCommand(
        slackChannelId: string,
        text: string,
        client: WebClient,
        threadTs: string
    ): Promise<boolean> {
        const command = text.slice(1).split(/\s/)[0].toLowerCase()

        if (command === 'stop') {
            let cancelled = 0
            for (const [id, entry] of this.activeExecutions) {
                entry.controller.abort()
                this.activeExecutions.delete(id)
                cancelled++
            }
            const reply = cancelled > 0
                ? `⏹ Stopped ${cancelled} running execution(s).`
                : '✅ No executions are currently running.'
            await client.chat.postMessage({ channel: slackChannelId, text: reply, thread_ts: threadTs }).catch(() => { })
            return true
        }

        if (command === 'new') {
            this.cancelExecutionsForChannel(slackChannelId)
            const effectiveAgentId = this.channelAgentOverride.get(slackChannelId) || this.agentId
            this.archiveConversation(slackChannelId, effectiveAgentId)
            const agent = getAgent(effectiveAgentId)
            await client.chat.postMessage({ channel: slackChannelId, text: `🆕 Starting a fresh conversation with *${agent?.name || 'Unknown'}*.` }).catch(() => { })
            return true
        }

        if (command === 'start') {
            this.cancelExecutionsForChannel(slackChannelId)
            const prevAgentId = this.channelAgentOverride.get(slackChannelId) || this.agentId
            this.channelAgentOverride.delete(slackChannelId)
            this.archiveConversation(slackChannelId, prevAgentId)
            const agent = getAgent(this.agentId)
            await client.chat.postMessage({ channel: slackChannelId, text: `🔄 Switched back to default agent: *${agent?.name || 'Unknown'}*\n\nStarting a fresh conversation.` }).catch(() => { })
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
            this.cancelExecutionsForChannel(slackChannelId)
            const prevAgentId = this.channelAgentOverride.get(slackChannelId) || this.agentId
            this.archiveConversation(slackChannelId, prevAgentId)
            this.channelAgentOverride.set(slackChannelId, matchedAgent.id)
            await client.chat.postMessage({
                channel: slackChannelId,
                text: `🔀 Switched to *${matchedAgent.name}*. Starting a fresh conversation.\n\nUse \`!start\` to switch back.`
            }).catch(() => { })
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
            const slackChannelId = this.conversationToChannel.get(data.conversationId)
            if (!slackChannelId) return

            const toolNames = data.toolCalls.map(tc => `\`${tc.function.name}\``).join(', ')

            this.app.client.chat.postMessage({
                channel: slackChannelId,
                text: `🔐 *Tool approval required*\n\nThe agent wants to use: ${toolNames}\n\nApprove or deny?`,
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `🔐 *Tool approval required*\n\nThe agent wants to use: ${toolNames}`
                        }
                    },
                    {
                        type: 'actions',
                        elements: [
                            {
                                type: 'button',
                                text: { type: 'plain_text', text: '✅ Approve' },
                                style: 'primary',
                                action_id: `hitl:${data.taskId}:approve`
                            },
                            {
                                type: 'button',
                                text: { type: 'plain_text', text: '❌ Deny' },
                                style: 'danger',
                                action_id: `hitl:${data.taskId}:deny`
                            }
                        ]
                    }
                ]
            })
                .then((result) => {
                    if (result.ts) {
                        this.pendingHITL.set(data.taskId, {
                            slackChannelId,
                            messageTs: result.ts,
                            resolve: data.resolve
                        })
                    }
                })
                .catch(() => { })
        })
    }

    private async handleHITLAction(
        actionId: string,
        client: WebClient,
        body: Record<string, unknown>
    ): Promise<void> {
        const parts = actionId.split(':')
        const taskId = parts[1]
        const action = parts[2]
        const pending = this.pendingHITL.get(taskId)

        if (!pending) return

        this.pendingHITL.delete(taskId)
        const approved = action === 'approve'

        pending.resolve({ approved, reason: approved ? undefined : 'Denied via Slack' })

        this.broadcast('agent:hitl-resolved', { taskId, approved })
        getEventBus().emit('hitl:resolved', { taskId })
        try { getDb().prepare('DELETE FROM pending_hitl WHERE task_id = ?').run(taskId) } catch { /* ignore */ }

        const statusText = approved ? '✅ *Approved* — proceeding...' : '❌ *Denied* — the agent will try a different approach.'
        await client.chat.update({
            channel: pending.slackChannelId,
            ts: pending.messageTs,
            text: statusText,
            blocks: [{ type: 'section', text: { type: 'mrkdwn', text: statusText } }]
        }).catch(() => { })
    }

    private getOrCreateConversation(slackChannelId: string, senderName: string, agentId?: string): string {
        const db = getDb()
        const resolvedAgentId = agentId || this.agentId
        const channelKey = `slack:${this.channelId}:${slackChannelId}`

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

    private archiveConversation(slackChannelId: string, agentId: string): void {
        const db = getDb()
        const channelKey = `slack:${this.channelId}:${slackChannelId}`

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

    /** Cancel all active executions whose conversationId maps to the given Slack channelId. */
    private cancelExecutionsForChannel(slackChannelId: string): void {
        for (const [id, entry] of this.activeExecutions) {
            const execChannelId = this.conversationToChannel.get(entry.exec.conversationId)
            if (execChannelId === slackChannelId) {
                entry.controller.abort()
                this.activeExecutions.delete(id)
            }
        }
    }

    private async postOrUpdate(
        client: WebClient,
        channel: string,
        ts: string | null,
        text: string,
        threadTs?: string
    ): Promise<void> {
        if (ts) {
            await client.chat.update({ channel, ts, text }).catch(() => { })
        } else {
            await client.chat.postMessage({ channel, text, thread_ts: threadTs }).catch(() => { })
        }
    }

    private async sendLongSlackMessage(
        client: WebClient,
        channel: string,
        text: string,
        threadTs?: string
    ): Promise<void> {
        // Slack max message length is ~40000, but 3000 is a good per-message limit for readability
        const MAX_LEN = 3000
        if (text.length <= MAX_LEN) {
            await client.chat.postMessage({ channel, text, thread_ts: threadTs }).catch(() => { })
            return
        }
        let remaining = text
        while (remaining.length > 0) {
            if (remaining.length <= MAX_LEN) {
                await client.chat.postMessage({ channel, text: remaining, thread_ts: threadTs }).catch(() => { })
                break
            }
            let splitAt = remaining.lastIndexOf('\n\n', MAX_LEN)
            if (splitAt < MAX_LEN / 2) splitAt = remaining.lastIndexOf('\n', MAX_LEN)
            if (splitAt < MAX_LEN / 2) splitAt = MAX_LEN
            await client.chat.postMessage({ channel, text: remaining.slice(0, splitAt), thread_ts: threadTs }).catch(() => { })
            remaining = remaining.slice(splitAt).trimStart()
        }
    }

    /** Upload a base64 data-URL image to a Slack channel. */
    private async uploadImage(
        client: WebClient,
        channel: string,
        dataUrl: string,
        title: string,
        threadTs?: string
    ): Promise<void> {
        const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
        if (!match) return
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
        const buffer = Buffer.from(match[2], 'base64')
        const uploadArgs: Record<string, unknown> = {
            channel_id: channel,
            file: buffer,
            filename: `${title}.${ext}`,
            title
        }
        if (threadTs) uploadArgs.thread_ts = threadTs
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await client.filesUploadV2(uploadArgs as any)
    }
}
