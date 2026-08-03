import { getDb } from '../../../db/database.js'
import { getGateway } from '../../gateway/gateway.js'
import { AgentExecutor, MAIN_AGENT_MAX_ROUNDS } from '../../agent/agent-executor.js'
import { planExecution } from '../../agent/pre-execution/execution-planner.js'
import { closePlanningRun } from '../../agent/planning-state.js'
import { generateTitle } from '../../agent/post-execution.js'
import { getAgent } from '../../agents/agent-store.js'
import { getToolRegistry } from '../../tools/tool-registry.js'
import { getEventBus } from '../../telemetry/event-bus.js'
import { getAssignedOrDefaultSpaces } from '../../memory/memory-space-scope.js'
import { buildInitialExecutionConfig } from '../../chat/run-config.js'
import type { ChatMessage, ContentPart } from '../../gateway/providers/base.provider.js'
import { nanoid } from 'nanoid'
import type { TelegramCtx, TelegramUpdate } from './telegram.types.js'
import { handleCommand } from './telegram.commands.js'
import { sendMessage, sendMessageReturningId, editMessage, sendLongMessage, sendChatAction, sendPhoto, answerCallbackQuery } from './telegram.api.js'
import { extractAttachments } from './telegram.attachments.js'
import { isTelegramUserAllowed } from './telegram.security.js'
import {
    applyChannelContextLimit,
    beginChannelExecution,
    buildChannelHistory,
    finishChannelExecution,
    materializeChannelInputImages,
    persistChannelAssistantMessage,
    persistChannelExecutionConfig,
    updateChannelExecution,
    channelImageDataUrl,
} from '../channel-execution.js'

export async function handleMessage(ctx: TelegramCtx, update: TelegramUpdate): Promise<void> {
    const msg = update.message!
    if (msg.chat.type !== 'private' || !isTelegramUserAllowed(ctx.allowedUserIds, msg.from?.id)) return
    const chatId = msg.chat.id
    const text = msg.text || msg.caption || ''

    // Handle slash commands immediately — bypass the chat lock
    if (text.startsWith('/')) {
        const handled = await handleCommand(ctx, chatId, text)
        if (handled) return
    }

    // Check if this message has media attachments
    const hasMedia = !!(msg.photo || msg.document || msg.audio || msg.voice || msg.video || msg.video_note)

    // Media-only message (no caption/text) → buffer the attachment for the next text message
    if (hasMedia && !text) {
        try {
            const { imageDataUrls, audioDataUrls } = await extractAttachments(ctx, msg)
            const existing = ctx.pendingAttachments.get(chatId) || { imageDataUrls: [], audioDataUrls: [] }
            existing.imageDataUrls.push(...imageDataUrls)
            existing.audioDataUrls.push(...audioDataUrls)
            ctx.pendingAttachments.set(chatId, existing)
            await sendMessage(ctx, chatId, '📎 Attachment received. Send a message to use it with the agent.')
        } catch {
            await sendMessage(ctx, chatId, '⚠️ Failed to process attachment.')
        }
        return
    }

    // Serialize messages per chat to prevent race conditions
    const prev = ctx.chatLocks.get(chatId) || Promise.resolve()
    let unlock: () => void
    const lock = new Promise<void>(resolve => { unlock = resolve })
    ctx.chatLocks.set(chatId, lock)
    await prev

    try {
        await processMessage(ctx, update)
    } finally {
        unlock!()
        if (ctx.chatLocks.get(chatId) === lock) ctx.chatLocks.delete(chatId)
    }
}

