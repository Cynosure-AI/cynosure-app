import { getDb } from '../../../db/database.js'
import { getGateway } from '../../gateway/gateway.js'
import { AgentExecutor } from '../../agent/agent-executor.js'
import { prepareAgentExecution } from '../../agent/prepare-execution.js'
import { generateTitle } from '../../agent/post-execution.js'
import { getAgent } from '../../agents/agent-store.js'
import { getEventBus } from '../../telemetry/event-bus.js'
import type { ChatMessage, ContentPart } from '../../gateway/providers/base.provider.js'
import { nanoid } from 'nanoid'
import type { DiscordCtx } from './discord.types.js'
import { handleCommand } from './discord.commands.js'
import { sendLongMessage, dataUrlToBuffer, extractAttachments } from './discord.api.js'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import type { Message, Interaction } from 'discord.js'

export async function handleMessage(ctx: DiscordCtx, msg: Message): Promise<void> {
    if (msg.author.id === ctx.client.user?.id) return
    if (msg.author.bot) return

    const hasAttachments = msg.attachments.size > 0
    const hasText = !!msg.content?.trim()
    if (!hasText && !hasAttachments) return

    const discordChannelId = msg.channel.id
    const text = (msg.content || '').trim()

    if (text.startsWith('!')) {
        const handled = await handleCommand(ctx, msg, text)
        if (handled) return
    }

    if (hasAttachments && !hasText) {
        try {
            const { imageDataUrls, audioDataUrls } = await extractAttachments(msg)
            if (imageDataUrls.length || audioDataUrls.length) {
                const existing = ctx.pendingAttachments.get(discordChannelId) || { imageDataUrls: [], audioDataUrls: [] }
                existing.imageDataUrls.push(...imageDataUrls)
                existing.audioDataUrls.push(...audioDataUrls)
                ctx.pendingAttachments.set(discordChannelId, existing)
                await msg.reply('📎 Attachment received. Send a message to use it with the agent.').catch(() => { })
            }
        } catch {
            await msg.reply('⚠️ Failed to process attachment.').catch(() => { })
        }
        return
    }

    const prev = ctx.channelLocks.get(discordChannelId) || Promise.resolve()
    let unlock: () => void
    const lock = new Promise<void>(resolve => { unlock = resolve })
    ctx.channelLocks.set(discordChannelId, lock)
    await prev

    try {
        await processMessage(ctx, msg)
    } finally {
        unlock!()
        if (ctx.channelLocks.get(discordChannelId) === lock) ctx.channelLocks.delete(discordChannelId)
    }
}

