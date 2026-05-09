import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getGateway } from '../core/gateway/gateway.js'
import { getToolRegistry } from '../core/tools/tool-registry.js'
import { getEventBus } from '../core/telemetry/event-bus.js'
import { AgentExecutor } from '../core/agent/agent-executor.js'
import { prepareAgentExecution } from '../core/agent/prepare-execution.js'
import { TOOL_SEARCH_TOOL_NAME } from '../core/tools/builtin/search-available-mcp-tools.js'
import { routeTools, shouldRouteTools } from '../core/agent/tool-router.js'
import { getAgent } from '../core/agents/agent-store.js'
import { generateTitle, getActiveActions, getAllActiveActions, cancelPostActions } from '../core/agent/post-execution.js'
import { hydrateBuiltInTools } from '../core/tools/built-in-tools.js'
import { trimMessagesToContextLimit, estimateTotalTokens, type ContextStrategy } from '../core/agent/context-trimmer.js'
import type { ChatMessage, ContentPart, ToolDefinition } from '../core/gateway/providers/base.provider.js'
import { isParseableDocument, parseDocument } from '../core/utils/document-parser.js'
import { nanoid } from 'nanoid'
import { getChannelManager } from '../core/channels/channel-manager.js'
import { extractFilePathFromFileUrl } from '../core/artifacts/image-artifacts.js'

type BroadcastFn = (event: string, data: unknown) => void

export interface ActiveChatExecution {
  id: string
  conversationId: string
  agentId: string | null
  model: string | null
  startedAt: number
}

const activeChatExecutions = new Map<string, ActiveChatExecution>()
const activeAbortControllers = new Map<string, AbortController>()

interface ChatHistoryRow {
  role: string
  content: string
  tool_calls_json: string | null
  tool_call_id: string | null
  agent_id: string | null
  image_urls_json: string | null
  created_at: number
}

/** Return all currently running chat executions. */
export function getActiveChatExecutions(): ActiveChatExecution[] {
  return Array.from(activeChatExecutions.values())
}

/** Cancel a chat execution by its streamId/executionId. */
export function cancelChatExecution(executionId: string): boolean {
  const controller = activeAbortControllers.get(executionId)
  if (controller) {
    controller.abort()
    activeAbortControllers.delete(executionId)
    return true
  }
  return false
}

/** Cancel the active chat execution for a given conversationId (fallback when streamId is unknown). */
export function cancelChatExecutionByConversation(conversationId: string): boolean {
  for (const [execId, exec] of activeChatExecutions) {
    if (exec.conversationId === conversationId) {
      return cancelChatExecution(execId)
    }
  }
  return false
}

/**
 * Per-conversation mutex: serializes /send requests so two concurrent sends
 * to the same conversationId don't read stale history and produce conflicts.
 */
const conversationLocks = new Map<string, Promise<unknown>>()

function withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const prev = conversationLocks.get(conversationId) ?? Promise.resolve()
  const next = prev.then(fn, fn) // run fn even if previous rejected
  conversationLocks.set(conversationId, next)
  // Clean up the entry once both prev and our fn are done to avoid unbounded growth
  next.finally(() => {
    if (conversationLocks.get(conversationId) === next) {
      conversationLocks.delete(conversationId)
    }
  })
  return next
}

function buildRecentImageArtifactsSystemHint(rows: ChatHistoryRow[], limit = 5): string | null {
  const artifacts: { path: string; url: string }[] = []
  const seen = new Set<string>()

  for (let i = rows.length - 1; i >= 0 && artifacts.length < limit; i--) {
    const row = rows[i]
    if (row.role !== 'assistant' || !row.image_urls_json) continue
    try {
      const urls = JSON.parse(row.image_urls_json) as string[]
      for (let j = urls.length - 1; j >= 0 && artifacts.length < limit; j--) {
        const url = urls[j]
        const path = extractFilePathFromFileUrl(url)
        if (!path || seen.has(path)) continue
        seen.add(path)
        artifacts.push({ path, url })
      }
    } catch {
      // Ignore malformed image metadata.
    }
  }

  if (!artifacts.length) return null

  const lines = artifacts.map((artifact, index) => (
    `${index === 0 ? 'latest generated image' : `generated image ${index + 1}`}: path=${artifact.path}; url=${artifact.url}`
  ))

  return [
    'Recent generated image artifacts are available for follow-up file/tool operations.',
    'Use these absolute paths when the user refers to "the image", "that image", "the last generated image", or asks to save/upload/edit a generated image.',
    ...lines,
  ].join('\n')
}

