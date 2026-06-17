import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getLatestOrchestrationState } from '../core/agent/orchestration-state.js'
import { getAgent } from '../core/agents/agent-store.js'
import { isBuiltInMemoryToolKey } from '../core/tools/built-in-tools.js'
import { nanoid } from 'nanoid'
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { basename, join } from 'path'
import { cleanupConversationArtifacts, extractFilePathFromFileUrl, getConversationArtifactsDir, materializeImageArtifacts } from '../core/artifacts/image-artifacts.js'
import { deleteConversationAttachmentIndex, indexConversationAttachment } from '../core/artifacts/attachment-rag.js'
import { getAssignedOrDefaultSpaces } from '../core/memory/memory-space-scope.js'
import type { FileAttachmentArtifact } from '../core/artifacts/file-artifacts.js'

function escapeSqlLike(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function hydrateChatConfigFromAgent(
    chatConfig: Record<string, unknown> | undefined,
    agentId: string | null | undefined,
): Record<string, unknown> | undefined {
    if (!agentId) return chatConfig
    const agent = getAgent(agentId)
    if (!agent) return chatConfig

    const hydrated: Record<string, unknown> = { ...(chatConfig ?? {}) }

    if (!Object.prototype.hasOwnProperty.call(hydrated, 'allowedTools')) {
        hydrated.allowedTools = agent.tools
    }
    if (!Object.prototype.hasOwnProperty.call(hydrated, 'subAgents')) {
        hydrated.subAgents = agent.subAgents
    }
    if (!Object.prototype.hasOwnProperty.call(hydrated, 'memorySpaceIds')) {
        hydrated.memorySpaceIds = getAssignedOrDefaultSpaces(agentId).map((space) => space.id)
    }
    if (!Object.prototype.hasOwnProperty.call(hydrated, 'systemPrompt')) {
        hydrated.systemPrompt = agent.systemPrompt
    }
    if (!Object.prototype.hasOwnProperty.call(hydrated, 'model')) {
        hydrated.model = agent.model
    }
    if (!Object.prototype.hasOwnProperty.call(hydrated, 'providerId')) {
        hydrated.providerId = agent.providerId
    }
    if (!Object.prototype.hasOwnProperty.call(hydrated, 'thinkingEnabled')) {
        hydrated.thinkingEnabled = agent.thinkingEnabled
    }
    if (!Object.prototype.hasOwnProperty.call(hydrated, 'autoToolRouting')) {
        hydrated.autoToolRouting = agent.autoToolRouting
    }
    if (!Object.prototype.hasOwnProperty.call(hydrated, 'autoMemory')) {
        hydrated.autoMemory = agent.autoMemory
    }

    return hydrated
}

/** Delete artifact files and attachment vectors referenced by conversations. */
async function cleanupConversationArtifactsAndIndexes(conversationIds: string[]): Promise<void> {
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
                    const filePath = extractFilePathFromFileUrl(url)
                    if (filePath) {
                        try { unlinkSync(filePath) } catch { /* file may already be gone */ }
                    }
                }
            } catch { /* skip malformed JSON */ }
        }

        cleanupConversationArtifacts(convId)
        await deleteConversationAttachmentIndex(convId)
    }
}

function cloneAttachmentFile(sourcePath: string | null, conversationId: string, suffix = ''): string | null {
    if (!sourcePath || !existsSync(sourcePath)) return sourcePath
    const dir = join(getConversationArtifactsDir(conversationId), 'files')
    mkdirSync(dir, { recursive: true })
    const filename = `${Date.now()}-${nanoid()}-${basename(sourcePath).replace(/[^A-Za-z0-9._-]/g, '_')}${suffix}`
    const targetPath = join(dir, filename)
    copyFileSync(sourcePath, targetPath)
    return targetPath
}