export async function processMessage(ctx: DiscordCtx, msg: Message): Promise<void> {
    const discordChannelId = msg.channel.id
    const userText = (msg.content || '').trim()
    const senderName = msg.member?.displayName || msg.author.username

    if (userText.startsWith('!')) {
        const handled = await handleCommand(ctx, msg, userText)
        if (handled) return
    }

    let imageDataUrls: string[] = []
    let audioDataUrls: string[] = []
    const buffered = ctx.pendingAttachments.get(discordChannelId)
    if (buffered) {
        imageDataUrls.push(...buffered.imageDataUrls)
        audioDataUrls.push(...buffered.audioDataUrls)
        ctx.pendingAttachments.delete(discordChannelId)
    }

    if (msg.attachments.size > 0) {
        try {
            const extracted = await extractAttachments(msg)
            imageDataUrls.push(...extracted.imageDataUrls)
            audioDataUrls.push(...extracted.audioDataUrls)
        } catch (err) {
            console.warn('[Discord] Failed to extract attachments:', (err as Error).message)
        }
    }

    const hasAttachments = imageDataUrls.length > 0 || audioDataUrls.length > 0
    let userContent: string | ContentPart[] = userText
    if (hasAttachments) {
        const parts: ContentPart[] = [{ type: 'text', text: userText || '(attached media)' }]
        for (const url of imageDataUrls) {
            parts.push({ type: 'image_url', image_url: { url } })
        }
        for (const url of audioDataUrls) {
            parts.push({ type: 'audio_url', audio_url: { url } })
        }
        userContent = parts
    }

    const effectiveAgentId = ctx.channelAgentOverride.get(discordChannelId) || ctx.agentId
    let thinkingMsg: Message | null = null
    try {
        thinkingMsg = await msg.reply('🤔 Thinking...')
    } catch { }

    const conversationId = getOrCreateConversation(ctx, discordChannelId, senderName, effectiveAgentId)
    ctx.conversationToChannel.set(conversationId, discordChannelId)

    const db = getDb()
    const now = Date.now()
    const userMsgId = nanoid()
    db.prepare(
        'INSERT INTO messages (id, conversation_id, role, content, image_urls_json, audio_urls_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
        userMsgId, conversationId, 'user', userText || '(attached media)',
        imageDataUrls.length ? JSON.stringify(imageDataUrls) : null,
        audioDataUrls.length ? JSON.stringify(audioDataUrls) : null,
        now
    )
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)

    ctx.broadcast('chat:new-message', {
        conversationId,
        message: {
            id: userMsgId, conversationId, role: 'user',
            content: userText || '(attached media)',
            imageDataUrls: imageDataUrls.length ? imageDataUrls : undefined,
            audioDataUrls: audioDataUrls.length ? audioDataUrls : undefined,
            createdAt: now
        }
    })

    const historyRows = db
        .prepare('SELECT role, content, tool_calls_json, tool_call_id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
        .all(conversationId) as { role: string; content: string; tool_calls_json: string | null; tool_call_id: string | null }[]

    let messages: ChatMessage[] = historyRows.map((row) => ({
        role: row.role as ChatMessage['role'],
        content: row.content,
        toolCalls: row.tool_calls_json ? JSON.parse(row.tool_calls_json) : undefined,
        toolCallId: row.tool_call_id || undefined
    }))

    if (hasAttachments && messages.length > 0) {
        const lastIdx = messages.length - 1
        messages[lastIdx] = { ...messages[lastIdx], content: userContent }
    }

    const resolvedAgent = getAgent(effectiveAgentId)
    if (!resolvedAgent) {
        if (thinkingMsg) await thinkingMsg.edit('⚠️ Agent not found.').catch(() => { })
        else await msg.reply('⚠️ Agent not found.').catch(() => { })
        return
    }

    const isFirstUserMessage = historyRows.filter(r => r.role === 'user').length === 1
    const prepared = await prepareAgentExecution({
        agent: resolvedAgent,
        conversationId,
        broadcast: ctx.broadcast,
        userQuery: userText,
        isFirstMessage: isFirstUserMessage,
        signal: AbortSignal.timeout(300_000),
    })
    messages = [...prepared.systemMessages, ...messages]

    const streamId = nanoid()
    const execAbort = new AbortController()
    ctx.activeExecutions.set(streamId, {
        exec: { id: streamId, channelId: ctx.channelId, agentId: effectiveAgentId, conversationId, startedAt: Date.now() },
        controller: execAbort
    })

    const executor = new AgentExecutor({
        gateway: getGateway(),
        tools: prepared.tools,
        conversationId,
        broadcast: ctx.broadcast,
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

    const eventBus = getEventBus()
    const unsubs: Array<() => void> = []
    let accumulatedThinking = ''
    let thinkingEditQueued = false
    const THINKING_EDIT_INTERVAL_MS = 2000

    let sendChain = Promise.resolve()
    const enqueueSend = (fn: () => Promise<void>): void => {
        sendChain = sendChain.then(fn, fn)
    }
    ctx.conversationSendQueue.set(conversationId, enqueueSend)

    if (thinkingMsg) {
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
                    if (r.imageDataUrls?.length && 'send' in msg.channel) {
                        const files = r.imageDataUrls.map((dataUrl, i) => {
                            const { buffer, ext } = dataUrlToBuffer(dataUrl)
                            return { attachment: buffer, name: `tool_${r.name}_${i + 1}.${ext}` }
                        })
                        await (msg.channel as { send: Function }).send({ files }).catch((e: Error) =>
                            console.warn('[Discord] Failed to send tool image:', e.message)
                        )
                    }
                }
            })
        }))

        const typingInterval = setInterval(() => {
            if ('sendTyping' in msg.channel) msg.channel.sendTyping().catch(() => { })
        }, 5000)
        unsubs.push(() => clearInterval(typingInterval))
    }

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
                if (!responseState.msg && 'send' in msg.channel) {
                    try {
                        responseState.msg = await (msg.channel as { send: Function }).send(display + ' ▍') as Message
                    } catch { }
                } else if (responseState.msg) {
                    await responseState.msg.edit(display + ' ▍').catch(() => { })
                }
            }, CONTENT_EDIT_INTERVAL_MS)
        }
    }))

    try {
        const result = await executor.run(messages)
        executionFinished = true
        if (contentEditTimer) { clearTimeout(contentEditTimer); contentEditTimer = null }
        ctx.conversationSendQueue.delete(conversationId)
        await sendChain

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

        const convMeta = db.prepare("SELECT json_extract(config_json, '$.titleGenerated') as tg FROM conversations WHERE id = ?")
            .get(conversationId) as { tg: number | null } | undefined
        if (!convMeta?.tg) {
            db.prepare("UPDATE conversations SET config_json = json_set(COALESCE(config_json, '{}'), '$.titleGenerated', 1) WHERE id = ?")
                .run(conversationId)
            generateTitle({
                conversationId,
                userMessage: userText,
                assistantResponse: result.content,
                broadcast: ctx.broadcast,
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

        if (responseState.msg) {
            if (responseText.length <= 2000) {
                await responseState.msg.edit(responseText).catch(() => { })
            } else {
                await responseState.msg.edit(responseText.slice(0, 2000)).catch(() => { })
                if ('send' in msg.channel) await sendLongMessage(msg.channel as { send: Function }, responseText.slice(2000))
            }
        } else if ('send' in msg.channel) {
            await sendLongMessage(msg.channel as { send: Function }, responseText)
        }

        if (result.images?.length && 'send' in msg.channel) {
            const files = result.images.map((dataUrl, i) => {
                const { buffer, ext } = dataUrlToBuffer(dataUrl)
                return { attachment: buffer, name: `image_${i + 1}.${ext}` }
            })
            await (msg.channel as { send: Function }).send({ files }).catch((e: Error) =>
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
        ctx.activeExecutions.delete(streamId)
        for (const unsub of unsubs) unsub()
    }
}

export function getOrCreateConversation(ctx: DiscordCtx, discordChannelId: string, senderName: string, agentId?: string): string {
    const db = getDb()
    const resolvedAgentId = agentId || ctx.agentId
    const channelKey = `discord:${ctx.channelId}:${discordChannelId}`

    const existing = db
        .prepare("SELECT id FROM conversations WHERE origin = 'channel' AND agent_id = ? AND json_extract(config_json, '$.channelKey') = ? AND json_extract(config_json, '$.archived') IS NULL")
        .get(resolvedAgentId, channelKey) as { id: string } | undefined

    if (existing) return existing.id

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

export function subscribeToHITL(ctx: DiscordCtx): () => void {
    const eventBus = getEventBus()
    return eventBus.on('hitl:request', (...args: unknown[]) => {
        const data = args[0] as {
            taskId: string
            conversationId: string
            toolCalls: { id: string; function: { name: string; arguments: string } }[]
            resolve: (result: { approved: boolean; reason?: string }) => void
        }
        const discordChannelId = ctx.conversationToChannel.get(data.conversationId)
        if (!discordChannelId) return

        const channel = ctx.client.channels.cache.get(discordChannelId)
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
                ctx.pendingHITL.set(data.taskId, {
                    discordChannelId,
                    messageId: sentMsg.id,
                    resolve: data.resolve
                })
            } catch { }
        }

        const enqueue = ctx.conversationSendQueue.get(data.conversationId)
        if (enqueue) {
            enqueue(sendHITL)
        } else {
            sendHITL()
        }
    })
}

export async function handleInteraction(ctx: DiscordCtx, interaction: Interaction): Promise<void> {
    if (!interaction.isButton()) return

    const customId = interaction.customId
    if (!customId.startsWith('hitl:')) return

    const parts = customId.split(':')
    const taskId = parts[1]
    const action = parts[2]
    const pending = ctx.pendingHITL.get(taskId)

    if (!pending) {
        await interaction.reply({ content: 'This approval has already been handled.', ephemeral: true }).catch(() => { })
        return
    }

    ctx.pendingHITL.delete(taskId)
    const approved = action === 'approve'

    pending.resolve({ approved, reason: approved ? undefined : 'Denied via Discord' })
    ctx.broadcast('agent:hitl-resolved', { taskId, approved })
    getEventBus().emit('hitl:resolved', { taskId })
    try { getDb().prepare('DELETE FROM pending_hitl WHERE task_id = ?').run(taskId) } catch { }

    const statusText = approved ? '✅ **Approved** — proceeding...' : '❌ **Denied** — the agent will try a different approach.'
    await interaction.update({ content: statusText, components: [] }).catch(() => { })
}
