import { getDb } from '../../../db/database.js'
import { getGateway } from '../../gateway/gateway.js'
import { AgentExecutor, MAIN_AGENT_MAX_ROUNDS } from '../../agent/agent-executor.js'
import { planExecution } from '../../agent/pre-execution/execution-planner.js'
import { closePlanningRun } from '../../agent/planning-state.js'
import { generateTitle } from '../../agent/post-execution.js'
import { getAgent } from '../../agents/agent-store.js'
import { getToolRegistry } from '../../tools/tool-registry.js'
import { getEventBus } from '../../telemetry/event-bus.js'
import { getAssignedMemoryFolders } from '../../memory/memory-folder-scope.js'
import { buildInitialExecutionConfig } from '../../chat/run-config.js'
import type { ChatMessage, ContentPart } from '../../gateway/providers/base.provider.js'
import { nanoid } from 'nanoid'
import type { DiscordCtx } from './discord.types.js'
import { handleCommand } from './discord.commands.js'
import { sendLongMessage, dataUrlToBuffer, extractAttachments, type DiscordSendChannel } from './discord.api.js'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import type { Message, Interaction } from 'discord.js'
import {
    applyChannelContextLimit, beginChannelExecution, buildChannelHistory, finishChannelExecution,
    materializeChannelInputAudio, materializeChannelInputImages, persistChannelAssistantMessage, persistChannelExecutionConfig, persistChannelUserMessage, publishChannelStreamError,
    updateChannelExecution,
    channelImageDataUrl,
} from '../channel-execution.js'

