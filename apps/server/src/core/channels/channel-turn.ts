/**
 * The platform-independent agent turn for messaging channels. Each platform
 * supplies a ChannelTransport for one inbound message; everything else —
 * attachment buffering, per-target locking, planning, execution, live
 * streaming, persistence, and title generation — lives here.
 */
import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getGateway } from '../gateway/gateway.js'
import { AgentExecutor, MAIN_AGENT_MAX_ROUNDS } from '../agent/agent-executor.js'
import { planExecution } from '../agent/pre-execution/execution-planner.js'
import { closePlanningRun } from '../agent/planning-state.js'
import { generateTitle } from '../agent/post-execution.js'
import { getAgent } from '../agents/agent-store.js'
import { getToolRegistry } from '../tools/tool-registry.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { getAssignedMemoryFolders } from '../memory/memory-folder-scope.js'
import type { ChatMessage, ContentPart } from '../gateway/providers/base.provider.js'
import {
    applyChannelContextLimit, beginChannelExecution, buildChannelHistory, channelImageDataUrl, finishChannelExecution,
    materializeChannelInputAudio, materializeChannelInputImages, persistChannelAssistantMessage,
    persistChannelExecutionConfig, persistChannelUserMessage, publishChannelStreamError, updateChannelExecution,
} from './channel-execution.js'
import {
    effectiveAgentId, getOrCreateChannelConversation, withTargetLock,
    type BroadcastFn, type ChannelMedia, type ChannelSessionState, type ChannelTargetId,
} from './channel-session.js'

const CONTENT_EDIT_INTERVAL_MS = 1500
const STREAMING_CURSOR = ' ▍'

export interface ChannelImage {
    dataUrl: string
    /** File name without extension. */
    name: string
}

/**
 * Outbound operations for one inbound message. `H` is the platform's handle
 * for a sent message that can be edited later (a Discord Message, a Slack ts,
 * a Telegram message id). Implementations swallow delivery errors.
 */
export interface ChannelTransport<H> {
    /** Log prefix, e.g. "[Discord]". */
    logTag: string
    /** Live previews are truncated to this length. */
    previewLimit: number
    /** Hard per-message limit; longer final text overflows into follow-up messages. */
    messageLimit: number
    bold(text: string): string
    /** Reply to the inbound message (status line, errors). */
    reply(text: string): Promise<H | null>
    /** Post a new message in the conversation. */
    send(text: string): Promise<H | null>
    edit(handle: H, text: string): Promise<void>
    /** Post text of any length, split across messages as needed. */
    sendLong(text: string): Promise<void>
    /** `replyTo` is the turn's status message when the images come from a tool call. */
    sendImages(images: ChannelImage[], replyTo: H | null): Promise<void>
    sendTyping?(): Promise<void>
    typingIntervalMs?: number
}

export interface ChannelInboundMessage<K extends ChannelTargetId, H> {
    target: K
    text: string
    senderName: string
    hasMedia: boolean
    extractMedia(): Promise<ChannelMedia>
    /** Returns true when the text was a command and was handled. */
    handleCommand?(): Promise<boolean>
    transport: ChannelTransport<H>
    /** Called once the turn's conversation is known. */
    onConversation?(conversationId: string): void
}

/**
 * Entry point for an inbound message: commands run immediately, media-only
 * messages are buffered for the next text, and everything else runs as a
 * serialized agent turn for the target.
 */
export async function receiveChannelMessage<K extends ChannelTargetId, H>(
    state: ChannelSessionState<K>,
    message: ChannelInboundMessage<K, H>,
): Promise<void> {
    const { target, transport } = message
    if (message.handleCommand && await message.handleCommand()) return

    if (message.hasMedia && !message.text) {
        try {
            const media = await message.extractMedia()
            if (media.imageDataUrls.length || media.audioDataUrls.length) {
                const pending = state.pendingAttachments.get(target) || { imageDataUrls: [], audioDataUrls: [] }
                pending.imageDataUrls.push(...media.imageDataUrls)
                pending.audioDataUrls.push(...media.audioDataUrls)
                state.pendingAttachments.set(target, pending)
                await transport.reply('📎 Attachment received. Send a message to use it with the agent.')
            }
        } catch {
            await transport.reply('⚠️ Failed to process attachment.')
        }
        return
    }

    await withTargetLock(state, target, () => runChannelTurn(state, message))
}