function appendHiddenSystemContext(messages: ChatMessage[], hint: string | null): ChatMessage[] {
  if (!hint) return messages
  let systemIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'system') {
      systemIndex = i
      break
    }
  }
  if (systemIndex === -1) {
    return [{ role: 'system', content: hint }, ...messages]
  }

  return messages.map((message, index) => {
    if (index !== systemIndex) return message
    const content = typeof message.content === 'string'
      ? message.content
      : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    return {
      ...message,
      content: `${content}\n\n${hint}`
    }
  })
}

export async function registerChatRoutes(app: FastifyInstance, broadcast: BroadcastFn): Promise<void> {
  const gateway = getGateway()

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
      subAgents?: { agentId: string; codename: string; role: string }[]
      memorySpaceIds?: string[]
      overrideSubAgents?: boolean
      thinkingEnabled?: boolean
      contextStrategy?: 'sliding-window' | 'truncate-middle' | 'none'
      autoToolRouting?: boolean
      toolRouterProviderId?: string
      toolRouterModel?: string
      titleProviderId?: string
      titleModel?: string
    }
  }>('/conversations/:id/send', async (req) => {
    const conversationId = req.params.id
    return withConversationLock(conversationId, async () => {
      const { content, messageId: providedMsgId, model, providerOverride, imageDataUrls, audioDataUrls, allowedTools, files, systemPrompt, generateTitle: generateTitlePref, subAgents: reqSubAgents, memorySpaceIds: reqMemorySpaceIds, overrideSubAgents, thinkingEnabled: reqThinkingEnabled, contextStrategy: reqContextStrategy, autoToolRouting: reqAutoToolRouting, toolRouterProviderId: reqToolRouterProviderId, toolRouterModel: reqToolRouterModel, titleProviderId: titleProviderIdPref, titleModel: titleModelPref } = req.body
      const db = getDb()
      const toolRegistry = getToolRegistry()
      const selectedToolKeys = Array.isArray(allowedTools)
        ? Array.from(new Set(allowedTools)).filter((name) => toolRegistry.hasKey(name))
        : []
      const stickyPreferredToolNames = reqAutoToolRouting === true
        ? toolRegistry.resolveForExecution(selectedToolKeys).map((tool) => tool.name)
        : []
      const hasExplicitToolAllowlist = Array.isArray(allowedTools)
        && reqAutoToolRouting !== true

      // Build content (text + optional images + optional audio + optional files)
      let userContent: string | ContentPart[]
      if (imageDataUrls?.length || audioDataUrls?.length || files?.length) {
        const parts: ContentPart[] = [{ type: 'text', text: content }]
        if (files?.length) {
          for (const file of files) {
            let fileText = file.content
            // Parse office documents (docx, pdf, xlsx, etc.) from base64 data URLs
            if (isParseableDocument(file.name) && file.content.startsWith('data:')) {
              try {
                const base64 = file.content.split(',')[1]
                if (base64) {
                  const buf = Buffer.from(base64, 'base64')
                  fileText = await parseDocument(buf, file.name)
                }
              } catch (err) {
                fileText = `[Error parsing ${file.name}: ${err instanceof Error ? err.message : 'unknown error'}]`
              }
            }
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
        `INSERT INTO messages (id, conversation_id, role, content, image_urls_json, audio_urls_json, file_attachments_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(userMsgId, conversationId, 'user', content, imageDataUrls?.length ? JSON.stringify(imageDataUrls) : null, audioDataUrls?.length ? JSON.stringify(audioDataUrls) : null, files?.length ? JSON.stringify(files.map(f => ({ name: f.name }))) : null, now)
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)

      // Build message history
      const historyRows = db
        .prepare(
          'SELECT role, content, tool_calls_json, tool_call_id, agent_id, image_urls_json, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
        )
        .all(conversationId) as ChatHistoryRow[]

      // Filter out sub-agent intermediate messages.
      // Keep: user messages, main-agent assistant messages + their tool results.
      // Drop: sub-agent assistant messages and their tool results.
      const convRow = db.prepare('SELECT agent_id FROM conversations WHERE id = ?').get(conversationId) as { agent_id: string | null } | undefined
      const mainAgentId: string | null = convRow?.agent_id || null
      const keptToolCallIds = new Set<string>()
      const filteredRows = historyRows.filter((row) => {
        if (row.role === 'user') return true
        if (row.role === 'assistant') {
          const isMainAgent = row.agent_id === null || row.agent_id === mainAgentId
          if (isMainAgent) {
            if (row.tool_calls_json) {
              try {
                for (const tc of JSON.parse(row.tool_calls_json)) {
                  if (tc.id) keptToolCallIds.add(tc.id)
                }
              } catch { /* ignore parse errors */ }
            }
            return true
          }
          return false
        }
        if (row.role === 'tool') {
          return !row.tool_call_id || keptToolCallIds.has(row.tool_call_id)
        }
        return true // system messages etc.
      })

      let messages: ChatMessage[] = filteredRows.map((row) => ({
        role: row.role as ChatMessage['role'],
        content: row.content,
        toolCalls: row.tool_calls_json ? JSON.parse(row.tool_calls_json) : undefined,
        toolCallId: row.tool_call_id || undefined
      }))

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

      // Create AbortController early so sub-agent tools can receive the signal
      const abortController = new AbortController()

      const isFirstUserMessage = historyRows.filter(r => r.role === 'user').length === 1
      let tools: import('../core/gateway/providers/base.provider.js').ToolDefinition[]
      let providerId: string | undefined
      let responseModel: string
      let responseProvider: string
      let chatAgentName: string | undefined
      let chatAgentIconUrl: string | null | undefined
      let hasSubAgents = false

      if (resolvedAgent) {
        // ── Agent-based chat: use shared builder ──

        // Session-level overrides: prefer request body over agent config
        const effectiveSubAgents = reqSubAgents ?? resolvedAgent.subAgents
        const effectiveAgent = hasExplicitToolAllowlist
          ? { ...resolvedAgent, tools: selectedToolKeys }
          : resolvedAgent

        // Resolve memory space overrides (request body ids → { id, name } objects)
        let memorySpaceOverrides: { id: string; name: string }[] | undefined
        if (reqMemorySpaceIds?.length) {
          const spaceRows = reqMemorySpaceIds.map(sid =>
            db.prepare('SELECT id, name FROM memory_spaces WHERE id = ?').get(sid) as { id: string; name: string } | undefined
          ).filter((r): r is { id: string; name: string } => Boolean(r))
          if (spaceRows.length) memorySpaceOverrides = spaceRows
        }

        const prepared = await prepareAgentExecution({
          agent: effectiveAgent,
          conversationId,
          broadcast,
          providerOverride: providerOverride || undefined,
          modelOverride: model || undefined,
          systemPromptOverride: systemPrompt || undefined,
          subAgentAssignments: effectiveSubAgents,
          signal: abortController.signal,
          userQuery: typeof messages[messages.length - 1]?.content === 'string'
            ? messages[messages.length - 1].content as string
            : content,
          recentMessages: messages,
          isFirstMessage: isFirstUserMessage,
          memorySpaceOverrides,
          overrideSubAgents: overrideSubAgents !== false,
          autoToolRouting: reqAutoToolRouting === true,
          toolRouterProviderId: reqToolRouterProviderId || undefined,
          toolRouterModel: reqToolRouterModel || undefined,
          preferredToolKeys: selectedToolKeys,
        })

        tools = prepared.tools
        providerId = prepared.providerId
        hasSubAgents = prepared.hasSubAgents
        chatAgentName = resolvedAgent.name
        chatAgentIconUrl = resolvedAgent.iconUrl || null
        messages = [...prepared.systemMessages, ...messages]

        const lastUsedProvider = providerId
          ? gateway.getProvider(providerId) || gateway.getLastUsedProvider()
          : gateway.getLastUsedProvider()
        responseProvider = lastUsedProvider.config.id
        responseModel = prepared.model
      } else {
        // ── Agentless chat: manual tool + provider resolution ──
        if (systemPrompt) {
          messages = [{ role: 'system', content: systemPrompt }, ...messages]
        }

        tools = hasExplicitToolAllowlist
          ? toolRegistry.resolveForExecution(selectedToolKeys)
          : toolRegistry.getToolDefinitions()

        // Resolve the effective provider + model up-front so sub-agent tools
        // receive the same provider that the main executor will use.
        // In free-chat mode the frontend calls providerStore.setActive() (a server
        // API) instead of setting sessionProviderOverride, so providerOverride in
        // the request body may be null — getLastUsedProvider() is the true source.
        providerId = providerOverride || undefined
        const freeChatLastUsedProvider = providerId
          ? gateway.getProvider(providerId) || gateway.getLastUsedProvider()
          : gateway.getLastUsedProvider()
        responseProvider = freeChatLastUsedProvider.config.id
        responseModel = model || freeChatLastUsedProvider.config.defaultModel

        if (shouldRouteTools(tools, content, { enabled: reqAutoToolRouting === true })) {
          const routingTaskId = `router_${nanoid()}`
          try {
            emitToolRoutingStatus(conversationId, routingTaskId, 'routing-tools', 'Selecting relevant tools...')
            const routerProviderId = reqToolRouterProviderId || responseProvider
            const routerProvider = gateway.getProvider(routerProviderId) || freeChatLastUsedProvider
            const routerModel = reqToolRouterModel || routerProvider.config.defaultModel || responseModel

            tools = await routeTools({
              userQuery: content,
              recentMessages: messages,
              allTools: tools,
              gateway,
              providerId: routerProvider.config.id,
              model: responseModel,
              routerModel,
              mcpMetadata: toolRegistry.getNamespaceMetadataForTools(tools),
              preferredToolNames: stickyPreferredToolNames.length ? new Set(stickyPreferredToolNames) : undefined,
            })
            emitToolRoutingSelection(conversationId, routingTaskId, tools)
          } catch (err) {
            console.warn('[tool-router] Routing failed, using local tool list:', err)
            tools = tools.filter((tool) => !tool.namespaceId?.startsWith('mcp:'))
            emitToolRoutingSelection(conversationId, routingTaskId, tools)
          }
        }

        // Sub-agent tools from request body (MA workspace)
        if (reqSubAgents?.length) {
          const { buildSubAgentTools, buildSubAgentPrompt } = await import('../core/agent/sub-agent-tools.js')
          messages = [{ role: 'system', content: buildSubAgentPrompt(reqSubAgents) }, ...messages]
          // Propagate the resolved provider (not the raw request param) so that
          // sub-agents use the same provider as the main free-chat executor when
          // overrideSubAgents is true — even if providerOverride was null because
          // the frontend set the active provider via setActive() rather than a
          // session override.
          const subAgentTools = buildSubAgentTools({
            subAgents: reqSubAgents,
            conversationId,
            broadcast,
            signal: abortController.signal,
            modelOverride: overrideSubAgents ? (model || undefined) : undefined,
            providerOverride: overrideSubAgents ? responseProvider : undefined,
          })
          tools = [...tools, ...subAgentTools]
          hasSubAgents = true
        }

        // Hydrate built-in tools (resolve memory space overrides for agentless)
        let memorySpaceOverrides: { id: string; name: string }[] | undefined
        if (reqMemorySpaceIds?.length) {
          const spaceRows = reqMemorySpaceIds.map(sid =>
            db.prepare('SELECT id, name FROM memory_spaces WHERE id = ?').get(sid) as { id: string; name: string } | undefined
          ).filter((r): r is { id: string; name: string } => Boolean(r))
          if (spaceRows.length) memorySpaceOverrides = spaceRows
        }
        tools = hydrateBuiltInTools(tools, { agentId: undefined, conversationId, broadcast, memorySpaceOverrides })
      }

      messages = appendHiddenSystemContext(messages, buildRecentImageArtifactsSystemHint(filteredRows))

      const streamId = nanoid()
      activeAbortControllers.set(streamId, abortController)

      // Persist the full session config with RESOLVED model/provider so it can
      // be restored correctly when navigating back to this conversation.
      const chatConfig: Record<string, unknown> = {
        allowedTools: Array.isArray(allowedTools) ? allowedTools : [],
        subAgents: reqSubAgents ?? [],
        memorySpaceIds: reqMemorySpaceIds ?? [],
        systemPrompt: systemPrompt || '',
        model: responseModel,
        providerId: responseProvider,
        overrideSubAgents: overrideSubAgents ?? false,
        thinkingEnabled: reqThinkingEnabled ?? true,
        autoToolRouting: reqAutoToolRouting === true,
      }
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

      // Trim message history if it exceeds the model's context window
      const contextStrategy = reqContextStrategy || 'sliding-window'
      let initialContextEstimate: number | undefined
      if (contextWindow) {
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
        maxRounds: hasSubAgents ? 30 : 15,
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
      })

      const executionId = streamId
      activeChatExecutions.set(executionId, {
        id: executionId,
        conversationId,
        agentId,
        model: responseModel,
        startedAt: Date.now()
      })

      try {
        const result = await executor.run(messages)

        // Save final assistant message with metadata
        const assistantMsgId = nanoid()
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
          result.usage ? Date.now() - now : null,
          Date.now()
        )

        // Auto-generate conversation title on first exchange (fire-and-forget)
        const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title: string } | undefined
        if (conv && conv.title === 'New Chat') {
          if (generateTitlePref !== false) {
            generateTitle({ conversationId, userMessage: content, assistantResponse: result.content, broadcast, providerId: titleProviderIdPref || providerId, model: titleModelPref || responseModel }).catch(() => { })
          } else {
            // Fallback: first few words of the user message
            const words = content.split(/\s+/).slice(0, 6).join(' ')
            const fallback = words.length > 60 ? words.slice(0, 60) + '…' : words
            if (fallback) {
              db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(fallback, Date.now(), conversationId)
              broadcast('chat:title-updated', { conversationId, title: fallback })
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          getEventBus().emit('task:error', { conversationId, error: 'Cancelled' })
          broadcast('chat:stream-end', { streamId, conversationId, cancelled: true })
          return { streamId }
        }
        getEventBus().emit('task:error', { conversationId, error: (err as Error).message })
        broadcast('chat:stream-error', { streamId, conversationId, error: (err as Error).message })
        return { streamId }
      } finally {
        activeAbortControllers.delete(streamId)
        activeChatExecutions.delete(executionId)
      }

      return { streamId }
    }) // end withConversationLock
  })

  // POST /api/chat/cancel — cancel an active stream / execution
  app.post<{ Body: { streamId?: string; conversationId?: string } }>('/cancel', async (req) => {
    const { streamId, conversationId } = req.body
    if (streamId) {
      const controller = activeAbortControllers.get(streamId)
      if (controller) {
        controller.abort()
        activeAbortControllers.delete(streamId)
      } else {
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

  app.get('/post-actions', async (req, reply) => {
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

function emitToolRoutingStatus(conversationId: string, taskId: string, status: string, message: string): void {
  getEventBus().emit('step:status', {
    conversationId,
    taskId,
    iteration: 0,
    status,
    message,
  })
}

function emitToolRoutingSelection(conversationId: string, taskId: string, tools: ToolDefinition[]): void {
  getEventBus().emit('step:tools-chosen', {
    conversationId,
    taskId,
    iteration: 0,
    toolCalls: tools
      .filter((tool) => tool.name !== TOOL_SEARCH_TOOL_NAME)
      .map((tool) => ({ name: tool.name, arguments: '{}' })),
  })
}
