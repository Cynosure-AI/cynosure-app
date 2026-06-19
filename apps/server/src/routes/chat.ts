import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getGateway } from '../core/gateway/gateway.js'
import { applyCompactStrategy } from '../core/agent/context-compactor.js'
import { getToolRegistry } from '../core/tools/tool-registry.js'
import { getEventBus } from '../core/telemetry/event-bus.js'
import { AgentExecutor, MAIN_AGENT_MAX_ROUNDS } from '../core/agent/agent-executor.js'
import { planExecution } from '../core/agent/pre-execution/execution-planner.js'
import { closePlanningRun } from '../core/agent/planning-state.js'
import { TOOL_SEARCH_TOOL_NAME } from '../core/tools/builtin/expand-available-toolset.js'
import { isBuiltInMemoryToolKey } from '../core/tools/built-in-tools.js'
import { getAgent } from '../core/agents/agent-store.js'
import { generateTitle, buildFallbackTitle, getActiveActions, getAllActiveActions, cancelPostActions } from '../core/agent/post-execution.js'
import { trimMessagesToContextLimit, estimateTotalTokens } from '../core/agent/context-trimmer.js'
import type { ChatMessage, ContentPart, RegistryAwareToolDefinition, VideoGenerationJob } from '../core/gateway/providers/base.provider.js'
import { nanoid } from 'nanoid'
import { getChannelManager } from '../core/channels/channel-manager.js'
import { materializeImageArtifacts } from '../core/artifacts/image-artifacts.js'
import { materializeFileAttachments, readFileAttachmentText } from '../core/artifacts/file-artifacts.js'
import { buildAttachmentContext, indexConversationAttachment, makeAttachmentTools, persistMessageFileAttachments } from '../core/artifacts/attachment-rag.js'
import {
  cancelChatExecution,
  cancelChatExecutionByConversation,
  registerActiveChatExecution,
  unregisterActiveChatExecution,
  updateActiveChatExecution,
} from '../core/chat/active-executions.js'
import { withConversationLock } from '../core/chat/conversation-locks.js'
import { getChatAttachmentConfig, normalizeInlineAttachmentTextLimit, saveChatAttachmentConfig } from '../core/chat/attachment-settings.js'
import { appendHiddenSystemContext, buildConversationHistory, buildRecentImageArtifactsSystemHint } from '../core/chat/message-history.js'
import { buildPersistedChatConfig, resolveChatRunFlags, resolveMemorySpaceOverrides, resolveToolSelection } from '../core/chat/run-config.js'
import type { ChatSendRequest, ConversationExecutionConfig } from '@shared/types'

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

