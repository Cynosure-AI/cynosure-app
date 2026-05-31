import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getGateway } from '../core/gateway/gateway.js'
import { COMPACT_EVENT_PREFIX, applyCompactStrategy } from '../core/agent/context-compactor.js'
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
import { isParseableDocument, parseDocument } from '../core/utils/document-parser.js'
import { nanoid } from 'nanoid'
import { getChannelManager } from '../core/channels/channel-manager.js'
import { extractFilePathFromFileUrl, materializeImageArtifacts } from '../core/artifacts/image-artifacts.js'

type BroadcastFn = (event: string, data: unknown) => void

export interface ActiveChatExecution {
  id: string
  conversationId: string
  agentId: string | null
  model: string | null
  orchestrationRunId?: string
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
    const execution = activeChatExecutions.get(executionId)
    if (execution?.orchestrationRunId) {
      closeOrchestrationRun(execution.orchestrationRunId, 'cancelled', { error: 'Cancelled' })
    }
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
      contextStrategy?: ContextStrategy
      autoToolRouting?: boolean
      toolRouterProviderId?: string
      toolRouterModel?: string
      autoMemory?: boolean
      memoryRouterProviderId?: string
      memoryRouterModel?: string
      compactProviderId?: string
      compactModel?: string
      titleProviderId?: string
      titleModel?: string
    }
  }>('/conversations/:id/send', async (req) => {
    const conversationId = req.params.id
    return withConversationLock(conversationId, async () => {
      const { content, messageId: providedMsgId, model, providerOverride, imageDataUrls, audioDataUrls, allowedTools, files, systemPrompt, generateTitle: generateTitlePref, subAgents: reqSubAgents, memorySpaceIds: reqMemorySpaceIds, overrideSubAgents, thinkingEnabled: reqThinkingEnabled, contextStrategy: reqContextStrategy, autoToolRouting: reqAutoToolRouting, toolRouterProviderId: reqToolRouterProviderId, toolRouterModel: reqToolRouterModel, autoMemory: reqAutoMemory, memoryRouterProviderId: reqMemoryRouterProviderId, memoryRouterModel: reqMemoryRouterModel, compactProviderId: reqCompactProviderId, compactModel: reqCompactModel, titleProviderId: titleProviderIdPref, titleModel: titleModelPref } = req.body
      const db = getDb()
      const toolRegistry = getToolRegistry()
      const selectedToolKeys = Array.isArray(allowedTools)
        ? Array.from(new Set(allowedTools)).filter((name) => toolRegistry.hasKey(name))
        : []
      const hasExplicitToolAllowlist = Array.isArray(allowedTools)
        && reqAutoToolRouting !== true

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
      ).run(userMsgId, conversationId, 'user', content, storedImageUrls?.length ? JSON.stringify(storedImageUrls) : null, audioDataUrls?.length ? JSON.stringify(audioDataUrls) : null, files?.length ? JSON.stringify(files.map(f => ({ name: f.name }))) : null, now)
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
      // Also drop compact event markers — they are UI-only and must never reach LLM context.
      const convRow = db.prepare('SELECT agent_id FROM conversations WHERE id = ?').get(conversationId) as { agent_id: string | null } | undefined
      const mainAgentId: string | null = convRow?.agent_id || null
      const keptToolCallIds = new Set<string>()
      const filteredRows = historyRows.filter((row) => {
        if (row.role === 'system' && row.content.startsWith(COMPACT_EVENT_PREFIX)) return false
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
      const effectiveOverrideSubAgents = overrideSubAgents !== undefined
        ? overrideSubAgents
        : (resolvedAgent?.overrideSubAgents === true)
      const effectiveAutoMemory = reqAutoMemory !== undefined
        ? reqAutoMemory === true
        : (resolvedAgent?.autoMemory === true)

      // Resolve memory space overrides (request body ids -> { id, name } objects)
      const memorySpaceOverrides = resolveMemorySpaceOverrides(db, reqMemorySpaceIds)

      // Create AbortController early so sub-agent tools can receive the signal
      const abortController = new AbortController()

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
          overrideSubAgents: effectiveOverrideSubAgents,
          autoToolRouting: typeof reqAutoToolRouting === 'boolean' ? reqAutoToolRouting : undefined,
          toolRouterProviderId: reqToolRouterProviderId || undefined,
          toolRouterModel: reqToolRouterModel || undefined,
          autoMemory: effectiveAutoMemory,
          memoryRouterProviderId: reqMemoryRouterProviderId || undefined,
          memoryRouterModel: reqMemoryRouterModel || undefined,
          selectedToolKeys: Array.isArray(allowedTools) ? selectedToolKeys : undefined,
          hasExplicitToolAllowlist,
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

      messages = appendHiddenSystemContext(messages, buildRecentImageArtifactsSystemHint(filteredRows))

      const streamId = nanoid()
      activeAbortControllers.set(streamId, abortController)

      const routedToolKeys = reqAutoToolRouting === true
        ? Array.from(
          new Set(
            tools
              .filter((tool) => tool.name !== TOOL_SEARCH_TOOL_NAME)
              .map((tool) => tool.registryKey)
              .filter((key): key is string => typeof key === 'string' && key.length > 0)
              .filter((key) => toolRegistry.hasKey(key))
              .filter((key) => !isBuiltInMemoryToolKey(key))
          )
        )
        : []

      const persistedAllowedTools = reqAutoToolRouting === true
        ? routedToolKeys
        : selectedToolKeys

      // Persist the full session config with RESOLVED model/provider so it can
      // be restored correctly when navigating back to this conversation.
      const chatConfig: Record<string, unknown> = {
        allowedTools: persistedAllowedTools,
        subAgents: reqSubAgents ?? [],
        memorySpaceIds: reqMemorySpaceIds ?? [],
        systemPrompt: systemPrompt || '',
        model: responseModel,
        providerId: responseProvider,
        overrideSubAgents: effectiveOverrideSubAgents,
        thinkingEnabled: reqThinkingEnabled ?? true,
        autoToolRouting: reqAutoToolRouting === true,
        autoMemory: effectiveAutoMemory,
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
      })

      const executionId = streamId
      activeChatExecutions.set(executionId, {
        id: executionId,
        conversationId,
        agentId,
        model: responseModel,
        orchestrationRunId,
        startedAt: Date.now()
      })

      try {
        const result = await executor.run(messages)
        if (orchestrationRunId) {
          closeOrchestrationRun(orchestrationRunId, 'completed', { summary: result.content.slice(0, 500) })
        }

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

function resolveMemorySpaceOverrides(
  db: ReturnType<typeof getDb>,
  requestedSpaceIds?: string[]
): { id: string; name: string }[] | undefined {
  if (!Array.isArray(requestedSpaceIds)) return undefined

  const uniqueSpaceIds = Array.from(new Set(requestedSpaceIds.map((sid) => sid.trim()).filter(Boolean)))
  const spaceRows = uniqueSpaceIds
    .map((sid) => db.prepare('SELECT id, name FROM memory_spaces WHERE id = ?').get(sid) as { id: string; name: string } | undefined)
    .filter((row): row is { id: string; name: string } => Boolean(row))

  // Keep explicit empty overrides so downstream tools can fall back to default memory space behavior.
  return spaceRows
}