export async function registerConversationRoutes(app: FastifyInstance): Promise<void> {
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

    // POST /api/chat/conversations/:id/fork — clone config and history through one message
    app.post<{ Params: { id: string }; Body: { messageId: string } }>(
        '/conversations/:id/fork',
        async (req, reply) => {
            const { id: sourceConversationId } = req.params
            const { messageId } = req.body
            if (!messageId) return reply.status(400).send({ error: 'messageId is required' })

            const db = getDb()
            const source = db.prepare('SELECT * FROM conversations WHERE id = ?').get(sourceConversationId) as {
                id: string
                title: string | null
                agent_id: string | null
                ma_workspace_id: string | null
                origin: string
                config_json: string | null
            } | undefined
            if (!source) return reply.status(404).send({ error: 'Conversation not found' })

            const forkPoint = db
                .prepare('SELECT created_at FROM messages WHERE id = ? AND conversation_id = ?')
                .get(messageId, sourceConversationId) as { created_at: number } | undefined
            if (!forkPoint) return reply.status(404).send({ error: 'Message not found' })

            const id = nanoid()
            const now = Date.now()
            const title = source.title ? `${source.title} (fork)` : 'Forked Chat'
            const lastContextTokens = (db.prepare(`
                SELECT context_tokens FROM messages
                WHERE conversation_id = ? AND created_at <= ? AND context_tokens IS NOT NULL
                ORDER BY created_at DESC
                LIMIT 1
            `).get(sourceConversationId, forkPoint.created_at) as { context_tokens: number } | undefined)?.context_tokens ?? null

            db.prepare(`
                INSERT INTO conversations (
                    id, title, agent_id, ma_workspace_id, origin, pinned,
                    last_read_at, last_context_tokens, config_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
            `).run(
                id,
                title,
                source.agent_id,
                source.ma_workspace_id,
                source.origin || 'chat',
                now,
                lastContextTokens,
                source.config_json,
                now,
                now,
            )

            const messageRows = db.prepare(`
                SELECT * FROM messages
                WHERE conversation_id = ? AND created_at <= ?
                ORDER BY created_at ASC
            `).all(sourceConversationId, forkPoint.created_at) as {
                id: string
                role: string
                content: string
                tool_calls_json: string | null
                tool_call_id: string | null
                provider: string | null
                model: string | null
                prompt_tokens: number | null
                completion_tokens: number | null
                latency_ms: number | null
                image_urls_json: string | null
                video_urls_json: string | null
                agent_id: string | null
                memory_sources_json: string | null
                thinking: string | null
                audio_urls_json: string | null
                context_tokens: number | null
                created_at: number
            }[]

            const messageIdMap = new Map<string, string>()
            const insertMessage = db.prepare(`
                INSERT INTO messages (
                    id, conversation_id, role, content, tool_calls_json, tool_call_id,
                    provider, model, prompt_tokens, completion_tokens, latency_ms,
                    image_urls_json, video_urls_json, agent_id, memory_sources_json, thinking,
                    audio_urls_json, context_tokens, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)

            for (const row of messageRows) {
                const nextMessageId = nanoid()
                messageIdMap.set(row.id, nextMessageId)
                let imageUrlsJson = row.image_urls_json
                if (row.image_urls_json) {
                    try {
                        const imageUrls = JSON.parse(row.image_urls_json) as string[]
                        const forkedImageUrls: string[] = []
                        for (const imageUrl of imageUrls) {
                            try {
                                const artifacts = await materializeImageArtifacts([imageUrl], id)
                                forkedImageUrls.push(...artifacts.map((artifact) => artifact.url))
                            } catch {
                                // Skip missing or unreadable historical artifacts in the fork.
                            }
                        }
                        imageUrlsJson = forkedImageUrls.length ? JSON.stringify(forkedImageUrls) : null
                    } catch {
                        imageUrlsJson = null
                    }
                }

                insertMessage.run(
                    nextMessageId,
                    id,
                    row.role,
                    row.content,
                    row.tool_calls_json,
                    row.tool_call_id,
                    row.provider,
                    row.model,
                    row.prompt_tokens,
                    row.completion_tokens,
                    row.latency_ms,
                    imageUrlsJson,
                    row.video_urls_json,
                    row.agent_id,
                    row.memory_sources_json,
                    row.thinking,
                    row.audio_urls_json,
                    row.context_tokens,
                    row.created_at,
                )
            }

            const attachmentRows = db.prepare(`
                SELECT a.*
                FROM message_attachments a
                JOIN messages m ON m.id = a.message_id
                WHERE a.conversation_id = ? AND m.created_at <= ?
                ORDER BY a.created_at ASC
            `).all(sourceConversationId, forkPoint.created_at) as {
                id: string
                message_id: string
                kind: string
                name: string
                original_path: string | null
                text_path: string | null
                size_bytes: number | null
                text_bytes: number | null
                chunk_count: number | null
                metadata_json: string | null
                created_at: number
            }[]

            const insertAttachment = db.prepare(`
                INSERT INTO message_attachments (
                    id, message_id, conversation_id, kind, name, original_path, text_path,
                    size_bytes, text_bytes, chunk_count, metadata_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)

            for (const row of attachmentRows) {
                const nextMessageId = messageIdMap.get(row.message_id)
                if (!nextMessageId) continue

                const attachmentId = nanoid()
                const originalPath = cloneAttachmentFile(row.original_path, id)
                const textPath = cloneAttachmentFile(row.text_path, id, '.parsed.md')
                const attachment: FileAttachmentArtifact = {
                    id: attachmentId,
                    name: row.name,
                    originalPath: originalPath || '',
                    textPath: textPath || '',
                    sizeBytes: row.size_bytes ?? 0,
                    textBytes: row.text_bytes ?? 0,
                    chunkCount: row.chunk_count ?? undefined,
                }
                attachment.chunkCount = await indexConversationAttachment(id, attachment)

                insertAttachment.run(
                    attachmentId,
                    nextMessageId,
                    id,
                    row.kind,
                    row.name,
                    originalPath,
                    textPath,
                    row.size_bytes,
                    row.text_bytes,
                    attachment.chunkCount ?? row.chunk_count,
                    JSON.stringify(attachment),
                    row.created_at,
                )
            }

            const stepRows = db.prepare(`
                SELECT * FROM execution_steps
                WHERE conversation_id = ? AND created_at <= ?
                ORDER BY created_at ASC
            `).all(sourceConversationId, forkPoint.created_at) as {
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
            const insertStep = db.prepare(`
                INSERT INTO execution_steps (
                    id, conversation_id, task_id, iteration, status, message, plan,
                    tool_calls_json, results_json, evaluation_json,
                    ma_codename, ma_agent_name, ma_phase, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            for (const row of stepRows) {
                insertStep.run(
                    nanoid(),
                    id,
                    row.task_id,
                    row.iteration,
                    row.status,
                    row.message,
                    row.plan,
                    row.tool_calls_json,
                    row.results_json,
                    row.evaluation_json,
                    row.ma_codename,
                    row.ma_agent_name,
                    row.ma_phase,
                    row.created_at,
                )
            }

            return {
                id,
                title,
                agentId: source.agent_id,
                maWorkspaceId: source.ma_workspace_id,
                origin: source.origin || 'chat',
                createdAt: now,
                updatedAt: now,
            }
        }
    )

    // GET /api/chat/conversations — list (optionally filtered by agent_id or ma_workspace_id)
    // Supports pagination via ?limit=N&offset=N — when limit is set, returns { items, total }
    app.get<{ Querystring: { agentId?: string; maWorkspaceId?: string; limit?: string; offset?: string; sort?: string; search?: string } }>('/conversations', async (req) => {
        const db = getDb()
        const { agentId, maWorkspaceId } = req.query
        const limit = req.query.limit ? Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20)) : undefined
        const offset = req.query.offset ? Math.max(0, parseInt(req.query.offset, 10) || 0) : 0
        const search = req.query.search?.trim()
        const excerpt = `(SELECT SUBSTR(m.content, 1, 120) FROM messages m WHERE m.conversation_id = conversations.id AND m.role = 'user' ORDER BY m.created_at DESC LIMIT 1) AS last_user_message`
        const orderBy = req.query.sort === 'updated'
            ? 'ORDER BY updated_at DESC'
            : 'ORDER BY pinned DESC, updated_at DESC'

        const conditions: string[] = []
        const params: unknown[] = []
        if (maWorkspaceId) {
            conditions.push('ma_workspace_id = ?')
            params.push(maWorkspaceId)
        } else if (agentId) {
            conditions.push('agent_id = ?')
            params.push(agentId)
        } else if (agentId === '') {
            conditions.push('agent_id IS NULL AND ma_workspace_id IS NULL')
        }
        if (search && search.length >= 2) {
            conditions.push("title COLLATE NOCASE LIKE ? ESCAPE '\\'")
            params.push(`%${escapeSqlLike(search)}%`)
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

        if (limit !== undefined) {
            const total = (db.prepare(`SELECT COUNT(*) as count FROM conversations ${where}`).get(...params) as { count: number }).count
            const items = db.prepare(`SELECT *, ${excerpt} FROM conversations ${where} ${orderBy} LIMIT ? OFFSET ?`).all(...params, limit, offset)
            return { items, total }
        }

        return db.prepare(`SELECT *, ${excerpt} FROM conversations ${where} ${orderBy}`).all(...params)
    })

    // GET /api/chat/conversations/:id/messages — get messages
    app.get<{ Params: { id: string } }>('/conversations/:id/messages', async (req) => {
        const db = getDb()

        // Fetch conversation-level metadata (context tokens + session config)
        const convRow = db.prepare('SELECT agent_id, last_context_tokens, config_json FROM conversations WHERE id = ?').get(req.params.id) as { agent_id: string | null; last_context_tokens: number | null; config_json: string | null } | undefined

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
                video_urls_json: string | null
                audio_urls_json: string | null
                agent_id: string | null
                provider: string | null
                model: string | null
                prompt_tokens: number | null
                completion_tokens: number | null
                context_tokens: number | null
                latency_ms: number | null
                created_at: number
            }[]

        const attachmentRows = db.prepare(
            'SELECT message_id, name FROM message_attachments WHERE conversation_id = ? ORDER BY created_at ASC'
        ).all(req.params.id) as { message_id: string; name: string }[]
        const attachmentsByMessage = new Map<string, { name: string }[]>()
        for (const row of attachmentRows) {
            const existing = attachmentsByMessage.get(row.message_id) || []
            existing.push({ name: row.name })
            attachmentsByMessage.set(row.message_id, existing)
        }

        let chatConfig: Record<string, unknown> | undefined
        try {
            chatConfig = convRow?.config_json ? JSON.parse(convRow.config_json) : undefined
            chatConfig = hydrateChatConfigFromAgent(chatConfig, convRow?.agent_id)
            if (chatConfig && Array.isArray(chatConfig.allowedTools)) {
                chatConfig.allowedTools = chatConfig.allowedTools.filter((toolKey) => (
                    typeof toolKey === 'string' && !isBuiltInMemoryToolKey(toolKey)
                ))
            }
        } catch { /* malformed JSON — ignore */ }

        return {
            conversationAgentId: convRow?.agent_id ?? null,
            lastContextTokens: convRow?.last_context_tokens ?? null,
            chatConfig,
            messages: rows.map((row) => {
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
                let videoDataUrls: string[] | undefined
                try {
                    videoDataUrls = row.video_urls_json ? JSON.parse(row.video_urls_json) : undefined
                } catch { /* malformed JSON — ignore */ }
                const fileAttachments = attachmentsByMessage.get(row.id)
                return {
                    id: row.id,
                    conversationId: row.conversation_id,
                    role: row.role,
                    content: row.content,
                    thinking: row.thinking || undefined,
                    toolCalls,
                    toolCallId: row.tool_call_id || undefined,
                    imageDataUrls,
                    videoDataUrls,
                    audioDataUrls,
                    fileAttachments,
                    agentId: row.agent_id || undefined,
                    agentName,
                    agentIconUrl,
                    provider: row.provider,
                    model: row.model,
                    promptTokens: row.prompt_tokens,
                    completionTokens: row.completion_tokens,
                    contextTokens: row.context_tokens,
                    latencyMs: row.latency_ms,
                    createdAt: row.created_at
                }
            }),
        }
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

    // GET /api/chat/conversations/:id/hitl — return all pending HITL requests for this conversation
    app.get<{ Params: { id: string } }>('/conversations/:id/hitl', async (req) => {
        const db = getDb()
        const rows = db
            .prepare('SELECT task_id, tool_calls_json FROM pending_hitl WHERE conversation_id = ? ORDER BY created_at ASC')
            .all(req.params.id) as { task_id: string; tool_calls_json: string }[]
        if (!rows.length) return []
        return rows.map(row => ({
            taskId: row.task_id,
            toolCalls: JSON.parse(row.tool_calls_json) as { name: string; arguments: string }[]
        }))
    })

    // GET /api/chat/conversations/:id/orchestration-state — latest visible orchestration task list
    app.get<{ Params: { id: string } }>('/conversations/:id/orchestration-state', async (req) => {
        return getLatestOrchestrationState(req.params.id)
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

    // PATCH /api/chat/conversations/:id/read — mark conversation as read
    app.patch<{ Params: { id: string } }>('/conversations/:id/read', async (req) => {
        const db = getDb()
        const now = Date.now()
        db.prepare(
            'UPDATE conversations SET last_read_at = MAX(COALESCE(last_read_at, 0), updated_at, ?) WHERE id = ?'
        ).run(now, req.params.id)
        return { success: true }
    })

    // DELETE /api/chat/conversations/:id — delete (blocked for pinned conversations)
    app.delete<{ Params: { id: string } }>('/conversations/:id', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT pinned FROM conversations WHERE id = ?').get(req.params.id) as { pinned: number } | undefined
        if (row?.pinned) {
            return reply.status(400).send({ error: 'Cannot delete a pinned conversation. Unpin it first.' })
        }
        await cleanupConversationArtifactsAndIndexes([req.params.id])
        db.prepare('DELETE FROM execution_steps WHERE conversation_id = ?').run(req.params.id)
        db.prepare('DELETE FROM tasks WHERE conversation_id = ?').run(req.params.id)
        db.prepare('DELETE FROM session_tool_approvals WHERE conversation_id = ?').run(req.params.id)
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
            await cleanupConversationArtifactsAndIndexes(ids.map(r => r.id))
            for (const { id } of ids) {
                db.prepare('DELETE FROM execution_steps WHERE conversation_id = ?').run(id)
                db.prepare('DELETE FROM tasks WHERE conversation_id = ?').run(id)
                db.prepare('DELETE FROM session_tool_approvals WHERE conversation_id = ?').run(id)
                db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
            }
            db.prepare(`DELETE FROM conversations WHERE ${filter} AND pinned = 0`).run(...(agentId === '' ? [] : [agentId]))
        } else {
            const allIds = db.prepare('SELECT id FROM conversations WHERE pinned = 0').all() as { id: string }[]
            await cleanupConversationArtifactsAndIndexes(allIds.map(r => r.id))
            for (const { id } of allIds) {
                db.prepare('DELETE FROM execution_steps WHERE conversation_id = ?').run(id)
                db.prepare('DELETE FROM tasks WHERE conversation_id = ?').run(id)
                db.prepare('DELETE FROM session_tool_approvals WHERE conversation_id = ?').run(id)
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
                        const filePath = extractFilePathFromFileUrl(url)
                        if (filePath) {
                            try { unlinkSync(filePath) } catch { /* already gone */ }
                        }
                    }
                } catch { /* skip */ }
            }

            const result = db
                .prepare('DELETE FROM messages WHERE conversation_id = ? AND created_at >= ?')
                .run(conversationId, row.created_at)
            db.prepare('DELETE FROM execution_steps WHERE conversation_id = ? AND created_at >= ?')
                .run(conversationId, row.created_at)
            db.prepare('DELETE FROM tasks WHERE conversation_id = ? AND created_at >= ?')
                .run(conversationId, row.created_at)
            return { success: true, deleted: result.changes }
        }
    )
}
