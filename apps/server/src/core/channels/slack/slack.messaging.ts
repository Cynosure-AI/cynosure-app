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
import type { SlackCtx } from './slack.types.js'
import type { WebClient } from '@slack/web-api'
import { handleCommand } from './slack.commands.js'
import { postOrUpdate, sendLongSlackMessage, uploadImage, extractAttachments } from './slack.api.js'
import {
    applyChannelContextLimit, beginChannelExecution, buildChannelHistory, finishChannelExecution,
    materializeChannelInputAudio, materializeChannelInputImages, persistChannelAssistantMessage, persistChannelExecutionConfig,
    updateChannelExecution,
    channelImageDataUrl,
} from '../channel-execution.js'

interface SlackMessage {
    text?: string
    user?: string
    channel: string
    ts: string
    subtype?: string
    files?: { id: string; name?: string; mimetype?: string; url_private_download?: string; url_private?: string }[]
}

export async function handleMessage(ctx: SlackCtx, msg: SlackMessage, client: WebClient): Promise<void> {
    const slackChannelId = msg.channel
    const text = (msg.text || '').trim()
    const hasFiles = !!(msg.files?.length)

    if (text.startsWith('!') || text.startsWith('/')) {
        const handled = await handleCommand(ctx, slackChannelId, text, client, msg.ts)
        if (handled) return
    }

    if (hasFiles && !text) {
        try {
            const { imageDataUrls, audioDataUrls } = await extractAttachments(ctx, msg.files!)
            if (imageDataUrls.length || audioDataUrls.length) {
                const existing = ctx.pendingAttachments.get(slackChannelId) || { imageDataUrls: [], audioDataUrls: [] }
                existing.imageDataUrls.push(...imageDataUrls)
                existing.audioDataUrls.push(...audioDataUrls)
                ctx.pendingAttachments.set(slackChannelId, existing)
                await client.chat.postMessage({ channel: slackChannelId, text: '📎 Attachment received. Send a message to use it with the agent.', thread_ts: msg.ts }).catch(() => { })
            }
        } catch {
            await client.chat.postMessage({ channel: slackChannelId, text: '⚠️ Failed to process attachment.', thread_ts: msg.ts }).catch(() => { })
        }
        return
    }

    const prev = ctx.channelLocks.get(slackChannelId) || Promise.resolve()
    let unlock: () => void
    const lock = new Promise<void>(resolve => { unlock = resolve })
    ctx.channelLocks.set(slackChannelId, lock)
    await prev

    try {
        await processMessage(ctx, msg, client)
    } finally {
        unlock!()
        if (ctx.channelLocks.get(slackChannelId) === lock) ctx.channelLocks.delete(slackChannelId)
    }
}

