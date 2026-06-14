import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getGateway } from '../core/gateway/gateway.js'
import { applyCompactStrategy } from '../core/agent/context-compactor.js'
import { getToolRegistry } from '../core/tools/tool-registry.js'
import { getEventBus } from '../core/telemetry/event-bus.js'
import { AgentExecutor, MAIN_AGENT_MAX_ROUNDS } from '../core/agent/agent-executor.js'
import { planExecution } from '../core/agent/pre-execution/execution-planner.js'
import { closeOrchestrationRun } from '../core/agent/orchestration-state.js'
import { TOOL_SEARCH_TOOL_NAME } from '../core/tools/builtin/expand-available-toolset.js'
import { isBuiltInMemoryToolKey } from '../core/tools/built-in-tools.js'
import { getAgent } from '../core/agents/agent-store.js'
import { generateTitle, buildFallbackTitle, getActiveActions, getAllActiveActions, cancelPostActions } from '../core/agent/post-execution.js'
import { trimMessagesToContextLimit, estimateTotalTokens, type ContextStrategy } from '../core/agent/context-trimmer.js'
import type { ChatMessage, ContentPart, RegistryAwareToolDefinition } from '../core/gateway/providers/base.provider.js'
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
} from '../core/chat/active-executions.js'
import { withConversationLock } from '../core/chat/conversation-locks.js'
import { getChatAttachmentConfig, normalizeInlineAttachmentTextLimit, saveChatAttachmentConfig } from '../core/chat/attachment-settings.js'
import { appendHiddenSystemContext, buildConversationHistory, buildRecentImageArtifactsSystemHint } from '../core/chat/message-history.js'
import { buildPersistedChatConfig, resolveChatRunFlags, resolveMemorySpaceOverrides, resolveToolSelection } from '../core/chat/run-config.js'

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