async function collectMedia<K extends ChannelTargetId, H>(
    state: ChannelSessionState<K>,
    message: ChannelInboundMessage<K, H>,
): Promise<ChannelMedia> {
    const media: ChannelMedia = { imageDataUrls: [], audioDataUrls: [] }
    const buffered = state.pendingAttachments.get(message.target)
    if (buffered) {
        media.imageDataUrls.push(...buffered.imageDataUrls)
        media.audioDataUrls.push(...buffered.audioDataUrls)
        state.pendingAttachments.delete(message.target)
    }
    if (message.hasMedia) {
        try {
            const extracted = await message.extractMedia()
            media.imageDataUrls.push(...extracted.imageDataUrls)
            media.audioDataUrls.push(...extracted.audioDataUrls)
        } catch (err) {
            console.warn(`${message.transport.logTag} Failed to extract attachments:`, (err as Error).message)
        }
    }
    return media
}

function multimodalContent(text: string, media: ChannelMedia): ContentPart[] {
    return [
        { type: 'text', text },
        ...media.imageDataUrls.map((url): ContentPart => ({ type: 'image_url', image_url: { url } })),
        ...media.audioDataUrls.map((url): ContentPart => ({ type: 'audio_url', audio_url: { url } })),
    ]
}

function truncate(text: string, limit: number): string {
    return text.length > limit ? text.slice(0, limit) + '…' : text
}

/** Replace a streamed preview with the final text, overflowing into follow-up messages. */
async function finalizeStreamedMessage<H>(transport: ChannelTransport<H>, handle: H | null, text: string): Promise<void> {
    if (handle === null) {
        await transport.sendLong(text)
        return
    }
    await transport.edit(handle, text.slice(0, transport.messageLimit))
    if (text.length > transport.messageLimit) await transport.sendLong(text.slice(transport.messageLimit))
}

