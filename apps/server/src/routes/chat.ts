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
import { generateTitle, buildFallbackTitle, generateQuickResponses, getQuickResponses, clearQuickResponses, getActiveActions, getAllActiveActions, cancelPostActions } from '../core/agent/post-execution.js'
import { trimMessagesToContextLimit, estimateTotalTokens, estimateToolDefinitionTokens } from '../core/agent/context-trimmer.js'
import type {
  ChatMessage,
  ContentPart,
  RegistryAwareToolDefinition,
} from '../core/gateway/providers/base.provider.js'
import { nanoid } from 'nanoid'
import { getChannelManager } from '../core/channels/channel-manager.js'
import { cancelCronRunsByConversation } from '../core/triggers/cron-scheduler.js'
import { artifactFileUrlToDataUrl, materializeAudioArtifacts, materializeImageArtifacts, toFileUrl } from '../core/artifacts/image-artifacts.js'
import { materializeFileAttachments, readFileAttachmentText } from '../core/artifacts/file-artifacts.js'
import { listStagedChatAttachments, releaseStagedChatAttachments, stageChatAttachment, takeStagedChatAttachments } from '../core/artifacts/staged-attachments.js'
import { ATTACHMENT_SYSTEM_CONTEXT, buildAttachmentContextBundle, indexConversationAttachment, listConversationFileAttachments, makeAttachmentTools, persistMessageFileAttachments, reuseConversationAttachment } from '../core/artifacts/attachment-rag.js'
import {
  cancelChatExecution,
  cancelChatExecutionByConversation,
  cancelPendingChatExecution,
  getChatExecutionIdsByConversation,
  registerActiveChatExecution,
  unregisterActiveChatExecution,
  updateActiveChatExecution,
} from '../core/chat/active-executions.js'
import { withConversationLock } from '../core/chat/conversation-locks.js'
import { getChatAttachmentConfig, normalizeInlineAttachmentTextLimit, saveChatAttachmentConfig } from '../core/chat/attachment-settings.js'
import { appendHiddenSystemContext, attachPreviousGeneratedImageToActiveUser, buildConversationHistory, buildRecentImageArtifactsSystemHint, insertTurnLocalUntrustedContext } from '../core/chat/message-history.js'
import { buildPersistedChatConfig, resolveChatRunFlags, resolveMemoryFolderOverrides, resolveToolSelection } from '../core/chat/run-config.js'
import { listChatEvents, messageContentJson, messageToTranscriptItem, publishChatEvent } from '../core/chat/transcript.js'
import { persistAssistantTurn } from '../core/chat/persist-assistant.js'
import { executeImageModel, executeTranscriptionModel, executeVideoModel } from '../core/chat/media-execution.js'
import type { ChatEventDraft, ChatEventPayload, ChatSendRequest, ConversationExecutionConfig } from '@shared/types'
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