function persistAutoRoutedUsedTools(
  db: ReturnType<typeof getDb>,
  conversationId: string,
  chatConfig: Record<string, unknown>,
  tools: RegistryAwareToolDefinition[],
  usedToolNames: Set<string>,
  toolRegistry: ReturnType<typeof getToolRegistry>,
): void {
  const allowedTools = usedToolKeysFromNames(tools, usedToolNames, toolRegistry)
  db.prepare('UPDATE conversations SET config_json = ? WHERE id = ?').run(
    JSON.stringify({ ...chatConfig, allowedTools }),
    conversationId
  )
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
    Body: {
      content: string
      messageId?: string
      model?: string
      providerOverride?: string
      imageDataUrls?: string[]
      audioDataUrls?: string[]
      allowedTools?: string[]
      files?: { name: string; content: string }[]
      systemPrompt?: string
      generateTitle?: boolean
      subAgents?: { agentId: string }[]
      memorySpaceIds?: string[]
      thinkingEnabled?: boolean
      contextStrategy?: ContextStrategy
      autoToolRouting?: boolean
      selectedSkillIds?: string[]
      autoSkillRouting?: boolean
      autoMemory?: boolean
      autoRouterProviderId?: string
      autoRouterModel?: string
      compactProviderId?: string
      compactModel?: string
      titleProviderId?: string
      titleModel?: string
      inlineAttachmentTextLimit?: number
    }
  }>('/conversations/:id/send', async (req) => {
    const conversationId = req.params.id
    return withConversationLock(conversationId, async () => {
      const { content, messageId: providedMsgId, model, providerOverride, imageDataUrls, audioDataUrls, allowedTools, files, systemPrompt, generateTitle: generateTitlePref, subAgents: reqSubAgents, memorySpaceIds: reqMemorySpaceIds, thinkingEnabled: reqThinkingEnabled, contextStrategy: reqContextStrategy, autoToolRouting: reqAutoToolRouting, selectedSkillIds: reqSelectedSkillIds, autoSkillRouting: reqAutoSkillRouting, autoMemory: reqAutoMemory, autoRouterProviderId: reqAutoRouterProviderId, autoRouterModel: reqAutoRouterModel, compactProviderId: reqCompactProviderId, compactModel: reqCompactModel, titleProviderId: titleProviderIdPref, titleModel: titleModelPref, inlineAttachmentTextLimit: reqInlineAttachmentTextLimit } = req.body
      const legacyBody = req.body as Record<string, unknown>
      const legacyAutoRouterProviderId = typeof legacyBody['skillRouterProviderId'] === 'string' ? legacyBody['skillRouterProviderId'] : ''
      const legacyAutoRouterModel = typeof legacyBody['skillRouterModel'] === 'string' ? legacyBody['skillRouterModel'] : ''
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

      // Resolve agent for this conversation (used by both MA orchestration and normal chat)
      const convCheck = db.prepare('SELECT agent_id, ma_workspace_id FROM conversations WHERE id = ?').get(conversationId) as { agent_id: string | null; ma_workspace_id: string | null } | undefined
      const agentId: string | null = convCheck?.agent_id || null
      const resolvedAgent = agentId ? getAgent(agentId) : null
      const effectiveRunFlags = resolveChatRunFlags({
        resolvedAgent,
        autoMemory: reqAutoMemory,
        autoSkillRouting: reqAutoSkillRouting,
      })

      // Resolve memory space overrides (request body ids -> { id, name } objects)
      let memorySpaceOverrides = resolveMemorySpaceOverrides(db, reqMemorySpaceIds)
      if (effectiveRunFlags.autoMemory && Array.isArray(memorySpaceOverrides) && memorySpaceOverrides.length === 0) {
        memorySpaceOverrides = undefined
      }

      // Create AbortController early so sub-agent tools can receive the signal
      const abortController = new AbortController()
      const usedToolNames = new Set<string>()

      const planned = await planExecution({
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
          autoRouterProviderId: reqAutoRouterProviderId || legacyAutoRouterProviderId || undefined,
          autoRouterModel: reqAutoRouterModel || legacyAutoRouterModel || undefined,
          selectedToolKeys: Array.isArray(allowedTools) ? selectedToolKeys : undefined,
          hasExplicitToolAllowlist,
          usedToolNames,
          selectedSkillIds: Array.isArray(reqSelectedSkillIds) ? reqSelectedSkillIds : [],
          autoSkillRouting: effectiveRunFlags.autoSkillRouting,
          thinkingEnabled: reqThinkingEnabled !== undefined ? reqThinkingEnabled : (resolvedAgent?.thinkingEnabled !== false),
        },
      })

      const {
        tools: plannedTools,
        providerId,
        responseProvider,
        responseModel,
        orchestrationRunId,
        chatAgentName,
        chatAgentIconUrl,
      } = planned
      const tools: RegistryAwareToolDefinition[] = plannedTools
      messages = planned.messages

      const responseSupportsToolCalls = await gateway.modelSupportsToolCalls(responseModel, responseProvider)
      if (responseSupportsToolCalls) {
        tools.push(...makeAttachmentTools(conversationId))
      }
      messages = appendHiddenSystemContext(messages, await buildAttachmentContext(conversationId, content, db))
      messages = appendHiddenSystemContext(messages, buildRecentImageArtifactsSystemHint(filteredRows))

      const streamId = nanoid()

      // Persist the full session config with RESOLVED model/provider so it can
      // be restored correctly when navigating back to this conversation.
      const chatConfig = buildPersistedChatConfig({
        selectedToolKeys,
        routedToolKeys: [],
        requestedSubAgents: reqSubAgents,
        requestedMemorySpaceIds: reqMemorySpaceIds,
        systemPrompt,
        responseModel,
        responseProvider,
        thinkingEnabled: reqThinkingEnabled ?? true,
        autoToolRouting: reqAutoToolRouting === true,
        autoMemory: effectiveRunFlags.autoMemory,
        selectedSkillIds: Array.isArray(reqSelectedSkillIds) ? reqSelectedSkillIds : [],
        autoSkillRouting: effectiveRunFlags.autoSkillRouting,
      })
      db.prepare('UPDATE conversations SET config_json = ? WHERE id = ?').run(
        JSON.stringify(chatConfig),
        conversationId
      )

      // Fetch context window size (best-effort, non-blocking for the critical path)
      let contextWindow: number | undefined
      try {
        const modelInfo = await gateway.getModelInfo(responseModel, providerId)
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
        orchestrationRunId,
        isPrimaryExecutor: true,
        usedToolNames,
      })

      const executionId = streamId
      registerActiveChatExecution({
        id: executionId,
        conversationId,
        agentId,
        model: responseModel,
        orchestrationRunId,
        startedAt: Date.now()
      }, abortController)

      try {
        const result = await executor.run(messages)
        if (reqAutoToolRouting === true) {
          persistAutoRoutedUsedTools(db, conversationId, chatConfig, tools, usedToolNames, toolRegistry)
        }
        if (orchestrationRunId) {
          closeOrchestrationRun(orchestrationRunId, 'completed', { summary: result.content.slice(0, 500) })
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
          if (reqAutoToolRouting === true) {
            persistAutoRoutedUsedTools(db, conversationId, chatConfig, tools, usedToolNames, toolRegistry)
          }
          if (orchestrationRunId) {
            closeOrchestrationRun(orchestrationRunId, 'cancelled', { error: 'Cancelled' })
          }
          getEventBus().emit('task:error', { conversationId, error: 'Cancelled' })
          broadcast('chat:stream-end', { streamId, conversationId, cancelled: true })
          return { streamId }
        }
        if (orchestrationRunId) {
          closeOrchestrationRun(orchestrationRunId, 'error', { error: (err as Error).message })
        }
        if (reqAutoToolRouting === true) {
          persistAutoRoutedUsedTools(db, conversationId, chatConfig, tools, usedToolNames, toolRegistry)
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
