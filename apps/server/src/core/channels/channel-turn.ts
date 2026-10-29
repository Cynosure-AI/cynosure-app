/**
 * The platform-independent agent turn for messaging channels. Each platform
 * supplies a ChannelTransport for one inbound message; everything else —
 * attachment buffering, per-target locking, planning, execution, progress,
 * persistence, and title generation — lives here.
 */
import { cancelConversationWait } from '../triggers/cron-scheduler.js'
import { beginChatQueueTurn, enqueueChatMessage, registerChatSteeringHandler, takeSteeringMessages } from '../chat/message-queue.js'
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
    effectiveAgentId, getOrCreateChannelConversation, resolveChannelHITL, resolveContinuedConversation, shellCallDetails, toolCallTarget, toolDisplayName, withTargetLock,
    type ActiveChannelTurn, type BroadcastFn, type ChannelHITLRequest, type ChannelMedia, type ChannelSessionState, type ChannelTargetId,
} from './channel-session.js'
import { CYNO_AGENT_ID, isCyno } from '../agent/execution-preset.js'
import { resolveInlineAttachmentTextLimit } from '../chat/attachment-context.js'
import { CHANNEL_REPLY_PROMPT, renderChannelProgress, splitChannelReply, type ChannelProgressStep } from './channel-presentation.js'

const PROGRESS_INTERVAL_MS = 15_000
/** Quick answers arrive without a status card; longer work shows one after this delay or at its first tool call. */
const STATUS_CARD_DELAY_MS = 6_000
const STEERING_DECLINE_REASON = 'The user sent a follow-up message instead of answering. Take it into account and ask again if this action is still needed.'

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
    /** Reply to the inbound message (status card, errors). */
    reply(text: string): Promise<H | null>
    /** Post a new message in the conversation. */
    send(text: string): Promise<H | null>
    edit(handle: H, text: string): Promise<void>
    delete(handle: H): Promise<void>
    /** Set (or with null, clear) a reaction on the inbound message as a lightweight "seen" signal. */
    react?(emoji: string | null): Promise<void>
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
 * Entry point for an inbound message: commands run immediately, a message
 * that arrives while a turn runs steers that turn, images without text are
 * buffered for the next text, and everything else runs as a serialized agent
 * turn for the target.
 */
export async function receiveChannelMessage<K extends ChannelTargetId, H>(
    state: ChannelSessionState<K>,
    inbound: ChannelInboundMessage<K, H>,
): Promise<void> {
    // Media is inspected before the turn starts; download it once.
    let extracted: Promise<ChannelMedia> | undefined
    const message = { ...inbound, extractMedia: () => extracted ??= inbound.extractMedia() }
    const { target, transport } = message
    if (message.handleCommand && await message.handleCommand()) return

    const active = state.activeTurns.get(target)
    if (active && (!message.continueConversationId || message.continueConversationId === active.conversationId)) {
        await steerActiveTurn(state, active, message)
        return
    }

    if (message.hasMedia && !message.text) {
        let media: ChannelMedia
        try {
            media = await message.extractMedia()
        } catch {
            await transport.reply('⚠️ I couldn’t read that attachment. Please try sending it again.')
            return
        }
        // A voice note is a message in its own right; an image without words needs one.
        if (!media.audioDataUrls.length) {
            if (!media.imageDataUrls.length) return
            const pending = state.pendingAttachments.get(target) || { imageDataUrls: [], audioDataUrls: [] }
            pending.imageDataUrls.push(...media.imageDataUrls)
            state.pendingAttachments.set(target, pending)
            await transport.reply(pending.imageDataUrls.length > 1
                ? `📎 Got ${pending.imageDataUrls.length} images. What should I do with them?`
                : '📎 Got it. What should I do with this?')
            return
        }
    }

    await withTargetLock(state, target, () => runChannelTurn(state, message))
}