export async function processMessage(ctx: SlackCtx, msg: SlackMessage, client: WebClient): Promise<void> {
    const slackChannelId = msg.channel
    const userText = (msg.text || '').trim()
    const senderName = msg.user || 'User'

    if (userText.startsWith('!') || userText.startsWith('/')) {
        const handled = await handleCommand(ctx, slackChannelId, userText, client, msg.ts)
        if (handled) return
    }

    const imageDataUrls: string[] = []
    const audioDataUrls: string[] = []

    const buffered = ctx.pendingAttachments.get(slackChannelId)
    if (buffered) {
        imageDataUrls.push(...buffered.imageDataUrls)
        audioDataUrls.push(...buffered.audioDataUrls)
        ctx.pendingAttachments.delete(slackChannelId)
    }

    if (msg.files?.length) {
        try {
            const extracted = await extractAttachments(ctx, msg.files)
            imageDataUrls.push(...extracted.imageDataUrls)
            audioDataUrls.push(...extracted.audioDataUrls)
        } catch (err) {
            console.warn('[Slack] Failed to extract attachments:', (err as Error).message)
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

    const effectiveAgentId = ctx.channelAgentOverride.get(slackChannelId) || ctx.agentId

    let thinkingTs: string | null = null
    try {
        const thinkingResult = await client.chat.postMessage({
            channel: slackChannelId,
            text: '🧭 Preparing context...',
            thread_ts: msg.ts
        })
        thinkingTs = thinkingResult.ts || null
    } catch {
        // ignore failures posting thinking indicator
    }
    let thinkingSeconds = 0
    let thinkingPhase = 'Preparing context'
    let thinkingTimer: ReturnType<typeof setInterval> | null = null

    const conversationId = getOrCreateConversation(ctx, slackChannelId, senderName, effectiveAgentId)
    ctx.conversationToChannel.set(conversationId, slackChannelId)

    const db = getDb()
    const now = Date.now()
    const storedImageUrls = await materializeChannelInputImages(imageDataUrls, conversationId)
    const storedAudioUrls = await materializeChannelInputAudio(audioDataUrls, conversationId)

    const userMsgId = nanoid()
    db.prepare(
        'INSERT INTO messages (id, conversation_id, role, content, image_urls_json, audio_urls_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
        userMsgId, conversationId, 'user', userText || '(attached media)',
        storedImageUrls.length ? JSON.stringify(storedImageUrls) : null,
        storedAudioUrls.length ? JSON.stringify(storedAudioUrls) : null,
        now
    )
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)

    ctx.broadcast('chat:new-message', {
        conversationId,
        message: {
            id: userMsgId,
            conversationId,
            role: 'user',
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
        await postOrUpdate(client, slackChannelId, thinkingTs, '⚠️ Agent not found.', msg.ts)
        return
    }
    if (thinkingTs) {
        thinkingTimer = setInterval(() => {
            thinkingSeconds++
            const icon = thinkingPhase === 'Preparing context' ? '🧭' : '🤔'
            client.chat.update({ channel: slackChannelId, ts: thinkingTs!, text: `${icon} ${thinkingPhase} (${thinkingSeconds}s)` }).catch(() => { })
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
        if (thinkingTs) {
            await client.chat.update({ channel: slackChannelId, ts: thinkingTs, text: `🤔 Thinking (${thinkingSeconds}s)` }).catch(() => { })
        }
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

    if (thinkingTs) {
        unsubs.push(() => { if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null } })
    }

    // Thinking display is disabled — live thinking updates are omitted
    // unsubs.push(eventBus.on('step:thinking', (...args: unknown[]) => {
    //     const data = args[0] as { conversationId: string; thinking: string }
    //     if (data.conversationId !== conversationId) return
    //     accumulatedThinking += data.thinking
    //     if (!thinkingEditQueued && thinkingTs) {
    //         thinkingEditQueued = true
    //         setTimeout(() => {
    //             thinkingEditQueued = false
    //             const MAX_THINKING = 2900
    //             const display = accumulatedThinking.length > MAX_THINKING
    //                 ? '…' + accumulatedThinking.slice(-MAX_THINKING)
    //                 : accumulatedThinking
    //             client.chat.update({ channel: slackChannelId, ts: thinkingTs!, text: `💭 *Thinking*\n\n${display}` }).catch(() => { })
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
                await client.chat.postMessage({ channel: slackChannelId, text: `${prefix}${lines.join('\n')}`.slice(0, 3000), thread_ts: msg.ts }).catch(() => { })
            }
            for (const r of data.results) {
                if (r.imageDataUrls?.length) {
                    for (let i = 0; i < r.imageDataUrls.length; i++) {
                        await uploadImage(client, slackChannelId, r.imageDataUrls[i], `tool_${r.name}_${i + 1}`, msg.ts).catch(e =>
                            console.warn('[Slack] Failed to upload tool image:', (e as Error).message)
                        )
                    }
                }
            }
        })
    }))

    let accumulatedContent = ''
    let responseTs: string | null = null
    let contentEditQueued = false
    let contentEditTimer: ReturnType<typeof setTimeout> | null = null
    let executionFinished = false
    const CONTENT_EDIT_INTERVAL_MS = 1500

    // Per-sub-agent streaming content buffers
    const subAgentContent = new Map<string, { content: string; ts: string | null; timer: ReturnType<typeof setTimeout> | null }>()

    unsubs.push(eventBus.on('step:content', (...args: unknown[]) => {
        const data = args[0] as { conversationId: string; content: string; maCodename?: string }
        if (data.conversationId !== conversationId) return

        if (data.maCodename) {
            // Sub-agent content — stream as a separate message per sub-agent
            const codename = data.maCodename
            if (!subAgentContent.has(codename)) {
                subAgentContent.set(codename, { content: '', ts: null, timer: null })
            }
            const sa = subAgentContent.get(codename)!
            sa.content += data.content
            if (sa.timer) clearTimeout(sa.timer)
            if (!executionFinished) {
                sa.timer = setTimeout(async () => {
                    sa.timer = null
                    const prefix = `🤖 *[${codename}]*\n\n`
                    const MAX_LEN = 3000
                    const raw = prefix + sa.content
                    const display = raw.length > MAX_LEN ? raw.slice(0, MAX_LEN) + '…' : raw
                    if (!sa.ts) {
                        try {
                            const res = await client.chat.postMessage({ channel: slackChannelId, text: display + ' ▍', thread_ts: msg.ts })
                            sa.ts = res.ts || null
                        } catch { }
                    } else {
                        await client.chat.update({ channel: slackChannelId, ts: sa.ts, text: display + ' ▍' }).catch(() => { })
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
                    } catch {
                        // ignore
                    }
                } else {
                    await client.chat.update({ channel: slackChannelId, ts: responseTs, text: display + ' ▍' }).catch(() => { })
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
                if (sa.ts) {
                    if (text.length <= 3000) {
                        await client.chat.update({ channel: slackChannelId, ts: sa.ts, text }).catch(() => { })
                    } else {
                        await client.chat.update({ channel: slackChannelId, ts: sa.ts, text: text.slice(0, 3000) }).catch(() => { })
                        await sendLongSlackMessage(client, slackChannelId, text.slice(3000), msg.ts)
                    }
                } else {
                    await sendLongSlackMessage(client, slackChannelId, text, msg.ts)
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
        if (thinkingTs) {
            const durationSec = Math.round((Date.now() - now) / 1000)
            await client.chat.update({ channel: slackChannelId, ts: thinkingTs, text: `✅ Done thinking (${durationSec}s)` }).catch(() => { })
        }

        if (responseTs) {
            if (responseText.length <= 3000) {
                await client.chat.update({ channel: slackChannelId, ts: responseTs, text: responseText }).catch(() => { })
            } else {
                await client.chat.update({ channel: slackChannelId, ts: responseTs, text: responseText.slice(0, 3000) }).catch(() => { })
                await sendLongSlackMessage(client, slackChannelId, responseText.slice(3000), msg.ts)
            }
        } else {
            await sendLongSlackMessage(client, slackChannelId, responseText, msg.ts)
        }

        if (result.images?.length) {
            for (let i = 0; i < result.images.length; i++) {
                const dataUrl = channelImageDataUrl(result.images[i])
                if (!dataUrl) continue
                await uploadImage(client, slackChannelId, dataUrl, `image_${i + 1}`, msg.ts).catch(e =>
                    console.warn('[Slack] Failed to upload image:', (e as Error).message)
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
        console.error(`[Slack] Agent execution error: ${errorMsg}`)
        getEventBus().emit('task:error', { conversationId, error: execAbort.signal.aborted ? 'Cancelled' : errorMsg })
        if (!execAbort.signal.aborted) ctx.broadcast('chat:stream-error', { streamId, conversationId, error: errorMsg })
        await postOrUpdate(client, slackChannelId, thinkingTs, execAbort.signal.aborted ? '⏹ Stopped.' : `⚠️ Error: ${errorMsg.slice(0, 2900)}`, msg.ts)
    } finally {
        finishChannelExecution({ executions: ctx.activeExecutions, executionId: streamId, conversationId, agentId: effectiveAgentId, broadcast: ctx.broadcast })
        for (const unsub of unsubs) unsub()
    }
}

export function subscribeToHITL(ctx: SlackCtx): () => void {
    const eventBus = getEventBus()
    return eventBus.on('hitl:request', (...args: unknown[]) => {
        const data = args[0] as {
            taskId: string
            conversationId: string
            toolCalls: { id: string; function: { name: string; arguments: string } }[]
            resolve: (result: { approved: boolean; reason?: string }) => void
        }
        const slackChannelId = ctx.conversationToChannel.get(data.conversationId)
        if (!slackChannelId) return

        const toolNames = data.toolCalls.map(tc => `\`${tc.function.name}\``).join(', ')

        const sendHITL = async (): Promise<void> => {
            try {
                const result = await ctx.app.client.chat.postMessage({
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
                if (result.ts) {
                    ctx.pendingHITL.set(data.taskId, {
                        conversationId: data.conversationId,
                        slackChannelId,
                        messageTs: result.ts,
                        resolve: data.resolve
                    })
                }
            } catch {
                // ignore send failures
            }
        }

        const enqueue = ctx.conversationSendQueue.get(data.conversationId)
        if (enqueue) {
            enqueue(sendHITL)
        } else {
            sendHITL()
        }
    })
}

export async function handleHITLAction(
    ctx: SlackCtx,
    actionId: string,
    client: WebClient,
    _body: Record<string, unknown>
): Promise<void> {
    const parts = actionId.split(':')
    const taskId = parts[1]
    const action = parts[2]
    const pending = ctx.pendingHITL.get(taskId)

    if (!pending) return

    ctx.pendingHITL.delete(taskId)
    const approved = action === 'approve'

    pending.resolve({ approved, reason: approved ? undefined : 'Denied via Slack' })

    ctx.broadcast('agent:hitl-resolved', { taskId, conversationId: pending.conversationId, approved })
    getEventBus().emit('hitl:resolved', { taskId, conversationId: pending.conversationId })
    try { getDb().prepare('DELETE FROM pending_hitl WHERE task_id = ?').run(taskId) } catch { }

    const statusText = approved ? '✅ *Approved* — proceeding...' : '❌ *Denied* — the agent will try a different approach.'
    await client.chat.update({
        channel: pending.slackChannelId,
        ts: pending.messageTs,
        text: statusText,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: statusText } }]
    }).catch(() => { })
}

export function getOrCreateConversation(ctx: SlackCtx, slackChannelId: string, senderName: string, agentId?: string): string {
    const db = getDb()
    const resolvedAgentId = agentId || ctx.agentId
    const channelKey = `slack:${ctx.channelId}:${slackChannelId}`

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
