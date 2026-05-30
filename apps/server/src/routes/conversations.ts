import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getLatestOrchestrationState } from '../core/agent/orchestration-state.js'
import { getAgent } from '../core/agents/agent-store.js'
import { nanoid } from 'nanoid'
import { unlinkSync } from 'fs'
import { cleanupConversationArtifacts, extractFilePathFromFileUrl } from '../core/artifacts/image-artifacts.js'

function escapeSqlLike(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

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
                    const filePath = extractFilePathFromFileUrl(url)
                    if (filePath) {
                        try { unlinkSync(filePath) } catch { /* file may already be gone */ }
                    }
                }
            } catch { /* skip malformed JSON */ }
        }

        cleanupConversationArtifacts(convId)
    }
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
                audio_urls_json: string | null
                file_attachments_json: string | null
                agent_id: string | null
                provider: string | null
                model: string | null
                prompt_tokens: number | null
                completion_tokens: number | null
                context_tokens: number | null
                latency_ms: number | null
                created_at: number
            }[]

        let chatConfig: Record<string, unknown> | undefined
        try {
            chatConfig = convRow?.config_json ? JSON.parse(convRow.config_json) : undefined
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

    // DELETE /api/chat/conversations/:id — delete (blocked for pinned conversations)
    app.delete<{ Params: { id: string } }>('/conversations/:id', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT pinned FROM conversations WHERE id = ?').get(req.params.id) as { pinned: number } | undefined
        if (row?.pinned) {
            return reply.status(400).send({ error: 'Cannot delete a pinned conversation. Unpin it first.' })
        }
        cleanupConversationImages([req.params.id])
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
            cleanupConversationImages(ids.map(r => r.id))
            for (const { id } of ids) {
                db.prepare('DELETE FROM execution_steps WHERE conversation_id = ?').run(id)
                db.prepare('DELETE FROM tasks WHERE conversation_id = ?').run(id)
                db.prepare('DELETE FROM session_tool_approvals WHERE conversation_id = ?').run(id)
                db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
            }
            db.prepare(`DELETE FROM conversations WHERE ${filter} AND pinned = 0`).run(...(agentId === '' ? [] : [agentId]))
        } else {
            const allIds = db.prepare('SELECT id FROM conversations WHERE pinned = 0').all() as { id: string }[]
            cleanupConversationImages(allIds.map(r => r.id))
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