function videoContentUrl(providerId: string, jobId: string, index = 0): string {
  return `/api/providers/${encodeURIComponent(providerId)}/videos/${encodeURIComponent(jobId)}/content?index=${encodeURIComponent(String(index))}`
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

  // POST /api/chat/conversations/:id/send — send message + stream response
  app.post<{
    Params: { id: string }
    Body: ChatSendRequest
  }>('/conversations/:id/send', async (req) => {
    const conversationId = req.params.id
    return withConversationLock(conversationId, async () => {
      const { content, messageId: providedMsgId, imageDataUrls, audioDataUrls, files } = req.body
      const run = req.body.run
      const {
        model,
        providerOverride,
        allowedTools,
        systemPrompt,
        generateTitle: generateTitlePref,
        subAgents: reqSubAgents,
        memorySpaceIds: reqMemorySpaceIds,
        thinkingEnabled: reqThinkingEnabled,
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
      let storedImageUrls = imageDataUrls
      if (imageDataUrls?.length) {
        try {
          const artifacts = await materializeImageArtifacts(imageDataUrls, conversationId)
          storedImageUrls = artifacts.map((artifact) => artifact.url)
        } catch (err) {
          console.warn('[chat] Failed to materialize user images, keeping original URLs:', err)
        }
      }

      const storedFileAttachments = files?.length
        ? await materializeFileAttachments(files, conversationId)
        : []
      for (const attachment of storedFileAttachments) {
        attachment.chunkCount = await indexConversationAttachment(conversationId, attachment)
      }

      // Build content (text + optional images + optional audio + optional files)
      let userContent: string | ContentPart[]
      if (imageDataUrls?.length || audioDataUrls?.length || files?.length) {
        const parts: ContentPart[] = [{ type: 'text', text: content }]
        if (storedFileAttachments.length) {
          for (const file of storedFileAttachments) {
            if (file.textBytes > inlineAttachmentTextLimit && file.chunkCount && file.chunkCount > 0) {
              parts.push({
                type: 'text',
                text: `[Attached file: ${file.name}]\nThis attachment is indexed for retrieval (${file.chunkCount} chunks, attachmentId: ${file.id}). Relevant excerpts will be provided as context; use attachment_search/attachment_retrieve_chunks for more detail.`
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
        if (imageDataUrls?.length) {
          for (const url of imageDataUrls) {
            parts.push({ type: 'image_url', image_url: { url } })
          }
        }
        if (audioDataUrls?.length) {
          for (const url of audioDataUrls) {
            parts.push({ type: 'audio_url', audio_url: { url } })
          }
        }
        userContent = parts
      } else {
        userContent = content
      }

      // Save user message (with images if present)
      // Use the client-provided messageId when valid (enables stable IDs for retry/edit).
      const idPattern = /^[A-Za-z0-9_-]{6,36}$/
      const userMsgId = (providedMsgId && idPattern.test(providedMsgId)) ? providedMsgId : nanoid()
      const now = Date.now()
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, image_urls_json, audio_urls_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(userMsgId, conversationId, 'user', content, storedImageUrls?.length ? JSON.stringify(storedImageUrls) : null, audioDataUrls?.length ? JSON.stringify(audioDataUrls) : null, now)
      persistMessageFileAttachments(db, userMsgId, conversationId, storedFileAttachments, now)
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)

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
      if (imageDataUrls?.length || audioDataUrls?.length || files?.length) {
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
      let memorySpaceOverrides = resolveMemorySpaceOverrides(db, reqMemorySpaceIds)
      if (effectiveRunFlags.autoMemory && Array.isArray(memorySpaceOverrides) && memorySpaceOverrides.length === 0) {
        memorySpaceOverrides = undefined
      }

      // Create AbortController early so sub-agent tools can receive the signal
      const abortController = new AbortController()
      const usedToolNames = new Set<string>()
      const streamId = nanoid()
      const executionId = streamId

      registerActiveChatExecution({
        id: executionId,
        conversationId,
        agentId,
        model: model || resolvedAgent?.model || null,
        startedAt: Date.now()
      }, abortController)

      let planned: Awaited<ReturnType<typeof planExecution>>
      try {
        planned = await planExecution({
          resolvedAgent,
          conversationId,
          broadcast,
          abortSignal: abortController.signal,
          gateway,
          toolRegistry,
          messages,
          userText: content,
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
          },
        })
      } catch (err) {
        unregisterActiveChatExecution(executionId)
        if ((err as Error).name === 'AbortError' || abortController.signal.aborted) {
          getEventBus().emit('task:error', { conversationId, error: 'Cancelled' })
          broadcast('chat:stream-end', { streamId, conversationId, cancelled: true })
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
      } = planned
      updateActiveChatExecution(executionId, { model: responseModel, planningRunId })
      if (abortController.signal.aborted) {
        unregisterActiveChatExecution(executionId)
        if (planningRunId) {
          closePlanningRun(planningRunId, 'cancelled', { error: 'Cancelled' })
        }
        getEventBus().emit('task:error', { conversationId, error: 'Cancelled' })
        broadcast('chat:stream-end', { streamId, conversationId, cancelled: true })
        return { streamId }
      }
      const tools: RegistryAwareToolDefinition[] = plannedTools
      let executionConfig: ConversationExecutionConfig | null = null
      try {
        messages = planned.messages

        const responseSupportsToolCalls = await gateway.modelSupportsToolCalls(responseModel, responseProvider)
        if (responseSupportsToolCalls) {
          tools.push(...makeAttachmentTools(conversationId))
        }
        messages = appendHiddenSystemContext(messages, await buildAttachmentContext(conversationId, content, db))
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
          thinkingEnabled: reqThinkingEnabled ?? true,
          autoToolRouting: reqAutoToolRouting === true,
          autoMemory: effectiveRunFlags.autoMemory,
        })
        db.prepare('UPDATE conversations SET execution_config_json = ? WHERE id = ?').run(
          JSON.stringify(executionConfig),
          conversationId
        )

        const resolvedModelInfo = await gateway.getModelInfo(responseModel, responseProvider).catch(() => null)
        const isVideoOutputModel = resolvedModelInfo?.outputModalities
          ?.some((modality) => modality.toLowerCase() === 'video') === true
        if (isVideoOutputModel) {
          broadcast('chat:stream-start', {
            streamId,
            conversationId,
            agentId: agentId || undefined,
            agentName: chatAgentName,
            agentIconUrl: chatAgentIconUrl,
          })
          broadcast('chat:stream-chunk', {
            streamId,
            conversationId,
            content: 'Generating video...',
          })

          const submittedJob = await gateway.generateVideo({
            model: responseModel,
            prompt: content,
            signal: abortController.signal,
          }, responseProvider)
          const completedJob = await pollVideoGeneration(gateway, responseProvider, submittedJob, abortController.signal)
          const videoUrls = [videoContentUrl(responseProvider, completedJob.id)]

          broadcast('chat:stream-videos', { streamId, conversationId, videos: videoUrls })
          broadcast('chat:stream-end', { streamId, conversationId, model: responseModel })

          const assistantMsgId = nanoid()
          const assistantNow = Date.now()
          const assistantContent = 'Generated video.'
          db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, video_urls_json, agent_id, provider, model, latency_ms, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            assistantMsgId,
            conversationId,
            'assistant',
            assistantContent,
            JSON.stringify(videoUrls),
            agentId,
            responseProvider,
            responseModel,
            assistantNow - now,
            assistantNow
          )
          db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(assistantNow, conversationId)

          const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title: string } | undefined
          if (conv && conv.title === 'New Chat') {
            if (generateTitlePref !== false) {
              generateTitle({
                conversationId,
                userMessage: content,
                assistantResponse: assistantContent,
                broadcast,
                providerId: titleProviderIdPref || responseProvider,
                model: titleModelPref || (titleProviderIdPref ? undefined : responseModel)
              }).catch(() => { })
            } else {
              const fallback = buildFallbackTitle(content)
              if (fallback) {
                db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(fallback, Date.now(), conversationId)
                broadcast('chat:title-updated', { conversationId, title: fallback })
              }
            }
          }
          return { streamId }
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
            gateway,
            providerId,
            responseModel,
            compactProviderId: reqCompactProviderId || undefined,
            compactModel: reqCompactModel || undefined,
            conversationId,
            db,
            broadcast,
          })
          messages = compactResult.messages
          initialContextEstimate = compactResult.initialContextEstimate
        } else if (contextWindow) {
          initialContextEstimate = estimateTotalTokens(messages)
          messages = trimMessagesToContextLimit(messages, contextWindow, undefined, contextStrategy)
        }

        const executor = new AgentExecutor({
          gateway,
          tools,
          conversationId,
          broadcast,
          providerId,
          model: responseModel,
          hitl: resolvedAgent ? !resolvedAgent.autoApproveTools : true,
          maxRounds: MAIN_AGENT_MAX_ROUNDS,
          thinkingEnabled: reqThinkingEnabled !== undefined ? reqThinkingEnabled : (resolvedAgent?.thinkingEnabled !== false),
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
        })

        const result = await executor.run(messages)
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
          `INSERT INTO messages (id, conversation_id, role, content, thinking, image_urls_json, memory_sources_json, agent_id, provider, model, prompt_tokens, completion_tokens, context_tokens, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          assistantMsgId,
          conversationId,
          'assistant',
          result.content,
          result.thinking || null,
          result.images.length ? JSON.stringify(result.images) : null,
          null,
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

        // Auto-generate conversation title on first exchange (fire-and-forget)
        const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title: string } | undefined
        if (conv && conv.title === 'New Chat') {
          if (generateTitlePref !== false) {
            generateTitle({
              conversationId,
              userMessage: content,
              assistantResponse: result.content,
              broadcast,
              providerId: titleProviderIdPref || responseProvider,
              model: titleModelPref || (titleProviderIdPref ? undefined : responseModel)
            }).catch(() => { })
          } else {
            const fallback = buildFallbackTitle(content)
            if (fallback) {
              db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(fallback, Date.now(), conversationId)
              broadcast('chat:title-updated', { conversationId, title: fallback })
            }
          }
        }

      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          if (reqAutoToolRouting === true && executionConfig) {
            persistStickyUsedTools(db, conversationId, executionConfig, tools, usedToolNames, toolRegistry)
          }
          if (planningRunId) {
            closePlanningRun(planningRunId, 'cancelled', { error: 'Cancelled' })
          }
          getEventBus().emit('task:error', { conversationId, error: 'Cancelled' })
          broadcast('chat:stream-end', { streamId, conversationId, cancelled: true })
          return { streamId }
        }
        if (planningRunId) {
          closePlanningRun(planningRunId, 'error', { error: (err as Error).message })
        }
        if (reqAutoToolRouting === true && executionConfig) {
          persistStickyUsedTools(db, conversationId, executionConfig, tools, usedToolNames, toolRegistry)
        }
        getEventBus().emit('task:error', { conversationId, error: (err as Error).message })
        broadcast('chat:stream-error', { streamId, conversationId, error: (err as Error).message })
        return { streamId }
      } finally {
        unregisterActiveChatExecution(executionId)
      }

      return { streamId }
    }) // end withConversationLock
  })

  // POST /api/chat/cancel — cancel an active stream / execution
  app.post<{ Body: { streamId?: string; conversationId?: string } }>('/cancel', async (req) => {
    const { streamId, conversationId } = req.body
    if (streamId) {
      if (!cancelChatExecution(streamId)) {
        // Try cancelling a channel execution (Telegram/Discord/Slack)
        getChannelManager().cancelExecution(streamId)
      }
    }
    // Fallback: cancel by conversationId (handles post-reload or sub-agent-only streaming)
    if (conversationId) {
      clearPendingHITLForConversation(conversationId)
      cancelChatExecutionByConversation(conversationId)
      cancelPostActions(conversationId)
    }
    return { success: true }
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
