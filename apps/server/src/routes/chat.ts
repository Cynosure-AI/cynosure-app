import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getGateway } from '../core/gateway/gateway.js'
import { applyCompactStrategy } from '../core/agent/context-compactor.js'
import { getToolRegistry } from '../core/tools/tool-registry.js'
import { getEventBus } from '../core/telemetry/event-bus.js'
import { AgentExecutor, MAIN_AGENT_MAX_ROUNDS } from '../core/agent/agent-executor.js'
import { planExecution } from '../core/agent/pre-execution/execution-planner.js'
import { closePlanningRun, interruptPlanningRun } from '../core/agent/planning-state.js'
import { TOOL_SEARCH_TOOL_NAME } from '../core/tools/builtin/expand-available-toolset.js'
import { isBuiltInMemoryToolKey } from '../core/tools/built-in-tools.js'
import { getAgent } from '../core/agents/agent-store.js'
import { generateTitle, buildFallbackTitle, getActiveActions, getAllActiveActions, cancelPostActions } from '../core/agent/post-execution.js'
import { trimMessagesToContextLimit, estimateTotalTokens, estimateToolDefinitionTokens } from '../core/agent/context-trimmer.js'
import type {
  ChatMessage,
  ContentPart,
  RegistryAwareToolDefinition,
  VideoGenerationJob,
  VideoGenerationModelInfo,
  VideoGenerationRequest,
} from '../core/gateway/providers/base.provider.js'
import { nanoid } from 'nanoid'
import { getChannelManager } from '../core/channels/channel-manager.js'
import { artifactFileUrlToDataUrl, materializeAudioArtifacts, materializeImageArtifacts, materializeMediaBuffer } from '../core/artifacts/image-artifacts.js'
import { materializeFileAttachments, readFileAttachmentText } from '../core/artifacts/file-artifacts.js'
import { ATTACHMENT_SYSTEM_CONTEXT, buildAttachmentContextBundle, indexConversationAttachment, listConversationFileAttachments, makeAttachmentTools, persistMessageFileAttachments } from '../core/artifacts/attachment-rag.js'
import {
  cancelChatExecution,
  cancelChatExecutionByConversation,
  getChatExecutionIdsByConversation,
  registerActiveChatExecution,
  unregisterActiveChatExecution,
  updateActiveChatExecution,
} from '../core/chat/active-executions.js'
import { withConversationLock } from '../core/chat/conversation-locks.js'
import { getChatAttachmentConfig, normalizeInlineAttachmentTextLimit, saveChatAttachmentConfig } from '../core/chat/attachment-settings.js'
import { appendHiddenSystemContext, buildConversationHistory, buildRecentImageArtifactsSystemHint, insertTurnLocalUntrustedContext } from '../core/chat/message-history.js'
import { buildPersistedChatConfig, resolveChatRunFlags, resolveMemorySpaceOverrides, resolveToolSelection } from '../core/chat/run-config.js'
import { beginDebugContextCapture, getDebugContextCapture, updateDebugContextCapture } from '../core/chat/debug-context.js'
import type { ChatSendRequest, ConversationExecutionConfig } from '@shared/types'
import type { ChatQueueRequest } from '@shared/types'
import {
  configureChatQueue,
  deleteQueuedChatMessage,
  deleteQueuedChatAttachment,
  enqueueChatMessage,
  getChatQueueState,
  markQueuedMessagePromoted,
  pauseChatQueue,
  promoteQueuedMessageToSteering,
  registerChatSteeringHandler,
  replaceQueuedChatMessage,
  runNextQueuedMessage,
  takeSteeringMessages,
  type QueuedExecutionRequest,
} from '../core/chat/message-queue.js'

type BroadcastFn = (event: string, data: unknown) => void

function audioInputFromDataUrl(dataUrl: string): { data: string; format?: string } {
  const match = /^data:audio\/([^;,]+)(?:;[^,]*)?;base64,(.+)$/i.exec(dataUrl)
  if (!match) {
    throw new Error('Attached audio must be a base64 audio data URL')
  }
  const rawFormat = match[1].toLowerCase()
  const formatAliases: Record<string, string> = {
    mpeg: 'mp3',
    mp4: 'm4a',
    'x-m4a': 'm4a',
    'x-wav': 'wav',
    wave: 'wav',
    vorbis: 'ogg',
  }
  return {
    format: formatAliases[rawFormat] || rawFormat,
    data: match[2],
  }
}

function usedToolKeysFromNames(
  tools: RegistryAwareToolDefinition[],
  usedToolNames: Set<string>,
  toolRegistry: ReturnType<typeof getToolRegistry>,
): string[] {
  return Array.from(
    new Set(
      tools
        .filter((tool) => usedToolNames.has(tool.name))
        .filter((tool) => tool.name !== TOOL_SEARCH_TOOL_NAME)
        .map((tool) => tool.registryKey)
        .filter((key): key is string => typeof key === 'string' && key.length > 0)
        .filter((key) => toolRegistry.hasKey(key))
        .filter((key) => !isBuiltInMemoryToolKey(key))
    )
  )
}