export async function registerChatRoutes(app: FastifyInstance, broadcast: BroadcastFn): Promise<void> {
  const gateway = getGateway()

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>('/conversations/:id/events', async (req, reply) => {
    const db = getDb()
    if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(req.params.id)) {
      return reply.status(404).send({ error: 'Conversation not found' })
    }
    const after = Number(req.query.after ?? 0)
    const limit = Number(req.query.limit ?? 1000)
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
      return reply.status(400).send({ error: 'Invalid event cursor or limit' })
    }
    const latestSequence = (db.prepare('SELECT MAX(sequence) AS sequence FROM chat_events WHERE conversation_id = ?').get(req.params.id) as { sequence: number | null }).sequence ?? 0
    return { events: listChatEvents(db, req.params.id, after, limit), latestSequence }
  })

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

  async function executeSend(conversationId: string, request: QueuedExecutionRequest): Promise<boolean> {
    const initialConversation = getDb().prepare('SELECT agent_id FROM conversations WHERE id = ?')
      .get(conversationId) as { agent_id: string | null } | undefined
    const initialAgentId = initialConversation?.agent_id || null
    const initialAgent = initialAgentId ? getAgent(initialAgentId) : null
    const abortController = new AbortController()
    const streamId = request.messageId && /^[A-Za-z0-9_-]{6,36}$/.test(request.messageId)
      ? request.messageId : nanoid()
    const executionId = streamId
    const executionBroadcast: BroadcastFn = (event, data) => {
      const payload = data && typeof data === 'object'
        ? { ...(data as Record<string, unknown>), executionId }
        : data
      const type = event === 'chat:event' ? (data as ChatEventDraft).payload.type : null
      const terminalEvent = event.endsWith('-end') || event.endsWith('-error') || type === 'stream-end' || type === 'stream-error'
      if (abortController.signal.aborted && !terminalEvent) return
      broadcast(event, payload)
    }
    const emitChat = (payload: ChatEventPayload) => publishChatEvent(executionBroadcast, { conversationId, executionId, payload })

    // Registration precedes all async preflight work. A Stop that arrives before
    // this request is handled is applied here through the client execution ID.
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
        generateQuickResponses: generateQuickResponsesPref,
        subAgents: reqSubAgents,
        memoryFolderIds: reqMemoryFolderIds,
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
        mediaGeneration: reqMediaGeneration,
      } = run
      cancelPostActions(conversationId)
      clearQuickResponses(conversationId, broadcast)
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

      const stagedIds = files?.flatMap(file => file.stagedId ? [file.stagedId] : []) || []
      const preprocessedAttachments = request.stagedFileArtifacts || takeStagedChatAttachments(conversationId, stagedIds)
      const reusedAttachments = request.stagedFileArtifacts ? [] : (await Promise.all(
        (files || []).flatMap(file => file.existingAttachmentId ? [reuseConversationAttachment(conversationId, file.existingAttachmentId)] : []),
      )).filter((file): file is NonNullable<typeof file> => Boolean(file))
      const unstagedFiles = files?.filter(file => !file.stagedId && !file.existingAttachmentId && typeof file.content === 'string')
        .map(file => ({ name: file.name, content: file.content! })) || []
      const storedFileAttachments = request.stagedFileArtifacts
        ? request.stagedFileArtifacts
        : [...preprocessedAttachments, ...reusedAttachments, ...(unstagedFiles.length ? await materializeFileAttachments(unstagedFiles, conversationId) : [])]
      abortController.signal.throwIfAborted()
      if (!request.stagedFileArtifacts) {
        for (const attachment of storedFileAttachments.slice(preprocessedAttachments.length + reusedAttachments.length)) {
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
          `INSERT INTO messages (id, conversation_id, role, content, content_blocks_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(userMsgId, conversationId, 'user', normalizedContent, messageContentJson({
          id: userMsgId, content: normalizedContent, imageDataUrls: storedImageUrls, audioDataUrls: storedAudioUrls,
        }), now)
        persistMessageFileAttachments(db, userMsgId, conversationId, storedFileAttachments, now)
        releaseStagedChatAttachments(conversationId, stagedIds, false)
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)
        if (request.fromQueue) markQueuedMessagePromoted(conversationId, userMsgId)
      })()
      // Broadcast the persisted representation for both immediate and queued sends.
      // The sender merges this into its optimistic message, hydrating durable file
      // links, while other connected clients receive the new user message normally.
      emitChat({ type: 'transcript-item', item: messageToTranscriptItem({
          id: userMsgId,
          role: 'user',
          content: normalizedContent,
          imageDataUrls: storedImageUrls,
          audioDataUrls: storedAudioUrls,
          fileAttachments: storedFileAttachments.map(file => ({ id: file.id, name: file.name, href: toFileUrl(file.originalPath, file.name) })),
          createdAt: now,
        }, executionId) })

      // Start naming the conversation as soon as the first user message is
      // available. Title generation only uses that message, so it should not
      // wait for planning or the assistant response to finish.
      const conversationForTitle = db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title: string } | undefined
      if (conversationForTitle?.title === 'New Chat') {
        if (generateTitlePref !== false) {
          void generateTitle({
            conversationId,
            userMessage: normalizedContent,
            assistantResponse: '',
            broadcast,
            providerId: titleProviderIdPref || providerOverride || initialAgent?.providerId,
            model: titleModelPref || (titleProviderIdPref ? undefined : (model || initialAgent?.model)),
          })
        } else {
          const fallback = buildFallbackTitle(normalizedContent)
          if (fallback) {
            db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(fallback, Date.now(), conversationId)
            emitChat({ type: 'title-updated', title: fallback })
          }
        }
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

      // A follow-up to an image-producing assistant turn is an image edit by
      // default. Supply that generated image to the model as the base without
      // duplicating it as a visible/user-owned attachment in conversation data.
      messages = attachPreviousGeneratedImageToActiveUser(filteredRows, messages)

      // Resolve agent for this conversation (used by both MA planning and normal chat)
      const convCheck = db.prepare('SELECT agent_id, ma_workspace_id FROM conversations WHERE id = ?').get(conversationId) as { agent_id: string | null; ma_workspace_id: string | null } | undefined
      const agentId: string | null = convCheck?.agent_id || null
      const resolvedAgent = agentId ? getAgent(agentId) : null
      const effectiveRunFlags = resolveChatRunFlags({
        resolvedAgent,
        autoMemory: reqAutoMemory,
      })

      // Resolve memory folder overrides (request body ids -> { id, name } objects)
      const memoryFolderOverrides = resolveMemoryFolderOverrides(db, reqMemoryFolderIds)

      const usedToolNames = new Set<string>()

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
            memoryFolderOverrides,
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
          },
        })
      } catch (err) {
        unregisterActiveChatExecution(executionId)
        if ((err as Error).name === 'AbortError' || abortController.signal.aborted) {
          getEventBus().emit('task:error', { conversationId, executionId, error: 'Cancelled' })
          emitChat({ type: 'stream-end', streamId, scope: 'main', cancelled: true })
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
        emitChat({ type: 'stream-end', streamId, scope: 'main', cancelled: true })
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
          requestedMemoryFolderIds: reqMemoryFolderIds,
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
        const isImageOutputModel = resolvedModelInfo?.outputModalities
          ?.some((modality) => modality.toLowerCase() === 'image') === true
        const isDedicatedImageModel = (isImageOutputModel || !resolvedModelInfo?.outputModalities?.length)
          && gateway.getProvider(responseProvider)?.config.type === 'openrouter'
          && await gateway.listImageGenerationModels(responseProvider)
            .then((models) => models.some((item) => item.id === responseModel)).catch(() => false)
        const isTranscriptionOutputModel = resolvedModelInfo?.outputModalities
          ?.some((modality) => modality.toLowerCase() === 'transcription') === true
        if (isVideoOutputModel || isDedicatedImageModel || isTranscriptionOutputModel) {
          if (isTranscriptionOutputModel && !providerAudioDataUrls?.length) {
            throw new Error('Transcription models require an attached audio file.')
          }
          attemptedVideoOutput = isVideoOutputModel
          emitChat({ type: 'stream-start', streamId, scope: 'main', agentId: agentId || undefined,
            agentName: chatAgentName, agentIconUrl: chatAgentIconUrl })
          emitChat({ type: 'content-delta', streamId, scope: 'main', block: { type: 'text',
            text: isVideoOutputModel ? 'Generating video...' : isDedicatedImageModel ? 'Generating image...' : 'Transcribing audio...' } })

          const activeUserContent = [...messages].reverse().find((message) => message.role === 'user')?.content
          const activeUserImages = Array.isArray(activeUserContent)
            ? activeUserContent.flatMap((part) => part.type === 'image_url' ? [part.image_url.url] : [])
            : []
          const mediaImageDataUrls = activeUserImages.length ? activeUserImages : providerImageDataUrls

          const mediaInput = {
            gateway, conversationId, model: responseModel, providerId: responseProvider,
            prompt: normalizedContent, imageDataUrls: mediaImageDataUrls,
            audioDataUrls: providerAudioDataUrls, mediaSettings: reqMediaGeneration,
            signal: abortController.signal,
          }
          const media = isVideoOutputModel
            ? await executeVideoModel(mediaInput)
            : isDedicatedImageModel ? await executeImageModel(mediaInput) : await executeTranscriptionModel(mediaInput)
          abortController.signal.throwIfAborted()
          if (media.videos?.length) {
            emitChat({ type: 'media-added', streamId, scope: 'main', blocks: media.videos.map((url) => ({ type: 'video', artifactId: url, url })) })
          } else if (media.images?.length) {
            emitChat({ type: 'media-added', streamId, scope: 'main', blocks: media.images.map((url) => ({ type: 'image', artifactId: url, url })) })
          } else {
            emitChat({ type: 'content-delta', streamId, scope: 'main', block: { type: 'text', text: `\n\n${media.content}` } })
          }
          emitChat({ type: 'stream-end', streamId, scope: 'main', model: responseModel })
          abortController.signal.throwIfAborted()

          const assistant = persistAssistantTurn(db, executionBroadcast, {
            conversationId, streamId, content: media.content, videos: media.videos, images: media.images,
            generatedMedia: Boolean(media.videos?.length || media.images?.length), agentId,
            provider: responseProvider, model: responseModel, startedAt: now,
            promptTokens: media.promptTokens || null,
            completionTokens: media.completionTokens || null,
            contextTokens: media.contextTokens || null,
          })
          if (generateQuickResponsesPref === true) {
            void generateQuickResponses({
              conversationId, messageId: assistant.id, userMessage: normalizedContent,
              assistantResponse: media.content, broadcast, providerId: responseProvider,
            })
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
            signal: abortController.signal,
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

        const assistant = persistAssistantTurn(db, executionBroadcast, {
          conversationId, streamId, content: result.content, thinking: result.thinking,
          images: result.images, generatedMedia: result.images.length > 0,
          contextEvidence: turnEvidence, agentId, provider: responseProvider, model: responseModel,
          promptTokens: result.usage?.promptTokens, completionTokens: result.usage?.completionTokens,
          contextTokens: result.contextTokens, startedAt: result.usage ? now : undefined,
        })

        if (generateQuickResponsesPref === true) {
          void generateQuickResponses({
            conversationId,
            messageId: assistant.id,
            userMessage: normalizedContent,
            assistantResponse: result.content,
            broadcast,
            providerId: responseProvider,
            model: responseModel,
          })
        }

      } catch (err) {
        if ((err as Error).name === 'AbortError' || abortController.signal.aborted) {
          if (planningRunId) {
            interruptPlanningRun(planningRunId, { error: 'Interrupted before completion.' })
          }
          getEventBus().emit('task:error', { conversationId, executionId, error: 'Cancelled' })
          emitChat({ type: 'stream-end', streamId, scope: 'main', cancelled: true })
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
        persistAssistantTurn(db, executionBroadcast, {
          conversationId, streamId, content: errorMessage, isError: true, agentId,
          provider: responseProvider, model: responseModel, startedAt: now,
        })
        emitChat({ type: 'stream-error', streamId, scope: 'main', error: errorMessage })
        return { streamId }
      } finally {
        unregisterActiveChatExecution(executionId)
      }

      return { streamId, completed: true }
    }).catch((err: unknown) => {
      if ((err as Error).name === 'AbortError' || abortController.signal.aborted) {
        getEventBus().emit('task:error', { conversationId, executionId, error: 'Cancelled' })
        emitChat({ type: 'stream-end', streamId, scope: 'main', cancelled: true })
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

  app.post<{ Params: { id: string }; Body: { name: string; content: string; clientId?: string } }>(
    '/conversations/:id/attachments/stage',
    async (req, reply) => {
      const staged = await stageChatAttachment(req.params.id, req.body, {
        onUpdate: (update) => broadcast('attachment:stage-progress', update),
      })
      return reply.status(202).send({
        id: staged.id,
        conversationId: staged.conversationId,
        clientId: staged.clientId,
        name: staged.name,
        status: staged.status,
        progressCurrent: staged.progressCurrent,
        progressTotal: staged.progressTotal,
        chunkCount: staged.chunkCount,
      })
    },
  )

  app.get<{ Params: { id: string } }>('/conversations/:id/attachments/stage', async (req) => {
    return listStagedChatAttachments(req.params.id).map((staged) => ({
      id: staged.id,
      conversationId: staged.conversationId,
      clientId: staged.clientId,
      name: staged.name,
      status: staged.status,
      progressCurrent: staged.progressCurrent,
      progressTotal: staged.progressTotal,
      chunkCount: staged.chunkCount,
      error: staged.error,
    }))
  })

  app.delete<{ Params: { id: string; attachmentId: string } }>(
    '/conversations/:id/attachments/stage/:attachmentId',
    async (req) => {
      releaseStagedChatAttachments(req.params.id, [req.params.attachmentId])
      return { success: true }
    },
  )

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
        if (conversationId) {
          cancelPendingChatExecution(streamId, conversationId)
          executionIds.add(streamId)
        }
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
      cancelCronRunsByConversation(conversationId)
      getChannelManager().cancelExecutionByConversation(conversationId)
      cancelPostActions(conversationId)
    }
    return { success: true, executionIds: Array.from(executionIds) }
  })

  // ─── Active post-actions query ────────────────────────────

  app.get('/post-actions', async (req) => {
    const { conversationId } = req.query as { conversationId?: string }
    if (conversationId) {
      return { actions: getActiveActions(conversationId), quickResponses: getQuickResponses(conversationId) }
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
