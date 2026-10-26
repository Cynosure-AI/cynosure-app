/**
 * The platform-independent agent turn for messaging channels. Each platform
 * supplies a ChannelTransport for one inbound message; everything else —
 * attachment buffering, per-target locking, planning, execution, progress,
 * persistence, and title generation — lives here.
 */
import { cancelConversationWait } from '../triggers/cron-scheduler.js'
import { beginChatQueueTurn } from '../chat/message-queue.js'
import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getGateway } from '../gateway/gateway.js'
import { AgentExecutor, MAIN_AGENT_MAX_ROUNDS } from '../agent/agent-executor.js'
import { planExecution } from '../agent/pre-execution/execution-planner.js'
import { closePlanningRun } from '../agent/planning-state.js'
import { generateTitle } from '../agent/post-execution.js'
import { getAgent } from '../agents/agent-store.js'
import { getCynoProfile } from '../cyno/cyno-profile.js'
import { cynoExecutionConfig } from '../cyno/cyno-run.js'
import { resolveRunSettings } from '../agent/run-settings.js'
import { getToolRegistry } from '../tools/tool-registry.js'
import { getEventBus } from '../telemetry/event-bus.js'
import type { ChatMessage, ContentPart } from '../gateway/providers/base.provider.js'
import {
    applyChannelContextLimit, beginChannelExecution, buildChannelHistory, channelImageDataUrl, finishChannelExecution,
    materializeChannelInputAudio, materializeChannelInputImages, persistChannelAssistantMessage,
    persistChannelExecutionConfig, persistChannelUserMessage, publishChannelStreamError, updateChannelExecution,
} from './channel-execution.js'
import {
    effectiveAgentId, getOrCreateChannelConversation, resolveContinuedConversation, withTargetLock, type BroadcastFn, type ChannelMedia, type ChannelSessionState, type ChannelTargetId,
} from './channel-session.js'
import { CYNO_AGENT_ID, isCyno } from '../agent/execution-preset.js'
import { resolveInlineAttachmentTextLimit } from '../chat/attachment-context.js'
import { CHANNEL_REPLY_PROMPT, splitChannelReply } from './channel-presentation.js'

const PROGRESS_INTERVAL_MS = 15_000

export interface ChannelImage {
    dataUrl: string
    /** File name without extension. */
    name: string
}

/**
 * Outbound operations for one inbound message. `H` is the platform's handle
 * for a sent message that can be edited later (a Discord Message, a Slack ts,
 * a Telegram message id). Final sends report failure; progress edits are best effort.
 */
