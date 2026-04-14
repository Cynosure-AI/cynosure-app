import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getGateway } from '../core/gateway/gateway.js'
import { getToolRegistry } from '../core/tools/tool-registry.js'
import { getEventBus } from '../core/telemetry/event-bus.js'
import { AgentExecutor } from '../core/agent/agent-executor.js'
import { prepareAgentExecution } from '../core/agent/prepare-execution.js'
import { getAgent } from '../core/agents/agent-files.js'
import { generateTitle, getActiveActions, getAllActiveActions, cancelPostActions } from '../core/agent/post-execution.js'
import { hydrateBuiltInTools } from '../core/tools/built-in-tools.js'
import type { ChatMessage, ContentPart } from '../core/gateway/providers/base.provider.js'
import { isParseableDocument, parseDocument } from '../core/utils/document-parser.js'
import { nanoid } from 'nanoid'
import { unlinkSync } from 'fs'

type BroadcastFn = (event: string, data: unknown) => void

/** Delete image files referenced by messages in the given conversation IDs. */
function cleanupConversationImages(conversationIds: string[]): void {
  const db = getDb()
  for (const convId of conversationIds) {
    const rows = db.prepare(
      'SELECT image_urls_json FROM messages WHERE conversation_id = ? AND image_urls_json IS NOT NULL'
    ).all(convId) as { image_urls_json: string }[]

    for (const row of rows) {
      try {
        const urls: string[] = JSON.parse(row.image_urls_json)
        for (const url of urls) {
          // Extract file path from /api/files?path=<encoded_path>
          const match = url.match(/\/api\/files\?path=([^&]+)/)
          if (match) {
            try { unlinkSync(decodeURIComponent(match[1])) } catch { /* file may already be gone */ }
          }
        }
      } catch { /* skip malformed JSON */ }
    }
  }
}

export interface ActiveChatExecution {
  id: string
  conversationId: string
  agentId: string | null
  startedAt: number
}

const activeChatExecutions = new Map<string, ActiveChatExecution>()
const activeAbortControllers = new Map<string, AbortController>()

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