async function steerActiveTurn<K extends ChannelTargetId, H>(
    state: ChannelSessionState<K>,
    turn: ActiveChannelTurn,
    message: ChannelInboundMessage<K, H>,
): Promise<void> {
    const media = await collectMedia(state, message)
    if (!message.text && !media.imageDataUrls.length && !media.audioDataUrls.length) return
    const { transport } = message
    await transport.react?.('👀')
    try {
        await turn.steer(message.text, media, async () => { await transport.react?.(null) })
    } catch (err) {
        console.warn(`${transport.logTag} Could not steer the running turn:`, (err as Error).message)
        await transport.react?.(null)
        await transport.reply('⚠️ I couldn’t add that to the request I’m working on. Please send it again once I’m done.')
    }
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

function mediaPlaceholder(media: ChannelMedia): string {
    return media.audioDataUrls.length ? '(voice message)' : '(attached media)'
}

/** Status-card line for a tool call, e.g. "Directory create · `53-wurst-gemuese-topf`". Null for internal bookkeeping. */
function progressStepLabel(name: string, rawArguments = ''): string | null {
    if (rawArguments.includes('"attachment-index"')) return null
    // "Shell execute" says little; the stated purpose says what is happening.
    const shell = shellCallDetails(rawArguments)
    if (shell?.explanation) return `💻 ${shell.explanation.replace(/[`*_\r\n]/g, ' ').slice(0, 60)}`
    const target = toolCallTarget(rawArguments)
    let short = target
    if (target) {
        try { short = /^https?:/i.test(target) ? new URL(target).hostname : target } catch { /* not a URL after all */ }
        short = short!.split(/[\\/]/).filter(Boolean).pop() ?? short
    }
    const label = toolDisplayName(name).slice(0, 48)
    return short ? `${label} · \`${short.replace(/[`\r\n]/g, ' ').slice(0, 48)}\`` : label
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
    const displayText = userText || mediaPlaceholder(media)
    // Immediate feedback: the message was seen and the agent is on it.
    await transport.react?.('👀')
    void transport.sendTyping?.().catch(() => {})

    const continued = message.continueConversationId
        ? resolveContinuedConversation(state, message.continueConversationId)
        : null
    const agentId = continued?.agentId ?? effectiveAgentId(state, target)

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
        await transport.react?.(null)
        await transport.reply('⚠️ Agent not found.')
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
    let sendChain = Promise.resolve()
    const enqueueSend = (fn: () => Promise<void>): void => {
        sendChain = sendChain.then(fn).catch((err: unknown) => {
            console.warn(`${transport.logTag} Progress delivery failed:`, (err as Error).message)
        })
    }
    state.conversationSendQueue.set(conversationId, enqueueSend)
    const eventBus = getEventBus()

    // ─── Status card ─────────────────────────────────────────
    // One message that shows elapsed time and the agent's recent steps. It is
    // created only once work takes a while and removed when the answer arrives.
    const steps: ChannelProgressStep[] = []
    const approvals = new Map<string, { resolve?: ChannelHITLRequest['resolve']; callIds: string[] }>()
    let note: string | undefined
    let card: H | null = null
    let cardWanted = false
    let renderQueued = false
    let progressClosed = false
    const refresh = () => {
        if (!cardWanted || progressClosed || renderQueued) return
        renderQueued = true
        enqueueSend(async () => {
            renderQueued = false
            // A new card would land below the approval prompt; post it once that is answered.
            if (progressClosed || (card === null && approvals.size)) return
            const text = renderChannelProgress({ elapsedMs: Date.now() - startedAt, awaitingApproval: approvals.size > 0, steps, note })
            if (card === null) card = await transport.reply(text)
            else await transport.edit(card, text)
        })
    }
    const showProgress = () => {
        cardWanted = true
        refresh()
    }
    const cardTimer = setTimeout(showProgress, STATUS_CARD_DELAY_MS)
    const progressTimer = setInterval(() => {
        // Approval prompts are the active UI while paused; do not keep counting.
        if (!approvals.size) refresh()
    }, PROGRESS_INTERVAL_MS)
    const unsubs: Array<() => void> = [() => clearTimeout(cardTimer), () => clearInterval(progressTimer)]
    const ownEvent = (data: { conversationId?: string; maCodename?: string }) =>
        data.conversationId === conversationId && !data.maCodename
    unsubs.push(eventBus.on('step:tools-chosen', (...args: unknown[]) => {
        const data = args[0] as { conversationId?: string; maCodename?: string; toolCalls?: Array<{ id?: string; name: string; arguments?: string }> }
        if (!ownEvent(data)) return
        let added = false
        for (const call of data.toolCalls ?? []) {
            const label = progressStepLabel(call.name, call.arguments)
            if (label) steps.push({ id: call.id ?? `name:${call.name}`, label, state: 'running' })
            added ||= Boolean(label)
        }
        if (added) showProgress()
    }))
    unsubs.push(eventBus.on('step:executed', (...args: unknown[]) => {
        const data = args[0] as { conversationId?: string; maCodename?: string; results?: Array<{ toolCallId?: string; name?: string; success?: boolean }> }
        if (!ownEvent(data)) return
        for (const result of data.results ?? []) {
            const id = result.toolCallId ?? `name:${result.name}`
            const step = steps.find(item => item.id === id && item.state === 'running')
            if (step) step.state = result.success ? 'done' : 'failed'
        }
        refresh()
    }))
    unsubs.push(eventBus.on('hitl:request', (...args: unknown[]) => {
        const data = args[0] as Partial<ChannelHITLRequest> & { taskId: string }
        if (data.conversationId !== conversationId) return
        approvals.set(data.taskId, { resolve: data.resolve, callIds: (data.toolCalls ?? []).map(call => call.id) })
        showProgress()
    }))
    const approvalFinished = (...args: unknown[]) => {
        const data = args[0] as { taskId: string; approved?: boolean }
        const approval = approvals.get(data.taskId)
        if (!approval) return
        approvals.delete(data.taskId)
        if (data.approved === false) {
            for (const step of steps) if (step.state === 'running' && approval.callIds.includes(step.id)) step.state = 'declined'
        }
        refresh()
    }
    unsubs.push(eventBus.on('hitl:resolved', approvalFinished))
    unsubs.push(eventBus.on('hitl:cancel-request', approvalFinished))
    if (transport.sendTyping) {
        const sendTyping = transport.sendTyping.bind(transport)
        const typingTimer = setInterval(() => {
            if (!progressClosed && !approvals.size) void sendTyping().catch(() => {})
        }, transport.typingIntervalMs ?? 5000)
        unsubs.push(() => clearInterval(typingTimer))
    }
    const closeProgress = async () => {
        progressClosed = true
        for (const unsub of unsubs.splice(0)) unsub()
        await sendChain
        if (card !== null) await transport.delete(card).catch(() => {})
        card = null
    }

    // ─── Steering ────────────────────────────────────────────
    // Follow-ups go through the chat queue as steering, like in Cynosure itself;
    // the executor picks them up at the next model boundary.
    const settles: Array<() => Promise<void>> = []
    const turn: ActiveChannelTurn = {
        conversationId,
        steer: async (text, steerMedia, settle) => {
            if (settle) settles.push(settle)
            await enqueueChatMessage(conversationId, {
                content: text || mediaPlaceholder(steerMedia), delivery: 'steer', run: {},
                imageDataUrls: steerMedia.imageDataUrls, audioDataUrls: steerMedia.audioDataUrls,
            })
            // An open approval would hold the follow-up back until answered.
            for (const [taskId, approval] of approvals) {
                if (approval.resolve) resolveChannelHITL(state.broadcast, { conversationId, resolve: approval.resolve }, taskId, false, transport.logTag, STEERING_DECLINE_REASON)
            }
            note = '↪ Got your follow-up — taking it into account.'
            showProgress()
        },
    }
    state.activeTurns.set(target, turn)
    const endTurn = () => { if (state.activeTurns.get(target) === turn) state.activeTurns.delete(target) }
    let unregisterSteering = () => {}
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
            contextWindow: context.contextWindow,
            contextStrategy: context.strategy, isPrimaryExecutor: true,
            takeSteeringMessages: () => takeSteeringMessages(conversationId, streamId),
        })
        unregisterSteering = registerChatSteeringHandler(conversationId, () => executor.requestSteering())

        // Channels are linear conversations. Intermediate prose, tool results and
        // sub-agent output stay in Cynosure; only the complete answer is posted here.
        const result = await executor.run(messages)
        // From here on, new messages start the next turn instead of steering this one.
        unregisterSteering()
        endTurn()
        if (planned.planningRunId) {
            closePlanningRun(planned.planningRunId, 'completed', { summary: result.content.slice(0, 500) })
        }
        await closeProgress()

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
        queueTurnCompleted = !execAbort.signal.aborted
    } catch (err) {
        unregisterSteering()
        endTurn()
        const aborted = execAbort.signal.aborted
        if (planned?.planningRunId && !replySaved) {
            const isAbort = (err as Error).name === 'AbortError'
            closePlanningRun(planned.planningRunId, isAbort ? 'cancelled' : 'error', { error: isAbort ? 'Cancelled' : (err as Error).message })
        }
        const errorMsg = (err as Error).message || 'Unknown error'
        console.error(`${transport.logTag} Agent execution error: ${errorMsg}`)
        getEventBus().emit('task:error', { conversationId, error: aborted ? 'Cancelled' : errorMsg })
        if (!aborted && !replySaved) publishChannelStreamError(state.broadcast, conversationId, streamId, errorMsg)
        await closeProgress()
        // The outcome goes at the bottom, after any approval prompts.
        await transport.reply(aborted ? '⏹ Stopped.' : replySaved
            ? '⚠️ Your reply was saved in Cynosure, but could not be fully delivered here. Open Cynosure to read it.'
            : `⚠️ I couldn't finish this request: ${errorMsg.slice(0, 300)}`)
    } finally {
        unregisterSteering()
        endTurn()
        finishChannelExecution({ executions: state.activeExecutions, executionId: streamId, conversationId, agentId, broadcast: state.broadcast })
        progressClosed = true
        for (const unsub of unsubs.splice(0)) unsub()
        await sendChain
        state.conversationSendQueue.delete(conversationId)
        finishQueueTurn(queueTurnCompleted)
        for (const settle of [() => transport.react?.(null) ?? Promise.resolve(), ...settles]) {
            await settle().catch(() => {})
        }
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