function persistStickyUsedTools(
  db: ReturnType<typeof getDb>,
  conversationId: string,
  executionConfig: ConversationExecutionConfig,
  tools: RegistryAwareToolDefinition[],
  usedToolNames: Set<string>,
  toolRegistry: ReturnType<typeof getToolRegistry>,
): void {
  const stickyTools = usedToolKeysFromNames(tools, usedToolNames, toolRegistry)
  if (!stickyTools.length) return

  const allowedTools = Array.from(new Set([...executionConfig.allowedTools, ...stickyTools]))
  if (allowedTools.length === executionConfig.allowedTools.length) return

  db.prepare('UPDATE conversations SET execution_config_json = ? WHERE id = ?').run(
    JSON.stringify({ ...executionConfig, allowedTools }),
    conversationId
  )
}

function clearPendingHITLForConversation(conversationId: string): void {
  getEventBus().emit('hitl:clear-conversation', { conversationId })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

function isTerminalVideoStatus(status: string): boolean {
  return ['completed', 'failed', 'cancelled', 'expired'].includes(status.toLowerCase())
}

async function pollVideoGeneration(
  gateway: ReturnType<typeof getGateway>,
  providerId: string,
  initialJob: VideoGenerationJob,
  signal?: AbortSignal,
): Promise<VideoGenerationJob> {
  let job = initialJob
  const deadline = Date.now() + 10 * 60 * 1000
  while (!isTerminalVideoStatus(job.status) && Date.now() < deadline) {
    await sleep(4_000, signal)
    job = await gateway.getVideoGenerationJob(job.id, providerId)
  }
  if (!isTerminalVideoStatus(job.status)) {
    throw new Error('Video generation did not finish before the polling timeout')
  }
  if (job.status.toLowerCase() !== 'completed') {
    throw new Error(job.error || `Video generation ${job.status}`)
  }
  return job
}

function buildVideoGenerationRequest(input: {
  model: string
  prompt: string
  imageDataUrls?: string[]
  videoModel?: VideoGenerationModelInfo
  signal?: AbortSignal
}): VideoGenerationRequest {
  const request: VideoGenerationRequest = {
    model: input.model,
    prompt: input.prompt,
    signal: input.signal,
  }
  const images = (input.imageDataUrls || []).filter((url) => typeof url === 'string' && url.trim())
  if (!images.length) return request

  const supportedFrames = new Set(input.videoModel?.supported_frame_images || [])
  if (supportedFrames.has('first_frame')) {
    request.frame_images = [{
      type: 'image_url',
      image_url: { url: images[0] },
      frame_type: 'first_frame',
    }]
    if (images[1] && supportedFrames.has('last_frame')) {
      request.frame_images.push({
        type: 'image_url',
        image_url: { url: images[1] },
        frame_type: 'last_frame',
      })
    }
    return request
  }

  request.input_references = images.map((url) => ({
    type: 'image_url',
    image_url: { url },
  }))
  return request
}

export async function registerChatRoutes(app: FastifyInstance, broadcast: BroadcastFn): Promise<void> {
  const gateway = getGateway()

  // GET /api/chat/attachment-config — get attachment context settings
  app.get('/attachment-config', async () => {
    return getChatAttachmentConfig()
  })

  // POST /api/chat/attachment-config — update attachment context settings
  app.post<{ Body: { inlineAttachmentTextLimit: number } }>('/attachment-config', async (req, reply) => {
    const rawLimit = req.body.inlineAttachmentTextLimit
    if (!Number.isFinite(Number(rawLimit))) {
      return reply.status(400).send({ error: 'inlineAttachmentTextLimit must be a number' })
    }
    const { inlineAttachmentTextLimit } = saveChatAttachmentConfig({ inlineAttachmentTextLimit: rawLimit })
    return { success: true, inlineAttachmentTextLimit }
  })

  // GET /api/chat/conversations/:id/debug-context — latest opt-in gateway capture
  app.get<{ Params: { id: string } }>('/conversations/:id/debug-context', async (req, reply) => {
    const capture = getDebugContextCapture(req.params.id)
    if (!capture) {
      return reply.status(404).send({ error: 'No debug context has been captured for this conversation' })
    }
    return capture
  })

  async function executeSend(conversationId: string, request: QueuedExecutionRequest): Promise<boolean> {
    const initialConversation = getDb().prepare('SELECT agent_id FROM conversations WHERE id = ?')
      .get(conversationId) as { agent_id: string | null } | undefined
    const initialAgentId = initialConversation?.agent_id || null
    const initialAgent = initialAgentId ? getAgent(initialAgentId) : null
    const abortController = new AbortController()
    const streamId = nanoid()
    const executionId = streamId
    const executionBroadcast: BroadcastFn = (event, data) => {
      const payload = data && typeof data === 'object'
        ? { ...(data as Record<string, unknown>), executionId }
        : data
      const terminalEvent = event.endsWith('-end') || event.endsWith('-error')
      if (abortController.signal.aborted && !terminalEvent) return
      broadcast(event, payload)
    }

    // Registration happens before the conversation lock and before any async
    // preflight work. There is no window in which Stop can miss this request
    // and allow it to register itself later as a seemingly new execution.
    registerActiveChatExecution({
      id: executionId,
      conversationId,
      agentId: initialAgentId,
      model: request.run.model || initialAgent?.model || null,
      startedAt: Date.now(),
    }, abortController)

    const outcome = await withConversationLock(conversationId, async () => {
      abortController.signal.throwIfAborted()
      const { content, messageId: providedMsgId, imageDataUrls, audioDataUrls, files } = request
      const normalizedContent = content.trim() || (audioDataUrls?.length ? 'Transcribe the attached audio.' : content)
      // Browser-facing artifact URLs are relative API routes. Resolve them for
      // providers as a defensive fallback (edits normally use the dedicated
      // attachment-resolution endpoint before truncating the old message).
      const providerImageDataUrls = imageDataUrls?.map((url) => artifactFileUrlToDataUrl(url) || url)
      const providerAudioDataUrls = audioDataUrls?.map((url) => artifactFileUrlToDataUrl(url) || url)
      const run = request.run
      const {
        model,
        providerOverride,
        allowedTools,
        systemPrompt,
        generateTitle: generateTitlePref,
        subAgents: reqSubAgents,
        memorySpaceIds: reqMemorySpaceIds,
        thinkingEnabled: reqThinkingEnabled,
        reasoningEffort: reqReasoningEffort,
        contextStrategy: reqContextStrategy,
        autoToolRouting: reqAutoToolRouting,
        autoMemory: reqAutoMemory,
        autoRouterProviderId: reqAutoRouterProviderId,
        autoRouterModel: reqAutoRouterModel,
        compactProviderId: reqCompactProviderId,
        compactModel: reqCompactModel,
        titleProviderId: titleProviderIdPref,
        titleModel: titleModelPref,
        inlineAttachmentTextLimit: reqInlineAttachmentTextLimit,
        debugMode: reqDebugMode,
      } = run
      const db = getDb()
      const inlineAttachmentTextLimit = reqInlineAttachmentTextLimit !== undefined
        ? normalizeInlineAttachmentTextLimit(reqInlineAttachmentTextLimit)
        : getChatAttachmentConfig(db).inlineAttachmentTextLimit
      const toolRegistry = getToolRegistry()
      const { selectedToolKeys, hasExplicitToolAllowlist } = resolveToolSelection(
        toolRegistry,
        allowedTools,
        reqAutoToolRouting,
      )

      // Persist user-uploaded images as file artifacts and keep only file URLs in DB.
      // We still use inline data URLs for the immediate provider request in this send call.
      let storedImageUrls = providerImageDataUrls
      if (providerImageDataUrls?.length) {
        try {
          const artifacts = await materializeImageArtifacts(providerImageDataUrls, conversationId)
          abortController.signal.throwIfAborted()
          storedImageUrls = artifacts.map((artifact) => artifact.url)
        } catch (err) {
          if (abortController.signal.aborted) throw err
          console.warn('[chat] Failed to materialize user images, keeping original URLs:', err)
        }
      }

      // Persist audio beside the other conversation artifacts. Keep the original
      // data URLs only for the immediate provider request below.
      let storedAudioUrls = providerAudioDataUrls
      if (providerAudioDataUrls?.length) {
        try {
          const artifacts = await materializeAudioArtifacts(providerAudioDataUrls, conversationId)
          abortController.signal.throwIfAborted()
          storedAudioUrls = artifacts.map((artifact) => artifact.url)
        } catch (err) {
          if (abortController.signal.aborted) throw err
          console.warn('[chat] Failed to materialize user audio, keeping original URLs:', err)
        }
      }

      const storedFileAttachments = request.stagedFileArtifacts
        ? request.stagedFileArtifacts
        : files?.length
          ? await materializeFileAttachments(files, conversationId)
          : []
      abortController.signal.throwIfAborted()
      if (!request.stagedFileArtifacts) {
        for (const attachment of storedFileAttachments) {
          attachment.chunkCount = await indexConversationAttachment(conversationId, attachment)
          abortController.signal.throwIfAborted()
        }
      }

      // Build content (text + optional images + optional audio + optional files)
      let userContent: string | ContentPart[]
      if (providerImageDataUrls?.length || providerAudioDataUrls?.length || storedFileAttachments.length) {
        const parts: ContentPart[] = [{ type: 'text', text: normalizedContent }]
        if (storedFileAttachments.length) {
          for (const file of storedFileAttachments) {
            if (file.textBytes > inlineAttachmentTextLimit) {
              const status = file.chunkCount && file.chunkCount > 0
                ? `This attachment is indexed for retrieval (${file.chunkCount} chunks, attachmentId: ${file.id}).`
                : `This attachment is larger than the inline context limit and will be indexed for retrieval (attachmentId: ${file.id}).`
              parts.push({
                type: 'text',
                text: `[Attached file: ${file.name}]\n${status} Relevant excerpts will be provided as context; use attachment_search/attachment_read for more detail.`
              })
              continue
            }
            const fileText = readFileAttachmentText(file)
            if (fileText === null) continue
            parts.push({
              type: 'text',
              text: `[Attached file: ${file.name}]\n${fileText}`
            })
          }
        }
        if (providerImageDataUrls?.length) {
          for (const url of providerImageDataUrls) {
            parts.push({ type: 'image_url', image_url: { url } })
          }
        }
        if (providerAudioDataUrls?.length) {
          for (const url of providerAudioDataUrls) {
            parts.push({ type: 'audio_url', audio_url: { url } })
          }
        }
        userContent = parts
      } else {
        userContent = normalizedContent
      }

      // Save user message (with images if present)
      // Use the client-provided messageId when valid (enables stable IDs for retry/edit).
      const idPattern = /^[A-Za-z0-9_-]{6,36}$/
      const userMsgId = (providedMsgId && idPattern.test(providedMsgId)) ? providedMsgId : nanoid()
      const now = Date.now()
      db.transaction(() => {
        db.prepare(
          `INSERT INTO messages (id, conversation_id, role, content, image_urls_json, audio_urls_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(userMsgId, conversationId, 'user', normalizedContent, storedImageUrls?.length ? JSON.stringify(storedImageUrls) : null, storedAudioUrls?.length ? JSON.stringify(storedAudioUrls) : null, now)
        persistMessageFileAttachments(db, userMsgId, conversationId, storedFileAttachments, now)
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)
        if (request.fromQueue) markQueuedMessagePromoted(conversationId, userMsgId)
      })()
      if (request.fromQueue) {
        broadcast('chat:new-message', {
          conversationId,
          streamId,
          message: {
            id: userMsgId,
            conversationId,
            role: 'user',
            content: normalizedContent,
            imageDataUrls: storedImageUrls,
            audioDataUrls: storedAudioUrls,
            fileAttachments: storedFileAttachments.map(file => ({ name: file.name })),
            createdAt: now,
          },
        })
      }

      const convRow = db.prepare('SELECT agent_id FROM conversations WHERE id = ?').get(conversationId) as { agent_id: string | null } | undefined
      const mainAgentId: string | null = convRow?.agent_id || null
      const history = buildConversationHistory({
        db,
        conversationId,
        mainAgentId,
        inlineAttachmentTextLimit,
      })
      const { historyRows, filteredRows } = history
      let messages: ChatMessage[] = history.messages

      // Replace last user message with multimodal version if images/files/audio present
      if (providerImageDataUrls?.length || providerAudioDataUrls?.length || storedFileAttachments.length) {
        messages[messages.length - 1] = {
          ...messages[messages.length - 1],
          content: userContent
        }
      }

      // Resolve agent for this conversation (used by both MA planning and normal chat)
      const convCheck = db.prepare('SELECT agent_id, ma_workspace_id FROM conversations WHERE id = ?').get(conversationId) as { agent_id: string | null; ma_workspace_id: string | null } | undefined
      const agentId: string | null = convCheck?.agent_id || null
      const resolvedAgent = agentId ? getAgent(agentId) : null
      const effectiveRunFlags = resolveChatRunFlags({
        resolvedAgent,
        autoMemory: reqAutoMemory,
      })

      // Resolve memory space overrides (request body ids -> { id, name } objects)
      const memorySpaceOverrides = resolveMemorySpaceOverrides(db, reqMemorySpaceIds)

      const usedToolNames = new Set<string>()

      if (reqDebugMode === true) {
        beginDebugContextCapture({
          conversationId,
          executionId,
          providerId: providerOverride || resolvedAgent?.providerId,
          model: model || resolvedAgent?.model,
          contextStrategy: reqContextStrategy || 'sliding-window',
        })
      }

      let planned: Awaited<ReturnType<typeof planExecution>>
      try {
        planned = await planExecution({
          resolvedAgent,
          conversationId,
          broadcast: executionBroadcast,
          abortSignal: abortController.signal,
          gateway,
          toolRegistry,
          messages,
          userText: normalizedContent,
          eventMeta: { executionId },
          run: {
            providerOverride: providerOverride || undefined,
            modelOverride: model || undefined,
            systemPrompt: systemPrompt || undefined,
            requestedSubAgents: reqSubAgents,
            memorySpaceOverrides,
            autoToolRouting: typeof reqAutoToolRouting === 'boolean' ? reqAutoToolRouting : undefined,
            autoMemory: effectiveRunFlags.autoMemory,
            autoRouterProviderId: reqAutoRouterProviderId || undefined,
            autoRouterModel: reqAutoRouterModel || undefined,
            selectedToolKeys: Array.isArray(allowedTools) ? selectedToolKeys : undefined,
            hasExplicitToolAllowlist,
            usedToolNames,
            thinkingEnabled: reqThinkingEnabled !== undefined ? reqThinkingEnabled : (resolvedAgent?.thinkingEnabled !== false),
            reasoningEffort: reqReasoningEffort,
            inlineAttachmentTextLimit,
            debugContextEnabled: reqDebugMode === true,
          },
        })
      } catch (err) {
        unregisterActiveChatExecution(executionId)
        if ((err as Error).name === 'AbortError' || abortController.signal.aborted) {
          getEventBus().emit('task:error', { conversationId, executionId, error: 'Cancelled' })
          executionBroadcast('chat:stream-end', { streamId, conversationId, cancelled: true })
          return { streamId }
        }
        throw err
      }

      const {
        tools: plannedTools,
        providerId,
        responseProvider,
        responseModel,
        planningRunId,
        chatAgentName,
        chatAgentIconUrl,
        evidence: preparedEvidence,
      } = planned
      updateActiveChatExecution(executionId, { model: responseModel, planningRunId })
      if (abortController.signal.aborted) {
        unregisterActiveChatExecution(executionId)
        if (planningRunId) {
          interruptPlanningRun(planningRunId, { error: 'Interrupted before completion.' })
        }
        getEventBus().emit('task:error', { conversationId, executionId, error: 'Cancelled' })
        executionBroadcast('chat:stream-end', { streamId, conversationId, cancelled: true })
        return { streamId }
      }
      const tools: RegistryAwareToolDefinition[] = plannedTools
      let executionConfig: ConversationExecutionConfig | null = null
      let attemptedVideoOutput = false
      try {
        messages = planned.messages
        const turnEvidence = [...preparedEvidence]

        const responseSupportsToolCalls = await gateway.modelSupportsToolCalls(responseModel, responseProvider)
        abortController.signal.throwIfAborted()
        const hasConversationFileAttachments = listConversationFileAttachments(db, conversationId).length > 0
        if (responseSupportsToolCalls && hasConversationFileAttachments) {
          tools.push(...makeAttachmentTools(conversationId))
        }
        const attachmentContext = await buildAttachmentContextBundle(conversationId, normalizedContent, db)
        messages = appendHiddenSystemContext(messages, attachmentContext?.content ?? null)
        if (attachmentContext?.evidence.length) turnEvidence.push(...attachmentContext.evidence)
        if (reqDebugMode === true) updateDebugContextCapture(conversationId, { evidence: turnEvidence })
        abortController.signal.throwIfAborted()
        if (attachmentContext) {
          messages = appendHiddenSystemContext(messages, ATTACHMENT_SYSTEM_CONTEXT)
          messages = insertTurnLocalUntrustedContext(messages, attachmentContext.content, 'retrieved-attachment')
        }
        messages = appendHiddenSystemContext(messages, buildRecentImageArtifactsSystemHint(filteredRows))

        // Persist the full session config with RESOLVED model/provider so it can
        // be restored correctly when navigating back to this conversation.
        executionConfig = buildPersistedChatConfig({
          selectedToolKeys,
          requestedSubAgents: reqSubAgents,
          requestedMemorySpaceIds: reqMemorySpaceIds,
          systemPrompt,
          responseModel,
          responseProvider,
          thinkingEnabled: reqThinkingEnabled !== undefined
            ? reqThinkingEnabled
            : (resolvedAgent?.thinkingEnabled !== false),
          reasoningEffort: reqReasoningEffort ?? resolvedAgent?.reasoningEffort,
          autoToolRouting: reqAutoToolRouting === true,
          autoMemory: effectiveRunFlags.autoMemory,
        })
        db.prepare('UPDATE conversations SET execution_config_json = ? WHERE id = ?').run(
          JSON.stringify(executionConfig),
          conversationId
        )

        const resolvedModelInfo = await gateway.getModelInfo(responseModel, responseProvider).catch(() => null)
        abortController.signal.throwIfAborted()
        const isVideoOutputModel = resolvedModelInfo?.outputModalities
          ?.some((modality) => modality.toLowerCase() === 'video') === true
        const isTranscriptionOutputModel = resolvedModelInfo?.outputModalities
          ?.some((modality) => modality.toLowerCase() === 'transcription') === true
        if (isVideoOutputModel) {
          attemptedVideoOutput = true
          executionBroadcast('chat:stream-start', {
            streamId,
            conversationId,
            agentId: agentId || undefined,
            agentName: chatAgentName,
            agentIconUrl: chatAgentIconUrl,
          })
          executionBroadcast('chat:stream-chunk', {
            streamId,
            conversationId,
            content: 'Generating video...',
          })

          const videoModel = await gateway.listVideoModels(responseProvider)
            .then((models) => models.find((item) => item.id === responseModel || item.canonical_slug === responseModel))
            .catch(() => undefined)
          const submittedJob = await gateway.generateVideo(buildVideoGenerationRequest({
            model: responseModel,
            prompt: normalizedContent,
            imageDataUrls: providerImageDataUrls,
            videoModel,
            signal: abortController.signal,
          }), responseProvider)
          const completedJob = await pollVideoGeneration(gateway, responseProvider, submittedJob, abortController.signal)
          abortController.signal.throwIfAborted()
          const videoContent = await gateway.getVideoGenerationContent(completedJob.id, 0, responseProvider)
          abortController.signal.throwIfAborted()
          const videoArtifact = materializeMediaBuffer(
            videoContent.data,
            videoContent.contentType,
            conversationId,
            'video',
          )
          const videoUrls = [videoArtifact.url]

          executionBroadcast('chat:stream-videos', { streamId, conversationId, videos: videoUrls })
          executionBroadcast('chat:stream-end', { streamId, conversationId, model: responseModel })
          abortController.signal.throwIfAborted()

          const assistantMsgId = nanoid()
          const assistantNow = Date.now()
          const assistantContent = 'Generated video.'
          db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, video_urls_json, generated_media, agent_id, provider, model, latency_ms, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            assistantMsgId,
            conversationId,
            'assistant',
            assistantContent,
            JSON.stringify(videoUrls),
            1,
            agentId,
            responseProvider,
            responseModel,
            assistantNow - now,
            assistantNow
          )
          executionBroadcast('chat:new-message', {
            conversationId, streamId,
            message: { id: assistantMsgId, conversationId, role: 'assistant', content: assistantContent, createdAt: assistantNow, agentId },
          })
          db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(assistantNow, conversationId)

          const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title: string } | undefined
          if (conv && conv.title === 'New Chat') {
            if (generateTitlePref !== false) {
              generateTitle({
                conversationId,
                userMessage: normalizedContent,
                assistantResponse: assistantContent,
                broadcast,
                providerId: titleProviderIdPref || responseProvider,
                model: titleModelPref || (titleProviderIdPref ? undefined : responseModel)
              }).catch(() => { })
            } else {
              const fallback = buildFallbackTitle(normalizedContent)
              if (fallback) {
                db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(fallback, Date.now(), conversationId)
                broadcast('chat:title-updated', { conversationId, title: fallback })
              }
            }
          }
          return { streamId, completed: true }
        }

        if (isTranscriptionOutputModel) {
          if (!providerAudioDataUrls?.length) {
            throw new Error('Transcription models require an attached audio file.')
          }

          executionBroadcast('chat:stream-start', {
            streamId,
            conversationId,
            agentId: agentId || undefined,
            agentName: chatAgentName,
            agentIconUrl: chatAgentIconUrl,
          })
          executionBroadcast('chat:stream-chunk', {
            streamId,
            conversationId,
            content: 'Transcribing audio...',
          })

          const transcripts: string[] = []
          let promptTokens = 0
          let completionTokens = 0
          let totalTokens = 0
          for (const audioUrl of providerAudioDataUrls) {
            abortController.signal.throwIfAborted()
            const transcription = await gateway.transcribeAudio({
              model: responseModel,
              inputAudio: audioInputFromDataUrl(audioUrl),
              signal: abortController.signal,
            }, responseProvider)
            abortController.signal.throwIfAborted()
            if (transcription.text.trim()) transcripts.push(transcription.text.trim())
            promptTokens += transcription.usage?.input_tokens ?? 0
            completionTokens += transcription.usage?.output_tokens ?? 0
            totalTokens += transcription.usage?.total_tokens ?? 0
          }

          const assistantContent = transcripts.length
            ? transcripts.join('\n\n')
            : '(No transcription text returned.)'
          executionBroadcast('chat:stream-chunk', {
            streamId,
            conversationId,
            content: `\n\n${assistantContent}`,
          })
          executionBroadcast('chat:stream-end', { streamId, conversationId, model: responseModel })
          abortController.signal.throwIfAborted()

          const assistantMsgId = nanoid()
          const assistantNow = Date.now()
          db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, agent_id, provider, model, prompt_tokens, completion_tokens, context_tokens, latency_ms, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            assistantMsgId,
            conversationId,
            'assistant',
            assistantContent,
            agentId,
            responseProvider,
            responseModel,
            promptTokens || null,
            completionTokens || null,
            totalTokens || null,
            assistantNow - now,
            assistantNow
          )
          executionBroadcast('chat:new-message', {
            conversationId, streamId,
            message: { id: assistantMsgId, conversationId, role: 'assistant', content: assistantContent, createdAt: assistantNow, agentId },
          })
          db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(assistantNow, conversationId)

          const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title: string } | undefined
          if (conv && conv.title === 'New Chat') {
            if (generateTitlePref !== false) {
              generateTitle({
                conversationId,
                userMessage: normalizedContent,
                assistantResponse: assistantContent,
                broadcast,
                providerId: titleProviderIdPref || responseProvider,
                model: titleModelPref || (titleProviderIdPref ? undefined : responseModel)
              }).catch(() => { })
            } else {
              const fallback = buildFallbackTitle(normalizedContent)
              if (fallback) {
                db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(fallback, Date.now(), conversationId)
                broadcast('chat:title-updated', { conversationId, title: fallback })
              }
            }
          }
          return { streamId, completed: true }
        }

        // Fetch context window size (best-effort, non-blocking for the critical path)
        let contextWindow: number | undefined
        try {
          const modelInfo = resolvedModelInfo || await gateway.getModelInfo(responseModel, providerId)
          contextWindow = modelInfo.contextLength
        } catch { /* ignore — context window info is optional */ }

        // If the agent defines a hard max-context-token limit, use the lower of
        // the model's context window and the agent's cap as the effective window.
        const agentMaxCtx = resolvedAgent?.maxContextTokens
        if (typeof agentMaxCtx === 'number' && agentMaxCtx > 0) {
          contextWindow = contextWindow
            ? Math.min(contextWindow, agentMaxCtx)
            : agentMaxCtx
        }

        // Apply context strategy (trim or compact) to fit the model's context window
        const contextStrategy = reqContextStrategy || 'sliding-window'
        let initialContextEstimate: number | undefined
        if (contextStrategy === 'compact' && contextWindow) {
          const compactResult = await applyCompactStrategy({
            messages,
            historyRows,
            filteredRows,
            contextWindow,
            tools,
            thinkingEnabled: reqThinkingEnabled !== undefined
              ? reqThinkingEnabled
              : (resolvedAgent?.thinkingEnabled !== false),
            reasoningEffort: reqReasoningEffort ?? resolvedAgent?.reasoningEffort,
            gateway,
            providerId,
            responseModel,
            compactProviderId: reqCompactProviderId || undefined,
            compactModel: reqCompactModel || undefined,
            conversationId,
            db,
            broadcast,
          })
          abortController.signal.throwIfAborted()
          messages = compactResult.messages
          initialContextEstimate = compactResult.initialContextEstimate
        } else if (contextWindow) {
          initialContextEstimate = estimateTotalTokens(messages) + estimateToolDefinitionTokens(tools)
          messages = trimMessagesToContextLimit(messages, contextWindow, {
            tools,
            thinkingEnabled: reqThinkingEnabled !== undefined
              ? reqThinkingEnabled
              : (resolvedAgent?.thinkingEnabled !== false),
            reasoningEffort: reqReasoningEffort ?? resolvedAgent?.reasoningEffort,
            strategy: contextStrategy,
          })
        }

        if (reqDebugMode === true) {
          updateDebugContextCapture(conversationId, {
            providerId: responseProvider,
            model: responseModel,
            contextWindow,
            contextStrategy,
          })
        }

        const executor = new AgentExecutor({
          gateway,
          tools,
          conversationId,
          broadcast: executionBroadcast,
          providerId,
          model: responseModel,
          hitl: resolvedAgent ? !resolvedAgent.autoApproveTools : true,
          maxRounds: MAIN_AGENT_MAX_ROUNDS,
          thinkingEnabled: reqThinkingEnabled !== undefined ? reqThinkingEnabled : (resolvedAgent?.thinkingEnabled !== false),
          reasoningEffort: reqReasoningEffort ?? resolvedAgent?.reasoningEffort,
          streamMode: 'single',
          signal: abortController.signal,
          streamId,
          agentId: agentId || undefined,
          agentName: chatAgentName,
          agentIconUrl: chatAgentIconUrl,
          contextWindow,
          initialContextEstimate,
          contextStrategy,
          planningRunId,
          isPrimaryExecutor: true,
          usedToolNames,
          debugContextEnabled: reqDebugMode === true,
          takeSteeringMessages: () => takeSteeringMessages(conversationId, streamId),
          eventMeta: { executionId },
        })

        const unregisterSteering = registerChatSteeringHandler(conversationId, () => executor.requestSteering())
        let result
        try {
          result = await executor.run(messages)
        } finally {
          unregisterSteering()
        }
        abortController.signal.throwIfAborted()
        if (reqAutoToolRouting === true && executionConfig) {
          persistStickyUsedTools(db, conversationId, executionConfig, tools, usedToolNames, toolRegistry)
        }
        if (planningRunId) {
          closePlanningRun(planningRunId, 'completed', { summary: result.content.slice(0, 500) })
        }

        // Save final assistant message with metadata
        const assistantMsgId = nanoid()
        const assistantNow = Date.now()
        db.prepare(
          `INSERT INTO messages (id, conversation_id, role, content, thinking, image_urls_json, generated_media, memory_sources_json, agent_id, provider, model, prompt_tokens, completion_tokens, context_tokens, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          assistantMsgId,
          conversationId,
          'assistant',
          result.content,
          result.thinking || null,
          result.images.length ? JSON.stringify(result.images) : null,
          result.images.length ? 1 : 0,
          turnEvidence.length ? JSON.stringify(turnEvidence) : null,
          agentId,
          responseProvider,
          responseModel,
          result.usage?.promptTokens ?? null,
          result.usage?.completionTokens ?? null,
          result.contextTokens ?? null,
          result.usage ? assistantNow - now : null,
          assistantNow
        )
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(assistantNow, conversationId)

        executionBroadcast('chat:new-message', {
          conversationId, streamId,
          message: { id: assistantMsgId, conversationId, role: 'assistant', content: result.content, createdAt: assistantNow, agentId },
        })

        // Auto-generate conversation title on first exchange (fire-and-forget)
        const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title: string } | undefined
        if (conv && conv.title === 'New Chat') {
          if (generateTitlePref !== false) {
            generateTitle({
              conversationId,
              userMessage: normalizedContent,
              assistantResponse: result.content,
              broadcast,
              providerId: titleProviderIdPref || responseProvider,
              model: titleModelPref || (titleProviderIdPref ? undefined : responseModel)
            }).catch(() => { })
          } else {
            const fallback = buildFallbackTitle(normalizedContent)
            if (fallback) {
              db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(fallback, Date.now(), conversationId)
              broadcast('chat:title-updated', { conversationId, title: fallback })
            }
          }
        }

      } catch (err) {
        if ((err as Error).name === 'AbortError' || abortController.signal.aborted) {
          if (planningRunId) {
            interruptPlanningRun(planningRunId, { error: 'Interrupted before completion.' })
          }
          getEventBus().emit('task:error', { conversationId, executionId, error: 'Cancelled' })
          executionBroadcast('chat:stream-end', { streamId, conversationId, cancelled: true })
          return { streamId }
        }
        if (planningRunId) {
          closePlanningRun(planningRunId, 'error', { error: (err as Error).message })
        }
        if (reqAutoToolRouting === true && executionConfig) {
          persistStickyUsedTools(db, conversationId, executionConfig, tools, usedToolNames, toolRegistry)
        }
        getEventBus().emit('task:error', { conversationId, error: (err as Error).message })
        const errorMessage = attemptedVideoOutput
          ? `Video generation failed: ${(err as Error).message}`
          : (err as Error).message
        if (attemptedVideoOutput) {
          const assistantNow = Date.now()
          db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, agent_id, provider, model, latency_ms, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            nanoid(),
            conversationId,
            'assistant',
            errorMessage,
            agentId,
            responseProvider,
            responseModel,
            assistantNow - now,
            assistantNow
          )
          db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(assistantNow, conversationId)
        }
        broadcast('chat:stream-error', { streamId, conversationId, error: errorMessage })
        return { streamId }
      } finally {
        unregisterActiveChatExecution(executionId)
      }

      return { streamId, completed: true }
    }).catch((err: unknown) => {
      if ((err as Error).name === 'AbortError' || abortController.signal.aborted) {
        getEventBus().emit('task:error', { conversationId, executionId, error: 'Cancelled' })
        executionBroadcast('chat:stream-end', { streamId, conversationId, cancelled: true })
        return { streamId }
      }
      throw err
    }).finally(() => unregisterActiveChatExecution(executionId)) // end withConversationLock
    return 'completed' in outcome && outcome.completed === true
  }

  configureChatQueue(executeSend, broadcast)

  // POST /api/chat/conversations/:id/send — send message + stream response
  app.post<{
    Params: { id: string }
    Body: ChatSendRequest
  }>('/conversations/:id/send', async (req) => {
    const completed = await executeSend(req.params.id, req.body)
    if (completed) void runNextQueuedMessage(req.params.id)
    else pauseChatQueue(req.params.id)
    return { success: true }
  })

  app.get<{ Params: { id: string } }>('/conversations/:id/queue', async (req) => {
    return getChatQueueState(req.params.id)
  })

  app.post<{ Params: { id: string }; Body: ChatQueueRequest }>('/conversations/:id/queue', async (req, reply) => {
    const item = await enqueueChatMessage(req.params.id, req.body)
    return reply.status(201).send(item)
  })

  app.put<{ Params: { id: string; queueId: string }; Body: ChatQueueRequest }>(
    '/conversations/:id/queue/:queueId',
    async (req, reply) => {
      const item = await replaceQueuedChatMessage(req.params.id, req.params.queueId, req.body)
      return item || reply.status(404).send({ error: 'Queued message not found' })
    },
  )

  app.delete<{ Params: { id: string; queueId: string } }>(
    '/conversations/:id/queue/:queueId',
    async (req, reply) => deleteQueuedChatMessage(req.params.id, req.params.queueId)
      ? { success: true }
      : reply.status(404).send({ error: 'Queued message not found' }),
  )

  app.delete<{ Params: { id: string; queueId: string; attachmentId: string } }>(
    '/conversations/:id/queue/:queueId/attachments/:attachmentId',
    async (req, reply) => deleteQueuedChatAttachment(req.params.id, req.params.queueId, req.params.attachmentId)
      ? { success: true }
      : reply.status(404).send({ error: 'Queued attachment not found' }),
  )

  app.post<{ Params: { id: string; queueId: string } }>(
    '/conversations/:id/queue/:queueId/steer',
    async (req, reply) => promoteQueuedMessageToSteering(req.params.id, req.params.queueId)
      ? { success: true }
      : reply.status(404).send({ error: 'Queued message not found' }),
  )

  app.post<{ Params: { id: string } }>('/conversations/:id/queue/run-next', async (req) => {
    getDb().prepare(`UPDATE queued_chat_messages SET status = 'pending' WHERE conversation_id = ?`).run(req.params.id)
    void runNextQueuedMessage(req.params.id)
    return { success: true }
  })

  // POST /api/chat/cancel — cancel an active stream / execution
  app.post<{ Body: { streamId?: string; conversationId?: string } }>('/cancel', async (req) => {
    const { streamId, conversationId } = req.body
    const executionIds = new Set<string>()
    if (streamId) {
      if (cancelChatExecution(streamId)) {
        executionIds.add(streamId)
      } else {
        // Try cancelling a channel execution (Telegram/Discord/Slack)
        getChannelManager().cancelExecution(streamId)
      }
    }
    // Fallback: cancel by conversationId (handles post-reload or sub-agent-only streaming)
    if (conversationId) {
      pauseChatQueue(conversationId)
      for (const executionId of getChatExecutionIdsByConversation(conversationId)) executionIds.add(executionId)
      clearPendingHITLForConversation(conversationId)
      cancelChatExecutionByConversation(conversationId)
      getChannelManager().cancelExecutionByConversation(conversationId)
      cancelPostActions(conversationId)
    }
    return { success: true, executionIds: Array.from(executionIds) }
  })

  // ─── Active post-actions query ────────────────────────────

  app.get('/post-actions', async (req) => {
    const { conversationId } = req.query as { conversationId?: string }
    if (conversationId) {
      return { actions: getActiveActions(conversationId) }
    }
    return { actions: getAllActiveActions() }
  })

  // POST /api/chat/post-actions/cancel — cancel post-actions for a conversation
  app.post<{ Body: { conversationId: string } }>('/post-actions/cancel', async (req) => {
    const { conversationId } = req.body
    const cancelled = cancelPostActions(conversationId)
    return { success: cancelled }
  })
}