export async function registerChatRoutes(app: FastifyInstance, broadcast: BroadcastFn): Promise<void> {
  const gateway = getGateway()

  // POST /api/chat/conversations — create
  app.post<{ Body: { title?: string; agentId?: string; maWorkspaceId?: string; origin?: string } }>('/conversations', async (req) => {
    const { title, agentId, maWorkspaceId, origin } = req.body
    const db = getDb()
    const id = nanoid()
    const now = Date.now()
    db.prepare(
      'INSERT INTO conversations (id, title, agent_id, ma_workspace_id, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, title || 'New Chat', agentId || null, maWorkspaceId || null, origin || 'chat', now, now)
    return { id, title: title || 'New Chat', agentId: agentId || null, maWorkspaceId: maWorkspaceId || null, origin: origin || 'chat', createdAt: now, updatedAt: now }
  })

  // GET /api/chat/conversations — list (optionally filtered by agent_id or ma_workspace_id)
  app.get<{ Querystring: { agentId?: string; maWorkspaceId?: string } }>('/conversations', async (req) => {
    const db = getDb()
    const { agentId, maWorkspaceId } = req.query
    const excerpt = `(SELECT SUBSTR(m.content, 1, 120) FROM messages m WHERE m.conversation_id = conversations.id AND m.role = 'user' ORDER BY m.created_at DESC LIMIT 1) AS last_user_message`
    const orderBy = 'ORDER BY pinned DESC, updated_at DESC'
    if (maWorkspaceId) {
      return db.prepare(`SELECT *, ${excerpt} FROM conversations WHERE ma_workspace_id = ? ${orderBy}`).all(maWorkspaceId)
    }
    if (agentId) {
      return db.prepare(`SELECT *, ${excerpt} FROM conversations WHERE agent_id = ? ${orderBy}`).all(agentId)
    }
    if (agentId === '') {
      // Explicitly empty string → conversations with no agent and no MA workspace
      return db.prepare(`SELECT *, ${excerpt} FROM conversations WHERE agent_id IS NULL AND ma_workspace_id IS NULL ${orderBy}`).all()
    }
    return db.prepare(`SELECT *, ${excerpt} FROM conversations ${orderBy}`).all()
  })

  // GET /api/chat/conversations/:id/messages — get messages
  app.get<{ Params: { id: string } }>('/conversations/:id/messages', async (req) => {
    const db = getDb()
    const rows = db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(req.params.id) as {
        id: string
        conversation_id: string
        role: string
        content: string
        thinking: string | null
        tool_calls_json: string | null
        tool_call_id: string | null
        image_urls_json: string | null
        audio_urls_json: string | null
        file_attachments_json: string | null
        memory_sources_json: string | null
        agent_id: string | null
        provider: string | null
        model: string | null
        prompt_tokens: number | null
        completion_tokens: number | null
        latency_ms: number | null
        created_at: number
      }[]

    return rows.map((row) => {
      let agentName: string | undefined
      let agentIconUrl: string | null | undefined
      if (row.agent_id) {
        try {
          const agent = getAgent(row.agent_id)
          if (agent) {
            agentName = agent.name
            agentIconUrl = agent.iconUrl || null
          }
        } catch { /* agent not found — ignore */ }
      }
      let toolCalls: unknown | undefined
      try {
        toolCalls = row.tool_calls_json ? JSON.parse(row.tool_calls_json) : undefined
      } catch { /* malformed JSON — ignore */ }
      let imageDataUrls: string[] | undefined
      try {
        imageDataUrls = row.image_urls_json ? JSON.parse(row.image_urls_json) : undefined
      } catch { /* malformed JSON — ignore */ }
      let audioDataUrls: string[] | undefined
      try {
        audioDataUrls = row.audio_urls_json ? JSON.parse(row.audio_urls_json) : undefined
      } catch { /* malformed JSON — ignore */ }
      let memorySources: unknown | undefined
      try {
        memorySources = row.memory_sources_json ? JSON.parse(row.memory_sources_json) : undefined
      } catch { /* malformed JSON — ignore */ }
      let fileAttachments: { name: string }[] | undefined
      try {
        fileAttachments = row.file_attachments_json ? JSON.parse(row.file_attachments_json) : undefined
      } catch { /* malformed JSON — ignore */ }
      return {
        id: row.id,
        conversationId: row.conversation_id,
        role: row.role,
        content: row.content,
        thinking: row.thinking || undefined,
        toolCalls,
        toolCallId: row.tool_call_id || undefined,
        imageDataUrls,
        audioDataUrls,
        fileAttachments,
        memorySources,
        agentId: row.agent_id || undefined,
        agentName,
        agentIconUrl,
        provider: row.provider,
        model: row.model,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        latencyMs: row.latency_ms,
        createdAt: row.created_at
      }
    })
  })

  // GET /api/chat/conversations/:id/steps — get execution steps
  app.get<{ Params: { id: string } }>('/conversations/:id/steps', async (req) => {
    const db = getDb()
    const rows = db
      .prepare('SELECT * FROM execution_steps WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(req.params.id) as {
        id: string
        conversation_id: string
        task_id: string | null
        iteration: number
        status: string
        message: string | null
        plan: string | null
        tool_calls_json: string | null
        results_json: string | null
        evaluation_json: string | null
        ma_codename: string | null
        ma_agent_name: string | null
        ma_phase: string | null
        created_at: number
      }[]

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      taskId: row.task_id,
      iteration: row.iteration,
      status: row.status,
      message: row.message,
      plan: row.plan,
      toolCalls: row.tool_calls_json ? JSON.parse(row.tool_calls_json) : undefined,
      results: row.results_json ? JSON.parse(row.results_json) : undefined,
      evaluation: row.evaluation_json ? JSON.parse(row.evaluation_json) : undefined,
      maCodename: row.ma_codename,
      maAgentName: row.ma_agent_name,
      maPhase: row.ma_phase,
      createdAt: row.created_at,
    }))
  })

  // GET /api/chat/conversations/:id/hitl — return the pending HITL request for this conversation, if any
  app.get<{ Params: { id: string } }>('/conversations/:id/hitl', async (req) => {
    const db = getDb()
    const row = db
      .prepare('SELECT task_id, tool_calls_json FROM pending_hitl WHERE conversation_id = ?')
      .get(req.params.id) as { task_id: string; tool_calls_json: string } | undefined
    if (!row) return null
    return {
      taskId: row.task_id,
      toolCalls: JSON.parse(row.tool_calls_json) as { name: string; arguments: string }[]
    }
  })

  // PATCH /api/chat/conversations/:id/pin — toggle pinned state
  app.patch<{ Params: { id: string }; Body: { pinned: boolean } }>(
    '/conversations/:id/pin',
    async (req) => {
      const { pinned } = req.body
      const db = getDb()
      db.prepare('UPDATE conversations SET pinned = ?, updated_at = ? WHERE id = ?').run(
        pinned ? 1 : 0,
        Date.now(),
        req.params.id
      )
      return { success: true }
    }
  )

  // DELETE /api/chat/conversations/:id — delete (blocked for pinned conversations)
  app.delete<{ Params: { id: string } }>('/conversations/:id', async (req, reply) => {
    const db = getDb()
    const row = db.prepare('SELECT pinned FROM conversations WHERE id = ?').get(req.params.id) as { pinned: number } | undefined
    if (row?.pinned) {
      return reply.status(400).send({ error: 'Cannot delete a pinned conversation. Unpin it first.' })
    }
    cleanupConversationImages([req.params.id])
    db.prepare('DELETE FROM execution_steps WHERE conversation_id = ?').run(req.params.id)
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(req.params.id)
    db.prepare('DELETE FROM conversations WHERE id = ?').run(req.params.id)
    return { success: true }
  })

  // DELETE /api/chat/conversations — delete all conversations (optionally filtered by agent), skips pinned
  app.delete<{ Querystring: { agentId?: string } }>('/conversations', async (req) => {
    const db = getDb()
    const { agentId } = req.query
    if (agentId !== undefined) {
      const filter = agentId === '' ? 'agent_id IS NULL AND ma_workspace_id IS NULL' : 'agent_id = ?'
      const ids = db.prepare(`SELECT id FROM conversations WHERE ${filter} AND pinned = 0`).all(...(agentId === '' ? [] : [agentId])) as { id: string }[]
      cleanupConversationImages(ids.map(r => r.id))
      for (const { id } of ids) {
        db.prepare('DELETE FROM execution_steps WHERE conversation_id = ?').run(id)
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
      }
      db.prepare(`DELETE FROM conversations WHERE ${filter} AND pinned = 0`).run(...(agentId === '' ? [] : [agentId]))
    } else {
      const allIds = db.prepare('SELECT id FROM conversations WHERE pinned = 0').all() as { id: string }[]
      cleanupConversationImages(allIds.map(r => r.id))
      for (const { id } of allIds) {
        db.prepare('DELETE FROM execution_steps WHERE conversation_id = ?').run(id)
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
      }
      db.prepare('DELETE FROM conversations WHERE pinned = 0').run()
    }
    return { success: true }
  })

  // PATCH /api/chat/conversations/:id/title — update title
  app.patch<{ Params: { id: string }; Body: { title: string } }>(
    '/conversations/:id/title',
    async (req) => {
      const { title } = req.body
      const db = getDb()
      db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(
        title,
        Date.now(),
        req.params.id
      )
      return { success: true }
    }
  )

  // POST /api/chat/conversations/:id/truncate — delete a message and everything after it
  // Used by the frontend retry/edit buttons to rewind conversation history.
  app.post<{ Params: { id: string }; Body: { messageId: string } }>(
    '/conversations/:id/truncate',
    async (req, reply) => {
      const { id: conversationId } = req.params
      const { messageId } = req.body
      if (!messageId) return reply.status(400).send({ error: 'messageId is required' })
      const db = getDb()
      const row = db
        .prepare('SELECT created_at FROM messages WHERE id = ? AND conversation_id = ?')
        .get(messageId, conversationId) as { created_at: number } | undefined
      if (!row) return reply.status(404).send({ error: 'Message not found' })

      // Cleanup image files for messages being truncated
      const imageRows = db.prepare(
        'SELECT image_urls_json FROM messages WHERE conversation_id = ? AND created_at >= ? AND image_urls_json IS NOT NULL'
      ).all(conversationId, row.created_at) as { image_urls_json: string }[]
      for (const ir of imageRows) {
        try {
          const urls: string[] = JSON.parse(ir.image_urls_json)
          for (const url of urls) {
            const match = url.match(/\/api\/files\?path=([^&]+)/)
            if (match) {
              try { unlinkSync(decodeURIComponent(match[1])) } catch { /* already gone */ }
            }
          }
        } catch { /* skip */ }
      }

      const result = db
        .prepare('DELETE FROM messages WHERE conversation_id = ? AND created_at >= ?')
        .run(conversationId, row.created_at)
      db.prepare('DELETE FROM execution_steps WHERE conversation_id = ? AND created_at >= ?')
        .run(conversationId, row.created_at)
      return { success: true, deleted: result.changes }
    }
  )

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
    }
  }>('/conversations/:id/send', async (req) => {
    const conversationId = req.params.id
    return withConversationLock(conversationId, async () => {
      const { content, messageId: providedMsgId, model, providerOverride, imageDataUrls, audioDataUrls, allowedTools, files, systemPrompt, generateTitle: generateTitlePref, subAgents: reqSubAgents, memorySpaceIds: reqMemorySpaceIds, overrideSubAgents } = req.body
      const db = getDb()

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
          'SELECT role, content, tool_calls_json, tool_call_id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
        )
        .all(conversationId) as {
          role: string
          content: string
          tool_calls_json: string | null
          tool_call_id: string | null
        }[]

      let messages: ChatMessage[] = historyRows.map((row) => ({
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
      let retrievedMemorySources: { text: string; source: string; score: number }[] | null = null

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
        const effectiveAgent = Array.isArray(allowedTools)
          ? { ...resolvedAgent, tools: allowedTools }
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
          isFirstMessage: isFirstUserMessage,
          memorySpaceOverrides,
          overrideSubAgents: overrideSubAgents !== false,
        })

        tools = prepared.tools
        providerId = prepared.providerId
        hasSubAgents = prepared.hasSubAgents
        retrievedMemorySources = prepared.retrievedMemorySources
        chatAgentName = resolvedAgent.name
        chatAgentIconUrl = resolvedAgent.iconUrl || null
        messages = [...prepared.systemMessages, ...messages]

        const activeProvider = providerId
          ? gateway.getProvider(providerId) || gateway.getActiveProvider()
          : gateway.getActiveProvider()
        responseProvider = activeProvider.config.id
        responseModel = prepared.model
      } else {
        // ── Agentless chat: manual tool + provider resolution ──
        if (systemPrompt) {
          messages = [{ role: 'system', content: systemPrompt }, ...messages]
        }

        const toolRegistry = getToolRegistry()
        const hasToolAllowlist = Array.isArray(allowedTools)
        const selectedToolNames = hasToolAllowlist
          ? Array.from(new Set(allowedTools)).filter((name) => toolRegistry.has(name))
          : undefined
        tools = hasToolAllowlist
          ? toolRegistry.resolveForExecution(selectedToolNames || [])
          : toolRegistry.getToolDefinitions()

        // Resolve the effective provider + model up-front so sub-agent tools
        // receive the same provider that the main executor will use.
        // In free-chat mode the frontend calls providerStore.setActive() (a server
        // API) instead of setting sessionProviderOverride, so providerOverride in
        // the request body may be null — getActiveProvider() is the true source.
        providerId = providerOverride || undefined
        const freeChatActiveProvider = providerId
          ? gateway.getProvider(providerId) || gateway.getActiveProvider()
          : gateway.getActiveProvider()
        responseProvider = freeChatActiveProvider.config.id
        const rawModel = model || freeChatActiveProvider.config.defaultModel
        responseModel = (!rawModel || rawModel === 'default') ? freeChatActiveProvider.config.defaultModel : rawModel

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

      const streamId = nanoid()
      activeAbortControllers.set(streamId, abortController)

      // Fetch context window size (best-effort, non-blocking for the critical path)
      let contextWindow: number | undefined
      try {
        const modelInfo = await gateway.getModelInfo(responseModel, providerId)
        contextWindow = modelInfo.contextLength
      } catch { /* ignore — context window info is optional */ }

      const executor = new AgentExecutor({
        gateway,
        tools,
        conversationId,
        broadcast,
        providerId,
        model: responseModel,
        hitl: resolvedAgent ? !resolvedAgent.autoApproveTools : true,
        maxRounds: hasSubAgents ? 30 : 15,
        maxToolOutputChars: resolvedAgent?.maxToolOutputChars,
        streamMode: 'single',
        signal: abortController.signal,
        streamId,
        agentId: agentId || undefined,
        agentName: chatAgentName,
        agentIconUrl: chatAgentIconUrl,
        contextWindow,
      })

      const executionId = streamId
      activeChatExecutions.set(executionId, {
        id: executionId,
        conversationId,
        agentId,
        startedAt: Date.now()
      })

      try {
        const result = await executor.run(messages)

        // Save final assistant message with metadata
        const assistantMsgId = nanoid()
        db.prepare(
          `INSERT INTO messages (id, conversation_id, role, content, thinking, image_urls_json, memory_sources_json, agent_id, provider, model, prompt_tokens, completion_tokens, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          assistantMsgId,
          conversationId,
          'assistant',
          result.content,
          result.thinking || null,
          result.images.length ? JSON.stringify(result.images) : null,
          retrievedMemorySources ? JSON.stringify(retrievedMemorySources) : null,
          agentId,
          responseProvider,
          responseModel,
          result.usage?.promptTokens || null,
          result.usage?.completionTokens || null,
          result.usage ? Date.now() - now : null,
          Date.now()
        )

        // Auto-generate conversation title on first exchange (fire-and-forget)
        const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title: string } | undefined
        if (conv && conv.title === 'New Chat') {
          if (generateTitlePref !== false) {
            generateTitle({ conversationId, userMessage: content, assistantResponse: result.content, broadcast, providerId, model: responseModel }).catch(() => { })
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