export async function handleMessage(ctx: DiscordCtx, msg: Message): Promise<void> {
    if (msg.author.id === ctx.client.user?.id) return
    if (msg.author.bot) return

    const hasAttachments = msg.attachments.size > 0
    const hasText = !!msg.content?.trim()
    if (!hasText && !hasAttachments) return

    const discordChannelId = msg.channel.id
    const text = (msg.content || '').trim()

    if (text.startsWith('!') || text.startsWith('/')) {
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

    if (userText.startsWith('!') || userText.startsWith('/')) {
        const handled = await handleCommand(ctx, msg, userText)
        if (handled) return
    }

    const imageDataUrls: string[] = []
    const audioDataUrls: string[] = []
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
        thinkingMsg = await msg.reply('🧭 Preparing context...')
    } catch { }
    let thinkingSeconds = 0
    let thinkingPhase = 'Preparing context'
    let thinkingTimer: ReturnType<typeof setInterval> | null = null
    const conversationId = getOrCreateConversation(ctx, discordChannelId, senderName, effectiveAgentId)
    ctx.conversationToChannel.set(conversationId, discordChannelId)

    const db = getDb()
    const now = Date.now()
    const storedImageUrls = await materializeChannelInputImages(imageDataUrls, conversationId)
    const storedAudioUrls = await materializeChannelInputAudio(audioDataUrls, conversationId)
    const userMsgId = nanoid()
    persistChannelUserMessage({ broadcast: ctx.broadcast, conversationId, messageId: userMsgId,
        content: userText || '(attached media)', images: storedImageUrls, audio: storedAudioUrls, createdAt: now })

    let messages: ChatMessage[] = buildChannelHistory(conversationId, effectiveAgentId).messages

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
    if (thinkingMsg) {
        thinkingTimer = setInterval(() => {
            thinkingSeconds++
            const icon = thinkingPhase === 'Preparing context' ? '🧭' : '🤔'
            thinkingMsg!.edit(`${icon} ${thinkingPhase} (${thinkingSeconds}s)`).catch(() => { })
        }, 1000)
    }

    const unsubs: Array<() => void> = []
    const { streamId, controller: execAbort } = beginChannelExecution({
        executions: ctx.activeExecutions, channelId: ctx.channelId, agent: resolvedAgent,
        conversationId, broadcast: ctx.broadcast,
    })
    let planned: Awaited<ReturnType<typeof planExecution>> | undefined
    try {
        planned = await planExecution({
            resolvedAgent, conversationId, broadcast: ctx.broadcast, abortSignal: execAbort.signal,
            gateway: getGateway(), toolRegistry: getToolRegistry(), messages, userText,
            run: {
                memoryFolderOverrides: getAssignedMemoryFolders(resolvedAgent.id),
                autoMemory: resolvedAgent.autoMemory === true,
                thinkingEnabled: resolvedAgent.thinkingEnabled !== false,
            },
        })
        updateChannelExecution(ctx.activeExecutions, streamId, { model: planned.responseModel, planningRunId: planned.planningRunId })
        if (execAbort.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
        persistChannelExecutionConfig(conversationId, resolvedAgent, planned)
        const context = await applyChannelContextLimit({ gateway: getGateway(), planned, agent: resolvedAgent, messages: planned.messages })
        messages = context.messages
        thinkingPhase = 'Thinking'
        if (thinkingMsg) await thinkingMsg.edit(`🤔 Thinking (${thinkingSeconds}s)`).catch(() => { })
        const executor = new AgentExecutor({
            gateway: getGateway(), tools: planned.tools, conversationId, broadcast: ctx.broadcast,
            providerId: planned.providerId, model: planned.responseModel, hitl: !resolvedAgent.autoApproveTools,
            maxRounds: MAIN_AGENT_MAX_ROUNDS, thinkingEnabled: resolvedAgent.thinkingEnabled !== false,
            reasoningEffort: resolvedAgent.reasoningEffort, streamMode: 'single', signal: execAbort.signal,
            streamId, agentId: effectiveAgentId, agentName: resolvedAgent.name,
            agentIconUrl: resolvedAgent.iconUrl || null, planningRunId: planned.planningRunId,
            contextWindow: context.contextWindow, initialContextEstimate: context.initialContextEstimate,
            contextStrategy: 'sliding-window', isPrimaryExecutor: true,
        })

    const eventBus = getEventBus()
    // Thinking display is disabled
    // let accumulatedThinking = ''
    // let thinkingEditQueued = false
    // const THINKING_EDIT_INTERVAL_MS = 2000

    let sendChain = Promise.resolve()
    const enqueueSend = (fn: () => Promise<void>): void => {
        sendChain = sendChain.then(fn, fn)
    }
    ctx.conversationSendQueue.set(conversationId, enqueueSend)

    if (thinkingMsg) {
        unsubs.push(() => { if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null } })

        // Thinking display is disabled — live thinking updates are omitted
        // unsubs.push(eventBus.on('step:thinking', (...args: unknown[]) => {
        //     const data = args[0] as { conversationId: string; thinking: string }
        //     if (data.conversationId !== conversationId) return
        //     accumulatedThinking += data.thinking
        //     if (!thinkingEditQueued) {
        //         thinkingEditQueued = true
        //         setTimeout(() => {
        //             thinkingEditQueued = false
        //             const MAX_THINKING = 1900
        //             const display = accumulatedThinking.length > MAX_THINKING
        //                 ? '…' + accumulatedThinking.slice(-MAX_THINKING)
        //                 : accumulatedThinking
        //             thinkingMsg!.edit(`💭 **Thinking**\n\n${display}`).catch(() => { })
        //         }, THINKING_EDIT_INTERVAL_MS)
        //     }
        // }))

        // Intentionally suppress verbose tool argument dumps in channel chats.
        // We only send compact post-execution status lines in step:executed.

        unsubs.push(eventBus.on('step:executed', (...args: unknown[]) => {
            const data = args[0] as { conversationId: string; iteration: number; results: { name: string; success: boolean; output: string; imageDataUrls?: string[] }[]; maCodename?: string }
            if (data.conversationId !== conversationId) return
            const prefix = data.maCodename ? `🤖 **[${data.maCodename}]** ` : ''
            const lines = data.results.map(r =>
                r.success ? `✅ \`${r.name}\` executed` : `❌ \`${r.name}\` failed`
            )
            enqueueSend(async () => {
                if (lines.length && 'send' in msg.channel) {
                    await (msg.channel as DiscordSendChannel).send(`${prefix}${lines.join('\n')}`.slice(0, 2000)).catch(() => { })
                }
                for (const r of data.results) {
                    if (r.imageDataUrls?.length && 'send' in msg.channel) {
                        const files = r.imageDataUrls.map((dataUrl, i) => {
                            const { buffer, ext } = dataUrlToBuffer(dataUrl)
                            return { attachment: buffer, name: `tool_${r.name}_${i + 1}.${ext}` }
                        })
                        await (msg.channel as DiscordSendChannel).send({ files }).catch((e: Error) =>
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

    // Per-sub-agent streaming content buffers
    const subAgentContent = new Map<string, { content: string; msg: Message | null; timer: ReturnType<typeof setTimeout> | null }>()

    unsubs.push(eventBus.on('step:content', (...args: unknown[]) => {
        const data = args[0] as { conversationId: string; content: string; maCodename?: string }
        if (data.conversationId !== conversationId) return

        if (data.maCodename) {
            // Sub-agent content — stream as a separate message per sub-agent
            const codename = data.maCodename
            if (!subAgentContent.has(codename)) {
                subAgentContent.set(codename, { content: '', msg: null, timer: null })
            }
            const sa = subAgentContent.get(codename)!
            sa.content += data.content
            if (sa.timer) clearTimeout(sa.timer)
            if (!executionFinished) {
                sa.timer = setTimeout(async () => {
                    sa.timer = null
                    const prefix = `🤖 **[${codename}]**\n\n`
                    const MAX_LEN = 1900
                    const raw = prefix + sa.content
                    const display = raw.length > MAX_LEN ? raw.slice(0, MAX_LEN) + '…' : raw
                    if (!sa.msg && 'send' in msg.channel) {
                        try { sa.msg = await (msg.channel as DiscordSendChannel).send(display + ' ▍') } catch { }
                    } else if (sa.msg) {
                        await sa.msg.edit(display + ' ▍').catch(() => { })
                    }
                }, CONTENT_EDIT_INTERVAL_MS)
            }
            return
        }

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
                        responseState.msg = await (msg.channel as DiscordSendChannel).send(display + ' ▍')
                    } catch { }
                } else if (responseState.msg) {
                    await responseState.msg.edit(display + ' ▍').catch(() => { })
                }
            }, CONTENT_EDIT_INTERVAL_MS)
        }
    }))

        const result = await executor.run(messages)
        if (planned.planningRunId) {
            closePlanningRun(planned.planningRunId, 'completed', { summary: result.content.slice(0, 500) })
        }
        executionFinished = true
        if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null }
        if (contentEditTimer) { clearTimeout(contentEditTimer); contentEditTimer = null }
        ctx.conversationSendQueue.delete(conversationId)
        await sendChain

        // Finalize sub-agent messages
        for (const [codename, sa] of subAgentContent.entries()) {
            if (sa.timer) { clearTimeout(sa.timer); sa.timer = null }
            if (sa.content) {
                const prefix = `🤖 **[${codename}]**\n\n`
                const text = prefix + sa.content
                if (sa.msg) {
                    if (text.length <= 2000) {
                        await sa.msg.edit(text).catch(() => { })
                    } else {
                        await sa.msg.edit(text.slice(0, 2000)).catch(() => { })
                        if ('send' in msg.channel) await sendLongMessage(msg.channel as DiscordSendChannel, text.slice(2000))
                    }
                } else if ('send' in msg.channel) {
                    await sendLongMessage(msg.channel as DiscordSendChannel, text)
                }
            }
        }

        persistChannelAssistantMessage({ conversationId, agentId: effectiveAgentId, planned, result, startedAt: now })

        const convMeta = db.prepare("SELECT json_extract(metadata_json, '$.titleGenerated') as tg FROM conversations WHERE id = ?")
            .get(conversationId) as { tg: number | null } | undefined
        if (!convMeta?.tg) {
            db.prepare("UPDATE conversations SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.titleGenerated', 1) WHERE id = ?")
                .run(conversationId)
            generateTitle({
                conversationId,
                userMessage: userText,
                assistantResponse: result.content,
                broadcast: ctx.broadcast,
                providerId: planned.responseProvider,
                model: planned.responseModel
            }).catch(() => { })
        }

        const responseText = result.content || '(no response)'
        if (thinkingMsg) {
            const durationSec = Math.round((Date.now() - now) / 1000)
            await thinkingMsg.edit(`✅ Done thinking (${durationSec}s)`).catch(() => { })
        }

        if (responseState.msg) {
            if (responseText.length <= 2000) {
                await responseState.msg.edit(responseText).catch(() => { })
            } else {
                await responseState.msg.edit(responseText.slice(0, 2000)).catch(() => { })
                if ('send' in msg.channel) await sendLongMessage(msg.channel as DiscordSendChannel, responseText.slice(2000))
            }
        } else if ('send' in msg.channel) {
            await sendLongMessage(msg.channel as DiscordSendChannel, responseText)
        }

        if (result.images?.length && 'send' in msg.channel) {
            const files = result.images.flatMap((image, i) => {
                const dataUrl = channelImageDataUrl(image)
                if (!dataUrl) return []
                const { buffer, ext } = dataUrlToBuffer(dataUrl)
                return [{ attachment: buffer, name: `image_${i + 1}.${ext}` }]
            })
            if (files.length) {
                await (msg.channel as DiscordSendChannel).send({ files }).catch((e: Error) =>
                    console.warn('[Discord] Failed to send images:', e.message)
                )
            }
        }
    } catch (err) {
        if (planned?.planningRunId) {
            closePlanningRun(
                planned.planningRunId,
                (err as Error).name === 'AbortError' ? 'cancelled' : 'error',
                { error: (err as Error).name === 'AbortError' ? 'Cancelled' : (err as Error).message }
            )
        }
        if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null }
        const errorMsg = (err as Error).message || 'Unknown error'
        console.error(`[Discord] Agent execution error: ${errorMsg}`)
        getEventBus().emit('task:error', { conversationId, error: execAbort.signal.aborted ? 'Cancelled' : errorMsg })
        if (!execAbort.signal.aborted) publishChannelStreamError(ctx.broadcast, conversationId, streamId, errorMsg)
        if (thinkingMsg) {
            await thinkingMsg.edit(execAbort.signal.aborted ? '⏹ Stopped.' : `⚠️ Error: ${errorMsg.slice(0, 1900)}`).catch(() => { })
        } else {
            await msg.reply(`⚠️ Error: ${errorMsg.slice(0, 1900)}`).catch(() => { })
        }
    } finally {
        finishChannelExecution({ executions: ctx.activeExecutions, executionId: streamId, conversationId, agentId: effectiveAgentId, broadcast: ctx.broadcast })
        for (const unsub of unsubs) unsub()
    }
}

export function getOrCreateConversation(ctx: DiscordCtx, discordChannelId: string, senderName: string, agentId?: string): string {
    const db = getDb()
    const resolvedAgentId = agentId || ctx.agentId
    const channelKey = `discord:${ctx.channelId}:${discordChannelId}`

    const existing = db
        .prepare("SELECT id FROM conversations WHERE origin = 'channel' AND agent_id = ? AND json_extract(metadata_json, '$.channelKey') = ? AND json_extract(metadata_json, '$.archived') IS NULL")
        .get(resolvedAgentId, channelKey) as { id: string } | undefined

    if (existing) return existing.id

    const id = nanoid()
    const now = Date.now()
    const metadataJson = JSON.stringify({ channelKey })
    const agent = getAgent(resolvedAgentId)
    const memoryFolderIds = getAssignedMemoryFolders(resolvedAgentId).map((space) => space.id)
    const executionConfig = buildInitialExecutionConfig({ agent, memoryFolderIds })
    db.prepare(
        'INSERT INTO conversations (id, title, agent_id, origin, execution_config_json, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, senderName, resolvedAgentId, 'channel', JSON.stringify(executionConfig), metadataJson, now, now)

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
                const sentMsg = await (channel as DiscordSendChannel).send({ content: text, components: [row] })
                ctx.pendingHITL.set(data.taskId, {
                    conversationId: data.conversationId,
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
    ctx.broadcast('agent:hitl-resolved', { taskId, conversationId: pending.conversationId, approved })
    getEventBus().emit('hitl:resolved', { taskId, conversationId: pending.conversationId })
    try { getDb().prepare('DELETE FROM pending_hitl WHERE task_id = ?').run(taskId) } catch { }

    const statusText = approved ? '✅ **Approved** — proceeding...' : '❌ **Denied** — the agent will try a different approach.'
    await interaction.update({ content: statusText, components: [] }).catch(() => { })
}