async function runChannelTurn<K extends ChannelTargetId, H>(
    state: ChannelSessionState<K>,
    message: ChannelInboundMessage<K, H>,
): Promise<void> {
    const { target, transport } = message
    const userText = message.text
    const media = await collectMedia(state, message)
    const hasAttachments = media.imageDataUrls.length > 0 || media.audioDataUrls.length > 0
    const displayText = userText || '(attached media)'

    const agentId = effectiveAgentId(state, target)
    const statusMsg = await transport.reply('🧭 Preparing context...')
    let thinkingSeconds = 0
    let thinkingPhase = 'Preparing context'
    let thinkingTimer: ReturnType<typeof setInterval> | null = null
    const stopThinkingTimer = () => { if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null } }

    const conversationId = getOrCreateChannelConversation(state, target, message.senderName, agentId)
    state.conversationTargets.set(conversationId, target)
    message.onConversation?.(conversationId)

    const startedAt = Date.now()
    persistChannelUserMessage({
        broadcast: state.broadcast, conversationId, messageId: nanoid(), content: displayText,
        images: await materializeChannelInputImages(media.imageDataUrls, conversationId),
        audio: await materializeChannelInputAudio(media.audioDataUrls, conversationId),
        createdAt: startedAt,
    })

    const history = buildChannelHistory(conversationId, agentId)
    let messages: ChatMessage[] = history.messages
    if (hasAttachments && messages.length > 0) {
        const lastIdx = messages.length - 1
        messages[lastIdx] = { ...messages[lastIdx], content: multimodalContent(displayText, media) }
    }

    const agent = getAgent(agentId)
    if (!agent) {
        if (statusMsg !== null) await transport.edit(statusMsg, '⚠️ Agent not found.')
        else await transport.reply('⚠️ Agent not found.')
        return
    }
    if (statusMsg !== null) {
        thinkingTimer = setInterval(() => {
            thinkingSeconds++
            const icon = thinkingPhase === 'Preparing context' ? '🧭' : '🤔'
            void transport.edit(statusMsg, `${icon} ${thinkingPhase} (${thinkingSeconds}s)`)
        }, 1000)
    }

    const unsubs: Array<() => void> = [stopThinkingTimer]
    const { streamId, controller: execAbort } = beginChannelExecution({
        executions: state.activeExecutions, channelId: state.channelId, agent, conversationId, broadcast: state.broadcast,
    })
    let planned: Awaited<ReturnType<typeof planExecution>> | undefined
    try {
        planned = await planExecution({
            resolvedAgent: agent, conversationId, broadcast: state.broadcast, abortSignal: execAbort.signal,
            gateway: getGateway(), toolRegistry: getToolRegistry(), messages, userText,
            run: {
                memoryFolderOverrides: getAssignedMemoryFolders(agent.id),
                autoMemory: agent.autoMemory === true,
                thinkingEnabled: agent.thinkingEnabled !== false,
            },
        })
        updateChannelExecution(state.activeExecutions, streamId, { model: planned.responseModel, planningRunId: planned.planningRunId })
        if (execAbort.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
        persistChannelExecutionConfig(conversationId, agent, planned)
        const context = await applyChannelContextLimit({
            gateway: getGateway(), planned, agent, messages: planned.messages, history,
            conversationId, broadcast: state.broadcast, signal: execAbort.signal,
        })
        execAbort.signal.throwIfAborted()
        messages = context.messages
        thinkingPhase = 'Thinking'
        if (statusMsg !== null) await transport.edit(statusMsg, `🤔 Thinking (${thinkingSeconds}s)`)

        const executor = new AgentExecutor({
            gateway: getGateway(), tools: planned.tools, conversationId, broadcast: state.broadcast,
            providerId: planned.providerId, model: planned.responseModel, hitl: !agent.autoApproveTools,
            maxRounds: MAIN_AGENT_MAX_ROUNDS, thinkingEnabled: agent.thinkingEnabled !== false,
            reasoningEffort: agent.reasoningEffort, streamMode: 'single', signal: execAbort.signal,
            streamId, agentId, agentName: agent.name,
            agentIconUrl: agent.iconUrl || null, planningRunId: planned.planningRunId,
            contextWindow: context.contextWindow, initialContextEstimate: context.initialContextEstimate,
            contextStrategy: context.strategy, isPrimaryExecutor: true,
        })

        const eventBus = getEventBus()
        let sendChain = Promise.resolve()
        const enqueueSend = (fn: () => Promise<void>): void => {
            sendChain = sendChain.then(fn, fn)
        }
        state.conversationSendQueue.set(conversationId, enqueueSend)

        // Compact status lines only; verbose tool arguments are intentionally not posted to channels.
        unsubs.push(eventBus.on('step:executed', (...args: unknown[]) => {
            const data = args[0] as { conversationId: string; results: { name: string; success: boolean; imageDataUrls?: string[] }[]; maCodename?: string }
            if (data.conversationId !== conversationId) return
            const prefix = data.maCodename ? `🤖 ${transport.bold(`[${data.maCodename}]`)} ` : ''
            const lines = data.results.map(r => r.success ? `✅ \`${r.name}\` executed` : `❌ \`${r.name}\` failed`)
            enqueueSend(async () => {
                if (lines.length) await transport.send(`${prefix}${lines.join('\n')}`.slice(0, transport.messageLimit))
                for (const r of data.results) {
                    if (!r.imageDataUrls?.length) continue
                    await transport.sendImages(r.imageDataUrls.map((dataUrl, i) => ({ dataUrl, name: `tool_${r.name}_${i + 1}` })), statusMsg)
                }
            })
        }))

        if (transport.sendTyping) {
            const sendTyping = transport.sendTyping.bind(transport)
            const typingInterval = setInterval(() => { void sendTyping() }, transport.typingIntervalMs ?? 5000)
            unsubs.push(() => clearInterval(typingInterval))
        }

        let executionFinished = false
        const main = { content: '', handle: null as H | null, timer: null as ReturnType<typeof setTimeout> | null }
        // Sub-agent output streams into its own message per codename.
        const subAgents = new Map<string, { content: string; handle: H | null; timer: ReturnType<typeof setTimeout> | null }>()
        const subAgentHeader = (codename: string) => `🤖 ${transport.bold(`[${codename}]`)}\n\n`

        const showPreview = async (stream: { handle: H | null }, text: string) => {
            const display = truncate(text, transport.previewLimit) + STREAMING_CURSOR
            if (stream.handle !== null) await transport.edit(stream.handle, display)
            else stream.handle = await transport.send(display)
        }

        unsubs.push(eventBus.on('step:content', (...args: unknown[]) => {
            const data = args[0] as { conversationId: string; content: string; maCodename?: string }
            if (data.conversationId !== conversationId) return

            if (data.maCodename) {
                const codename = data.maCodename
                let sub = subAgents.get(codename)
                if (!sub) {
                    sub = { content: '', handle: null, timer: null }
                    subAgents.set(codename, sub)
                }
                sub.content += data.content
                if (sub.timer) clearTimeout(sub.timer)
                if (executionFinished) return
                const stream = sub
                stream.timer = setTimeout(() => {
                    stream.timer = null
                    void showPreview(stream, subAgentHeader(codename) + stream.content)
                }, CONTENT_EDIT_INTERVAL_MS)
                return
            }

            main.content += data.content
            if (main.timer || executionFinished) return
            main.timer = setTimeout(() => {
                main.timer = null
                if (!executionFinished) void showPreview(main, main.content)
            }, CONTENT_EDIT_INTERVAL_MS)
        }))

        const result = await executor.run(messages)
        if (planned.planningRunId) {
            closePlanningRun(planned.planningRunId, 'completed', { summary: result.content.slice(0, 500) })
        }
        executionFinished = true
        stopThinkingTimer()
        if (main.timer) { clearTimeout(main.timer); main.timer = null }
        state.conversationSendQueue.delete(conversationId)
        await sendChain

        for (const [codename, sub] of subAgents) {
            if (sub.timer) { clearTimeout(sub.timer); sub.timer = null }
            if (sub.content) await finalizeStreamedMessage(transport, sub.handle, subAgentHeader(codename) + sub.content)
        }

        persistChannelAssistantMessage({ conversationId, agentId, planned, result, startedAt })
        maybeGenerateTitle(state.broadcast, conversationId, userText, result.content, planned)

        if (statusMsg !== null) {
            const durationSec = Math.round((Date.now() - startedAt) / 1000)
            await transport.edit(statusMsg, `✅ Done thinking (${durationSec}s)`)
        }
        await finalizeStreamedMessage(transport, main.handle, result.content || '(no response)')

        const images = (result.images ?? []).flatMap((image, i) => {
            const dataUrl = channelImageDataUrl(image)
            return dataUrl ? [{ dataUrl, name: `image_${i + 1}` }] : []
        })
        if (images.length) await transport.sendImages(images, null)
    } catch (err) {
        const aborted = execAbort.signal.aborted
        if (planned?.planningRunId) {
            const isAbort = (err as Error).name === 'AbortError'
            closePlanningRun(planned.planningRunId, isAbort ? 'cancelled' : 'error', { error: isAbort ? 'Cancelled' : (err as Error).message })
        }
        stopThinkingTimer()
        const errorMsg = (err as Error).message || 'Unknown error'
        console.error(`${transport.logTag} Agent execution error: ${errorMsg}`)
        getEventBus().emit('task:error', { conversationId, error: aborted ? 'Cancelled' : errorMsg })
        if (!aborted) publishChannelStreamError(state.broadcast, conversationId, streamId, errorMsg)
        const errorText = `⚠️ Error: ${errorMsg.slice(0, transport.previewLimit)}`
        if (statusMsg !== null) await transport.edit(statusMsg, aborted ? '⏹ Stopped.' : errorText)
        else await transport.reply(errorText)
    } finally {
        finishChannelExecution({ executions: state.activeExecutions, executionId: streamId, conversationId, agentId, broadcast: state.broadcast })
        for (const unsub of unsubs) unsub()
    }
}

function maybeGenerateTitle(
    broadcast: BroadcastFn,
    conversationId: string,
    userText: string,
    assistantResponse: string,
    planned: Awaited<ReturnType<typeof planExecution>>,
): void {
    const db = getDb()
    const meta = db.prepare("SELECT json_extract(metadata_json, '$.titleGenerated') as tg FROM conversations WHERE id = ?")
        .get(conversationId) as { tg: number | null } | undefined
    if (meta?.tg) return
    db.prepare("UPDATE conversations SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.titleGenerated', 1) WHERE id = ?")
        .run(conversationId)
    generateTitle({
        conversationId,
        userMessage: userText,
        assistantResponse,
        broadcast,
        providerId: planned.responseProvider,
        model: planned.responseModel,
    }).catch(() => { })
}