export async function processMessage(ctx: TelegramCtx, update: TelegramUpdate): Promise<void> {
    const msg = update.message!
    if (msg.chat.type !== 'private' || !isTelegramUserAllowed(ctx.allowedUserIds, msg.from?.id)) return
    const chatId = msg.chat.id
    const userText = msg.text || msg.caption || ''
    const senderName = msg.from?.first_name || 'User'

    if (userText.startsWith('/')) {
        const handled = await handleCommand(ctx, chatId, userText)
        if (handled) return
    }

    // ── Extract attachments from this message + any buffered ones ──
    const hasMedia = !!(msg.photo || msg.document || msg.audio || msg.voice || msg.video || msg.video_note)
    const imageDataUrls: string[] = []
    const audioDataUrls: string[] = []

    const buffered = ctx.pendingAttachments.get(chatId)
    if (buffered) {
        imageDataUrls.push(...buffered.imageDataUrls)
        audioDataUrls.push(...buffered.audioDataUrls)
        ctx.pendingAttachments.delete(chatId)
    }

    if (hasMedia) {
        try {
            const extracted = await extractAttachments(ctx, msg)
            imageDataUrls.push(...extracted.imageDataUrls)
            audioDataUrls.push(...extracted.audioDataUrls)
        } catch (err) {
            console.warn('[Telegram] Failed to extract attachments:', (err as Error).message)
        }
    }

    const hasAttachments = imageDataUrls.length > 0 || audioDataUrls.length > 0

    // Build multimodal content if there are attachments
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

    const effectiveAgentId = ctx.chatAgentOverride.get(chatId) || ctx.agentId
    const thinkingMsgId = await sendMessageReturningId(ctx, chatId, '🧭 Preparing context...')
    let thinkingSeconds = 0
    let thinkingPhase = 'Preparing context'
    let thinkingTimer: ReturnType<typeof setInterval> | null = null
    const conversationId = getOrCreateConversation(ctx, chatId, senderName, effectiveAgentId)
    ctx.conversationToChat.set(conversationId, chatId)
    ctx.conversationToUser.set(conversationId, msg.from!.id)

    const db = getDb()
    const now = Date.now()
    const storedImageUrls = await materializeChannelInputImages(imageDataUrls, conversationId)

    // Save user message
    const userMsgId = nanoid()
    db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, image_urls_json, audio_urls_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
        userMsgId, conversationId, 'user', userText || '(attached media)',
        storedImageUrls.length ? JSON.stringify(storedImageUrls) : null,
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

    let messages: ChatMessage[] = buildChannelHistory(conversationId, effectiveAgentId).messages

    if (hasAttachments && messages.length > 0) {
        const lastIdx = messages.length - 1
        messages[lastIdx] = { ...messages[lastIdx], content: userContent }
    }

    const resolvedAgent = getAgent(effectiveAgentId)
    if (!resolvedAgent) {
        if (thinkingMsgId) await editMessage(ctx, chatId, thinkingMsgId, '⚠️ Agent not found.')
        else await sendMessage(ctx, chatId, '⚠️ Agent not found.')
        return
    }
    if (thinkingMsgId) {
        thinkingTimer = setInterval(() => {
            thinkingSeconds++
            const icon = thinkingPhase === 'Preparing context' ? '🧭' : '🤔'
            editMessage(ctx, chatId, thinkingMsgId, `${icon} ${thinkingPhase} (${thinkingSeconds}s)`).catch(() => { })
        }, 1000)
    }

    const { streamId, controller: execAbort } = beginChannelExecution({
        executions: ctx.activeExecutions,
        channelId: ctx.channelId,
        agent: resolvedAgent,
        conversationId,
        broadcast: ctx.broadcast,
    })
    let planned: Awaited<ReturnType<typeof planExecution>> | undefined
    const unsubs: Array<() => void> = []
    try {
        planned = await planExecution({
            resolvedAgent,
            conversationId,
            broadcast: ctx.broadcast,
            abortSignal: execAbort.signal,
            gateway: getGateway(),
            toolRegistry: getToolRegistry(),
            messages,
            userText,
            run: {
                memorySpaceOverrides: getAssignedOrDefaultSpaces(resolvedAgent.id),
                autoMemory: resolvedAgent.autoMemory === true,
                thinkingEnabled: resolvedAgent.thinkingEnabled !== false,
            },
        })
        updateChannelExecution(ctx.activeExecutions, streamId, {
            model: planned.responseModel,
            planningRunId: planned.planningRunId,
        })
        if (execAbort.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
        persistChannelExecutionConfig(conversationId, resolvedAgent, planned)
        const context = await applyChannelContextLimit({
            gateway: getGateway(), planned, agent: resolvedAgent, messages: planned.messages,
        })
        messages = context.messages
        thinkingPhase = 'Thinking'
        if (thinkingMsgId) {
            await editMessage(ctx, chatId, thinkingMsgId, `🤔 Thinking (${thinkingSeconds}s)`).catch(() => { })
        }

        const executor = new AgentExecutor({
            gateway: getGateway(),
            tools: planned.tools,
            conversationId,
            broadcast: ctx.broadcast,
            providerId: planned.providerId,
            model: planned.responseModel,
            hitl: !resolvedAgent.autoApproveTools,
            maxRounds: MAIN_AGENT_MAX_ROUNDS,
            thinkingEnabled: resolvedAgent.thinkingEnabled !== false,
            reasoningEffort: resolvedAgent.reasoningEffort,
            streamMode: 'single',
            signal: execAbort.signal,
            streamId,
            agentId: effectiveAgentId,
            agentName: resolvedAgent.name,
            agentIconUrl: resolvedAgent.iconUrl || null,
            planningRunId: planned.planningRunId,
            contextWindow: context.contextWindow,
            initialContextEstimate: context.initialContextEstimate,
            contextStrategy: 'sliding-window',
            isPrimaryExecutor: true,
        })

    // ── Set up EventBus listeners ──
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

    if (thinkingMsgId) {
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
        //             const MAX_THINKING = 3800
        //             const display = accumulatedThinking.length > MAX_THINKING
        //                 ? '…' + accumulatedThinking.slice(-MAX_THINKING)
        //                 : accumulatedThinking
        //             editMessage(ctx, chatId, thinkingMsgId!, `💭 *Thinking*\n\n${display}`).catch(() => { })
        //         }, THINKING_EDIT_INTERVAL_MS)
        //     }
        // }))

        // Intentionally suppress verbose tool argument dumps in channel chats.
        // We only send compact post-execution status lines in step:executed.

        unsubs.push(eventBus.on('step:executed', (...args: unknown[]) => {
            const data = args[0] as { conversationId: string; iteration: number; results: { name: string; success: boolean; output: string; imageDataUrls?: string[] }[]; maCodename?: string }
            if (data.conversationId !== conversationId) return
            const prefix = data.maCodename ? `🤖 *[${data.maCodename}]* ` : ''
            const lines = data.results.map(r =>
                r.success ? `✅ \`${r.name}\` executed` : `❌ \`${r.name}\` failed`
            )
            enqueueSend(async () => {
                if (lines.length) {
                    await sendMessage(ctx, chatId, `${prefix}${lines.join('\n')}`.slice(0, 4000)).catch(() => { })
                }
                for (const r of data.results) {
                    if (r.imageDataUrls?.length) {
                        for (const dataUrl of r.imageDataUrls) {
                            await sendPhoto(ctx, chatId, dataUrl, thinkingMsgId!).catch(e =>
                                console.warn('[Telegram] Failed to send tool image:', (e as Error).message)
                            )
                        }
                    }
                }
            })
        }))

        const typingInterval = setInterval(() => {
            sendChatAction(ctx, chatId, 'typing').catch(() => { })
        }, 4000)
        unsubs.push(() => clearInterval(typingInterval))
    }

    // Live response content streaming
    let accumulatedContent = ''
    let responseMsgId: number | null = null
    let contentEditQueued = false
    let contentEditTimer: ReturnType<typeof setTimeout> | null = null
    let executionFinished = false
    const CONTENT_EDIT_INTERVAL_MS = 1500

    // Per-sub-agent streaming content buffers
    const subAgentContent = new Map<string, { content: string; msgId: number | null; timer: ReturnType<typeof setTimeout> | null }>()

    unsubs.push(eventBus.on('step:content', (...args: unknown[]) => {
        const data = args[0] as { conversationId: string; content: string; maCodename?: string }
        if (data.conversationId !== conversationId) return

        if (data.maCodename) {
            // Sub-agent content — stream as a separate message per sub-agent
            const codename = data.maCodename
            if (!subAgentContent.has(codename)) {
                subAgentContent.set(codename, { content: '', msgId: null, timer: null })
            }
            const sa = subAgentContent.get(codename)!
            sa.content += data.content
            if (sa.timer) clearTimeout(sa.timer)
            if (!executionFinished) {
                sa.timer = setTimeout(async () => {
                    sa.timer = null
                    const prefix = `🤖 *[${codename}]*\n\n`
                    const MAX_LEN = 4000
                    const raw = prefix + sa.content
                    const display = raw.length > MAX_LEN ? raw.slice(0, MAX_LEN) + '…' : raw
                    if (!sa.msgId) {
                        sa.msgId = await sendMessageReturningId(ctx, chatId, display + ' ▍')
                    } else {
                        await editMessage(ctx, chatId, sa.msgId, display + ' ▍').catch(() => { })
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
                const MAX_LEN = 4000
                const display = accumulatedContent.length > MAX_LEN
                    ? accumulatedContent.slice(0, MAX_LEN) + '…'
                    : accumulatedContent
                if (!responseMsgId) {
                    responseMsgId = await sendMessageReturningId(ctx, chatId, display + ' ▍')
                } else {
                    await editMessage(ctx, chatId, responseMsgId, display + ' ▍').catch(() => { })
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
                const prefix = `🤖 *[${codename}]*\n\n`
                const text = prefix + sa.content
                if (sa.msgId) {
                    if (text.length <= 4000) {
                        await editMessage(ctx, chatId, sa.msgId, text)
                    } else {
                        await editMessage(ctx, chatId, sa.msgId, text.slice(0, 4000))
                        await sendLongMessage(ctx, chatId, text.slice(4000))
                    }
                } else {
                    await sendLongMessage(ctx, chatId, text)
                }
            }
        }

        persistChannelAssistantMessage({ conversationId, agentId: effectiveAgentId, planned, result, startedAt: now })

        // Auto-generate conversation title
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

        // Finalize thinking message
        if (thinkingMsgId) {
            const durationSec = Math.round((Date.now() - now) / 1000)
            await editMessage(ctx, chatId, thinkingMsgId, `✅ Done thinking (${durationSec}s)`)
        }

        // Send final response
        const responseText = result.content || '(no response)'
        if (responseMsgId) {
            if (responseText.length <= 4000) {
                await editMessage(ctx, chatId, responseMsgId, responseText)
            } else {
                await editMessage(ctx, chatId, responseMsgId, responseText.slice(0, 4000))
                await sendLongMessage(ctx, chatId, responseText.slice(4000))
            }
        } else {
            await sendLongMessage(ctx, chatId, responseText)
        }

        if (result.images?.length) {
            for (const image of result.images) {
                const dataUrl = channelImageDataUrl(image)
                if (!dataUrl) continue
                await sendPhoto(ctx, chatId, dataUrl).catch(e =>
                    console.warn('[Telegram] Failed to send response image:', (e as Error).message)
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
        console.error(`[Telegram] Agent execution error: ${errorMsg}`)
        getEventBus().emit('task:error', { conversationId, error: execAbort.signal.aborted ? 'Cancelled' : errorMsg })
        if (!execAbort.signal.aborted) ctx.broadcast('chat:stream-error', { streamId, conversationId, error: errorMsg })
        if (thinkingMsgId) {
            await editMessage(ctx, chatId, thinkingMsgId, execAbort.signal.aborted ? '⏹ Stopped.' : `⚠️ Error: ${errorMsg}`)
        } else {
            await sendMessage(ctx, chatId, `⚠️ Error: ${errorMsg}`)
        }
    } finally {
        finishChannelExecution({ executions: ctx.activeExecutions, executionId: streamId, conversationId, agentId: effectiveAgentId, broadcast: ctx.broadcast })
        for (const unsub of unsubs) unsub()
    }
}

/** Subscribe to HITL approval requests and forward them to Telegram as inline buttons. Returns unsub function. */
export function subscribeToHITL(ctx: TelegramCtx): () => void {
    const eventBus = getEventBus()
    return eventBus.on('hitl:request', (...args: unknown[]) => {
        const data = args[0] as {
            taskId: string
            conversationId: string
            toolCalls: { id: string; function: { name: string; arguments: string } }[]
            resolve: (result: { approved: boolean; reason?: string }) => void
        }
        const chatId = ctx.conversationToChat.get(data.conversationId)
        const userId = ctx.conversationToUser.get(data.conversationId)
        if (chatId === undefined || userId === undefined || !isTelegramUserAllowed(ctx.allowedUserIds, userId)) return

        const toolNames = data.toolCalls.map(tc => `\`${tc.function.name}\``).join(', ')
        const text = `🔐 *Tool approval required*\n\nThe agent wants to use: ${toolNames}\n\nApprove or deny?`

        const keyboard = {
            inline_keyboard: [[
                { text: '✅ Approve', callback_data: `hitl:${data.taskId}:approve` },
                { text: '❌ Deny', callback_data: `hitl:${data.taskId}:deny` }
            ]]
        }

        const sendHITL = async (): Promise<void> => {
            try {
                const res = await fetch(`https://api.telegram.org/bot${ctx.botToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text,
                        parse_mode: 'Markdown',
                        reply_markup: keyboard
                    })
                })
                const body = await res.json() as { ok: boolean; result?: { message_id: number } }
                if (body.ok && body.result) {
                    ctx.pendingHITL.set(data.taskId, {
                        conversationId: data.conversationId,
                        chatId,
                        userId,
                        messageId: body.result.message_id,
                        resolve: data.resolve
                    })
                }
            } catch { /* ignore send failures */ }
        }

        const enqueue = ctx.conversationSendQueue.get(data.conversationId)
        if (enqueue) {
            enqueue(sendHITL)
        } else {
            sendHITL()
        }
    })
}

/** Handle a Telegram callback query (inline button press). */
export async function handleCallbackQuery(ctx: TelegramCtx, query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    if (!isTelegramUserAllowed(ctx.allowedUserIds, query.from.id)) {
        await answerCallbackQuery(ctx, query.id)
        return
    }
    const callbackData = query.data
    if (!callbackData?.startsWith('hitl:')) {
        await answerCallbackQuery(ctx, query.id)
        return
    }

    const parts = callbackData.split(':')
    const taskId = parts[1]
    const action = parts[2]
    const pending = ctx.pendingHITL.get(taskId)

    if (!pending) {
        await answerCallbackQuery(ctx, query.id, 'This approval has already been handled.')
        return
    }

    if (pending.userId !== query.from.id || pending.chatId !== query.message?.chat.id) {
        await answerCallbackQuery(ctx, query.id, 'This approval is not assigned to you.')
        return
    }

    ctx.pendingHITL.delete(taskId)
    const approved = action === 'approve'

    pending.resolve({ approved, reason: approved ? undefined : 'Denied via Telegram' })

    ctx.broadcast('agent:hitl-resolved', { taskId, conversationId: pending.conversationId, approved })
    getEventBus().emit('hitl:resolved', { taskId, conversationId: pending.conversationId })
    try { getDb().prepare('DELETE FROM pending_hitl WHERE task_id = ?').run(taskId) } catch { /* ignore */ }

    const statusText = approved ? '✅ *Approved* — proceeding...' : '❌ *Denied* — the agent will try a different approach.'
    await editMessage(ctx, pending.chatId, pending.messageId, statusText)
    await answerCallbackQuery(ctx, query.id, approved ? 'Approved!' : 'Denied.')
}

function getOrCreateConversation(ctx: TelegramCtx, telegramChatId: number, senderName: string, agentId?: string): string {
    const db = getDb()
    const resolvedAgentId = agentId || ctx.agentId
    const channelKey = `telegram:${ctx.channelId}:${telegramChatId}`

    const existing = db
        .prepare("SELECT id FROM conversations WHERE origin = 'channel' AND agent_id = ? AND json_extract(metadata_json, '$.channelKey') = ? AND json_extract(metadata_json, '$.archived') IS NULL")
        .get(resolvedAgentId, channelKey) as { id: string } | undefined

    if (existing) return existing.id

    const id = nanoid()
    const now = Date.now()
    const metadataJson = JSON.stringify({ channelKey })
    const agent = getAgent(resolvedAgentId)
    const memorySpaceIds = getAssignedOrDefaultSpaces(resolvedAgentId).map((space) => space.id)
    const executionConfig = buildInitialExecutionConfig({ agent, memorySpaceIds })
    db.prepare(
        'INSERT INTO conversations (id, title, agent_id, origin, execution_config_json, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, senderName, resolvedAgentId, 'channel', JSON.stringify(executionConfig), metadataJson, now, now)

    return id
}