export interface ChannelTransport<H> {
    /** Log prefix, e.g. "[Discord]". */
    logTag: string
    /** Hard per-message limit; longer final text overflows into follow-up messages. */
    messageLimit: number
    /** Reply to the inbound message (status line, errors). */
    reply(text: string): Promise<H | null>
    /** Post a new message in the conversation. */
    send(text: string): Promise<H | null>
    edit(handle: H, text: string): Promise<void>
    /** Send final generated images, optionally associated with a reply. */
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
    /** Continue this conversation instead of the target's active one, e.g. for a reply to a delivered message. */
    continueConversationId?: string
    /** Called with the final reply's message, so a later reply to it can continue the same conversation. */
    onFinalReply?(handle: H, conversationId: string): void
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

async function runChannelTurn<K extends ChannelTargetId, H>(
    state: ChannelSessionState<K>,
    message: ChannelInboundMessage<K, H>,
): Promise<void> {
    const { target, transport } = message
    const userText = message.text
    const media = await collectMedia(state, message)
    const hasAttachments = media.imageDataUrls.length > 0 || media.audioDataUrls.length > 0
    const displayText = userText || '(attached media)'

    const continued = message.continueConversationId
        ? resolveContinuedConversation(state, message.continueConversationId)
        : null
    const agentId = continued?.agentId ?? effectiveAgentId(state, target)
    const statusMsg = await transport.reply('⏳ Working on your request…')

    const conversationId = continued?.conversationId ?? getOrCreateChannelConversation(state, target, message.senderName, agentId)
    cancelConversationWait(conversationId)
    state.conversationTargets.set(conversationId, target)
    message.onConversation?.(conversationId)

    const startedAt = Date.now()
    persistChannelUserMessage({
        broadcast: state.broadcast, conversationId, messageId: nanoid(), content: displayText,
        images: await materializeChannelInputImages(media.imageDataUrls, conversationId),
        audio: await materializeChannelInputAudio(media.audioDataUrls, conversationId),
        createdAt: startedAt,
    })

    const cyno = isCyno(agentId)
    const agent = cyno ? null : getAgent(agentId)
    if (!cyno && !agent) {
        if (statusMsg !== null) await transport.edit(statusMsg, '⚠️ Agent not found.')
        else await transport.reply('⚠️ Agent not found.')
        return
    }
    // Cyno runs without an agent, with the settings of its profile.
    const cynoConfig = agent ? undefined : cynoExecutionConfig()
    const settings = resolveRunSettings(agent, cynoConfig)
    const inlineAttachmentTextLimit = await resolveInlineAttachmentTextLimit({
        gateway: getGateway(), baseProviderId: agent?.providerId, baseModel: agent?.model,
        providerOverride: settings.plan.providerOverride, modelOverride: settings.plan.modelOverride,
        maxContextTokens: settings.maxContextTokens,
    })

    const history = buildChannelHistory(conversationId, cyno ? null : agentId, inlineAttachmentTextLimit)
    let messages: ChatMessage[] = history.messages
    if (hasAttachments && messages.length > 0) {
        const lastIdx = messages.length - 1
        messages[lastIdx] = { ...messages[lastIdx], content: multimodalContent(displayText, media) }
    }
    const identity = agent
        ? { id: agent.id, name: agent.name, iconUrl: agent.iconUrl || null, model: agent.model || null }
        : { id: CYNO_AGENT_ID, name: getCynoProfile().name, iconUrl: null, model: cynoConfig!.model || null }
    const { streamId, controller: execAbort } = beginChannelExecution({
        executions: state.activeExecutions, channelId: state.channelId, agent: identity, conversationId, broadcast: state.broadcast,
    })
    let planned: Awaited<ReturnType<typeof planExecution>> | undefined
    const finishQueueTurn = beginChatQueueTurn(conversationId)
    let queueTurnCompleted = false
    let replySaved = false
    let progressClosed = false
    let sendChain = Promise.resolve()
    const enqueueSend = (fn: () => Promise<void>): void => {
        sendChain = sendChain.then(fn).catch((err: unknown) => {
            console.warn(`${transport.logTag} Progress delivery failed:`, (err as Error).message)
        })
    }
    state.conversationSendQueue.set(conversationId, enqueueSend)
    const eventBus = getEventBus()
    const waitingApprovals = new Set<string>()
    const updateProgress = () => {
        if (progressClosed || statusMsg === null) return
        const text = waitingApprovals.size
            ? '🔐 Waiting for your approval below.'
            : `⏳ Working on your request… · ${Math.floor((Date.now() - startedAt) / 1000)}s`
        enqueueSend(async () => { if (!progressClosed) await transport.edit(statusMsg, text) })
    }
    const progressTimer = setInterval(() => {
        // Approval prompts are the active UI while paused; do not keep "typing" or counting.
        if (!waitingApprovals.size) updateProgress()
    }, PROGRESS_INTERVAL_MS)
    const unsubs: Array<() => void> = [() => clearInterval(progressTimer)]
    unsubs.push(eventBus.on('hitl:request', (...args: unknown[]) => {
        const data = args[0] as { conversationId: string; taskId: string }
        if (data.conversationId !== conversationId) return
        waitingApprovals.add(data.taskId)
        updateProgress()
    }))
    const approvalFinished = (...args: unknown[]) => {
        const data = args[0] as { taskId: string }
        if (waitingApprovals.delete(data.taskId)) updateProgress()
    }
    unsubs.push(eventBus.on('hitl:resolved', approvalFinished))
    unsubs.push(eventBus.on('hitl:cancel-request', approvalFinished))
    if (transport.sendTyping) {
        const sendTyping = transport.sendTyping.bind(transport)
        const typingTimer = setInterval(() => {
            if (!progressClosed && !waitingApprovals.size) void sendTyping().catch(() => {})
        }, transport.typingIntervalMs ?? 5000)
        unsubs.push(() => clearInterval(typingTimer))
    }
    const closeProgress = async (text: string) => {
        progressClosed = true
        for (const unsub of unsubs) unsub()
        await sendChain
        if (statusMsg !== null) await transport.edit(statusMsg, text).catch(() => {})
    }
    try {
        planned = await planExecution({
            resolvedAgent: agent, conversationId, broadcast: state.broadcast, abortSignal: execAbort.signal,
            gateway: getGateway(), toolRegistry: getToolRegistry(), messages, userText,
            run: { ...settings.plan, inlineAttachmentTextLimit, systemPromptSuffix: CHANNEL_REPLY_PROMPT },
        })
        updateChannelExecution(state.activeExecutions, streamId, { model: planned.responseModel, planningRunId: planned.planningRunId })
        if (execAbort.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
        persistChannelExecutionConfig(conversationId, settings.persistedConfig(planned.responseModel, planned.responseProvider))
        const context = await applyChannelContextLimit({
            gateway: getGateway(), planned, settings, messages: planned.messages, history,
            conversationId, broadcast: state.broadcast, signal: execAbort.signal,
        })
        execAbort.signal.throwIfAborted()
        messages = context.messages

        const executor = new AgentExecutor({
            gateway: getGateway(), tools: planned.tools, conversationId, broadcast: state.broadcast,
            providerId: planned.providerId, model: planned.responseModel, hitl: settings.hitl,
            maxRounds: MAIN_AGENT_MAX_ROUNDS, thinkingEnabled: settings.thinkingEnabled,
            reasoningEffort: settings.reasoningEffort, streamMode: 'single', signal: execAbort.signal,
            streamId, agentId: agent?.id, agentName: identity.name,
            agentIconUrl: identity.iconUrl, planningRunId: planned.planningRunId, planningGoal: planned.planningGoal,
            contextWindow: context.contextWindow, initialContextEstimate: context.initialContextEstimate,
            contextStrategy: context.strategy, isPrimaryExecutor: true,
        })

        // Channels are linear conversations. Intermediate prose, tool results and
        // sub-agent output stay in Cynosure; only the complete answer is posted here.
        const result = await executor.run(messages)
        if (planned.planningRunId) {
            closePlanningRun(planned.planningRunId, 'completed', { summary: result.content.slice(0, 500) })
        }
        progressClosed = true
        for (const unsub of unsubs) unsub()
        await sendChain

        persistChannelAssistantMessage({ broadcast: state.broadcast, conversationId, streamId, agentId: cyno ? null : agentId, planned, result, startedAt })
        replySaved = true
        maybeGenerateTitle(state.broadcast, conversationId, userText, result.content, planned)

        const images = (result.images ?? []).flatMap((image, i) => {
            const dataUrl = channelImageDataUrl(image)
            return dataUrl ? [{ dataUrl, name: `image_${i + 1}` }] : []
        })
        if (images.length) await transport.sendImages(images, null)
        for (const chunk of splitChannelReply(result.content.trim() || '(no response)', transport.messageLimit)) {
            const handle = await transport.send(chunk)
            if (handle === null) throw new Error('Could not deliver the final reply.')
            message.onFinalReply?.(handle, conversationId)
        }
        await closeProgress('✓ Finished. Reply below.')
        queueTurnCompleted = !execAbort.signal.aborted
    } catch (err) {
        const aborted = execAbort.signal.aborted
        if (planned?.planningRunId && !replySaved) {
            const isAbort = (err as Error).name === 'AbortError'
            closePlanningRun(planned.planningRunId, isAbort ? 'cancelled' : 'error', { error: isAbort ? 'Cancelled' : (err as Error).message })
        }
        const errorMsg = (err as Error).message || 'Unknown error'
        console.error(`${transport.logTag} Agent execution error: ${errorMsg}`)
        getEventBus().emit('task:error', { conversationId, error: aborted ? 'Cancelled' : errorMsg })
        if (!aborted && !replySaved) publishChannelStreamError(state.broadcast, conversationId, streamId, errorMsg)
        const errorText = aborted ? '⏹ Stopped.' : replySaved
            ? '⚠️ Your reply was saved in Cynosure, but could not be fully delivered here. Open Cynosure to read it.'
            : `⚠️ I couldn't finish this request: ${errorMsg.slice(0, 300)}`
        await closeProgress(errorText)
        // Errors and cancellations must also be visible at the bottom, after any approval prompts.
        await transport.reply(errorText)
    } finally {
        finishChannelExecution({ executions: state.activeExecutions, executionId: streamId, conversationId, agentId, broadcast: state.broadcast })
        progressClosed = true
        for (const unsub of unsubs) unsub()
        await sendChain
        state.conversationSendQueue.delete(conversationId)
        finishQueueTurn(queueTurnCompleted)
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
