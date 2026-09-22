import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getLatestPlanningState } from '../core/agent/planning-state.js'
import { getAgent } from '../core/agents/agent-store.js'
import { nanoid } from 'nanoid'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { basename, extname, resolve } from 'path'
import {
    cleanupConversationArtifacts,
    artifactFileUrlToDataUrl,
    extractFilePathFromFileUrl,
    getConversationArtifactsDir,
    materializeMediaArtifacts,
    toFileUrl,
    type MediaArtifactKind,
} from '../core/artifacts/image-artifacts.js'
import { collectOrphanedAttachmentAssets, deleteConversationAttachmentIndexes, preserveReferencedAttachmentAssets } from '../core/artifacts/attachment-rag.js'
import { listStagedChatAttachments } from '../core/artifacts/staged-attachments.js'
import { getAssignedMemoryFolders } from '../core/memory/memory-folder-scope.js'
import { buildInitialExecutionConfig, parseExecutionConfig } from '../core/chat/run-config.js'
import type { ConversationExecutionConfig, StoredMessageDto } from '@shared/types'
import { readContentBlocks, toTranscriptItems } from '../core/chat/transcript.js'
import { lastChatEventSequence, listChatEvents } from '../core/chat/chat-events.js'
import { clearDebugContextCapture } from '../core/chat/debug-context.js'
import { invalidateDreamConversation } from '../core/memory/dream-worker.js'
import type { ToolBehaviorAnnotations } from '../core/gateway/providers/base.provider.js'

function escapeSqlLike(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

async function cloneMediaUrlsJson(
    json: string | null,
    conversationId: string,
    kind: MediaArtifactKind,
): Promise<string | null> {
    if (!json) return null
    try {
        const urls = JSON.parse(json) as string[]
        const clonedUrls: string[] = []
        for (const url of urls) {
            try {
                const artifacts = await materializeMediaArtifacts([url], conversationId, kind)
                clonedUrls.push(...artifacts.map((artifact) => artifact.url))
            } catch {
                // Skip missing, expired, or unreadable historical artifacts.
            }
        }
        return clonedUrls.length ? JSON.stringify(clonedUrls) : null
    } catch {
        return null
    }
}

/** Delete artifact files and attachment vectors referenced by conversations. */
async function cleanupConversationArtifactsAndIndexes(conversationIds: string[]): Promise<void> {
    const db = getDb()
    preserveReferencedAttachmentAssets(conversationIds)
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
    await deleteConversationAttachmentIndexes(conversationIds)
}

export async function registerConversationRoutes(app: FastifyInstance): Promise<void> {
    // POST /api/chat/conversations — create
    app.post<{ Body: { title?: string; agentId?: string; maWorkspaceId?: string; origin?: string; executionConfig?: ConversationExecutionConfig } }>('/conversations', async (req) => {
        const { title, agentId, maWorkspaceId, origin, executionConfig } = req.body
        const db = getDb()
        const id = nanoid()
        const now = Date.now()
        const agent = agentId ? getAgent(agentId) : null
        const memoryFolderIds = agentId ? getAssignedMemoryFolders(agentId).map((space) => space.id) : []
        const initialExecutionConfig = executionConfig ?? buildInitialExecutionConfig({ agent, memoryFolderIds })
        db.prepare(
            'INSERT INTO conversations (id, title, agent_id, ma_workspace_id, origin, execution_config_json, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(id, title || 'New Chat', agentId || null, maWorkspaceId || null, origin || 'chat', JSON.stringify(initialExecutionConfig), '{}', now, now)
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
                execution_config_json: string
                metadata_json: string
            } | undefined
            if (!source) return reply.status(404).send({ error: 'Conversation not found' })

            const forkPoint = db
                .prepare('SELECT rowid AS row_id, created_at FROM messages WHERE id = ? AND conversation_id = ?')
                .get(messageId, sourceConversationId) as { row_id: number; created_at: number } | undefined
            if (!forkPoint) return reply.status(404).send({ error: 'Message not found' })

            const id = nanoid()
            const now = Date.now()
            const title = source.title ? `${source.title} (fork)` : 'Forked Chat'
            const lastContextTokens = (db.prepare(`
                SELECT context_tokens FROM messages
                WHERE conversation_id = ? AND (created_at < ? OR (created_at = ? AND rowid <= ?)) AND context_tokens IS NOT NULL
                ORDER BY created_at DESC, rowid DESC
                LIMIT 1
            `).get(sourceConversationId, forkPoint.created_at, forkPoint.created_at, forkPoint.row_id) as { context_tokens: number } | undefined)?.context_tokens ?? null

            db.prepare(`
                INSERT INTO conversations (
                    id, title, agent_id, ma_workspace_id, origin, pinned,
                    last_read_at, last_context_tokens, execution_config_json, metadata_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
            `).run(
                id,
                title,
                source.agent_id,
                source.ma_workspace_id,
                source.origin || 'chat',
                now,
                lastContextTokens,
                source.execution_config_json,
                source.metadata_json,
                now,
                now,
            )

            const messageRows = db.prepare(`
                SELECT * FROM messages
                WHERE conversation_id = ? AND (created_at < ? OR (created_at = ? AND rowid <= ?))
                ORDER BY created_at ASC, rowid ASC
            `).all(sourceConversationId, forkPoint.created_at, forkPoint.created_at, forkPoint.row_id) as {
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
                structured_content_json: string | null
                context_tokens: number | null
                generated_media: number
                created_at: number
            }[]

            const messageIdMap = new Map<string, string>()
            const insertMessage = db.prepare(`
                INSERT INTO messages (
                    id, conversation_id, role, content, tool_calls_json, tool_call_id,
                    provider, model, prompt_tokens, completion_tokens, latency_ms,
                    image_urls_json, video_urls_json, agent_id, memory_sources_json, thinking,
                    audio_urls_json, structured_content_json, context_tokens, generated_media, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)

            for (const row of messageRows) {
                const nextMessageId = nanoid()
                messageIdMap.set(row.id, nextMessageId)
                const imageUrlsJson = await cloneMediaUrlsJson(row.image_urls_json, id, 'image')
                const videoUrlsJson = await cloneMediaUrlsJson(row.video_urls_json, id, 'video')
                const audioUrlsJson = await cloneMediaUrlsJson(row.audio_urls_json, id, 'audio')

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
                    videoUrlsJson,
                    row.agent_id,
                    row.memory_sources_json,
                    row.thinking,
                    audioUrlsJson,
                    row.structured_content_json,
                    row.context_tokens,
                    row.generated_media,
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
                asset_id: string | null
                created_at: number
            }[]

            const insertAttachment = db.prepare(`
                INSERT INTO message_attachments (
                    id, message_id, conversation_id, kind, name, original_path, text_path,
                    size_bytes, text_bytes, chunk_count, metadata_json, created_at
                    , asset_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)

            for (const row of attachmentRows) {
                const nextMessageId = messageIdMap.get(row.message_id)
                if (!nextMessageId) continue

                const attachmentId = nanoid()
                insertAttachment.run(
                    attachmentId,
                    nextMessageId,
                    id,
                    row.kind,
                    row.name,
                    row.original_path,
                    row.text_path,
                    row.size_bytes,
                    row.text_bytes,
                    row.chunk_count,
                    row.metadata_json,
                    row.created_at,
                    row.asset_id || row.id,
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
                ma_invocation_id: string | null
                ma_phase: string | null
                created_at: number
            }[]
            const insertStep = db.prepare(`
                INSERT INTO execution_steps (
                    id, conversation_id, task_id, iteration, status, message, plan,
                    tool_calls_json, results_json, evaluation_json,
                    ma_codename, ma_agent_name, ma_invocation_id, ma_phase, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    row.ma_invocation_id,
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

    // GET /api/chat/uploads — list durable and currently staged document attachments.
    app.get<{ Querystring: { limit?: string; offset?: string; search?: string } }>('/uploads', async (req) => {
        // Reading the library also recovers processing jobs interrupted by an
        // application restart; progress remains authoritative in SQLite.
        listStagedChatAttachments()
        const db = getDb()
        const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || '60', 10) || 60))
        const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0)
        const search = req.query.search?.trim()
        const conditions = ['original_path IS NOT NULL']
        const params: unknown[] = []

        if (search) {
            conditions.push("(name COLLATE NOCASE LIKE ? ESCAPE '\\' OR conversation_title COLLATE NOCASE LIKE ? ESCAPE '\\' OR agent_name COLLATE NOCASE LIKE ? ESCAPE '\\')")
            const pattern = `%${escapeSqlLike(search)}%`
            params.push(pattern, pattern, pattern)
        }

        const uploadsCte = `
            WITH uploads AS (
              SELECT a.id, a.name, a.original_path, a.size_bytes, COALESCE(a.chunk_count, 0) AS chunk_count,
                     a.created_at, c.id AS conversation_id, c.title AS conversation_title,
                     c.agent_id, ag.name AS agent_name, 'ready' AS status,
                     COALESCE(a.chunk_count, 0) AS progress_current,
                     COALESCE(a.chunk_count, 0) AS progress_total, NULL AS error, 0 AS staged
              FROM message_attachments a
              JOIN conversations c ON c.id = a.conversation_id
              LEFT JOIN agents ag ON ag.id = c.agent_id
              WHERE a.kind = 'file' AND a.original_path IS NOT NULL
                AND a.id = (SELECT MIN(a2.id) FROM message_attachments a2 WHERE a2.asset_id = a.asset_id)
              UNION ALL
              SELECT s.id, json_extract(s.artifact_json, '$.name'),
                     json_extract(s.artifact_json, '$.originalPath'),
                     COALESCE(json_extract(s.artifact_json, '$.sizeBytes'), 0),
                     COALESCE(json_extract(s.artifact_json, '$.chunkCount'), 0),
                     s.created_at, c.id, c.title, c.agent_id, ag.name, s.status,
                     s.progress_current, s.progress_total, s.error, 1 AS staged
              FROM staged_chat_attachments s
              JOIN conversations c ON c.id = s.conversation_id
              LEFT JOIN agents ag ON ag.id = c.agent_id
            )
        `
        const from = `FROM uploads WHERE ${conditions.join(' AND ')}`
        const total = (db.prepare(`${uploadsCte} SELECT COUNT(*) AS count ${from}`).get(...params) as { count: number }).count
        const rows = db.prepare(`
            ${uploadsCte}
            SELECT * ${from}
            ORDER BY created_at DESC, id DESC
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset) as {
            id: string
            name: string
            original_path: string
            size_bytes: number | null
            chunk_count: number | null
            created_at: number
            conversation_id: string
            conversation_title: string
            agent_id: string | null
            agent_name: string | null
            status: 'processing' | 'ready' | 'failed'
            progress_current: number
            progress_total: number
            error: string | null
            staged: number
        }[]

        return {
            items: rows.map((row) => ({
                id: row.id,
                name: row.name,
                href: toFileUrl(row.original_path, row.name),
                ext: extname(row.name).replace(/^\./, '').toLowerCase(),
                sizeBytes: row.size_bytes ?? 0,
                chunkCount: row.chunk_count ?? 0,
                createdAt: row.created_at,
                conversationId: row.conversation_id,
                conversationTitle: row.conversation_title,
                agentId: row.agent_id,
                agentName: row.agent_name,
                status: row.status,
                progressCurrent: row.progress_current,
                progressTotal: row.progress_total,
                error: row.error || undefined,
                staged: Boolean(row.staged),
            })),
            total,
        }
    })

    // Resolve library selections to stable server-side references. The send
    // path clones the durable artifact and its existing vectors without
    // transferring or parsing the file again in the browser.
    app.post<{ Body: { ids?: string[] } }>('/uploads/resolve', async (req, reply) => {
        const ids = Array.isArray(req.body?.ids)
            ? [...new Set(req.body.ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
            : []
        if (!ids.length) return { files: [] }
        if (ids.length > 100) return reply.status(400).send({ error: 'No more than 100 uploads can be selected' })

        const db = getDb()
        const placeholders = ids.map(() => '?').join(', ')
        const rows = db.prepare(
            `SELECT id, name, original_path, text_path
             FROM message_attachments
             WHERE kind = 'file' AND id IN (${placeholders})`,
        ).all(...ids) as { id: string; name: string; original_path: string | null; text_path: string | null }[]
        const byId = new Map(rows.map((row) => [row.id, row]))
        const files = ids.map((id) => {
            const row = byId.get(id)
            if (!row || !row.original_path || !row.text_path || !existsSync(row.original_path) || !existsSync(row.text_path)) {
                return null
            }
            return { id: row.id, name: row.name, existingAttachmentId: row.id }
        })
        const missing = ids.filter((id, index) => !files[index])
        if (missing.length) {
            return reply.status(404).send({ error: 'One or more selected uploads are no longer available' })
        }
        return { files: files.filter((file): file is NonNullable<typeof file> => file !== null) }
    })

    // Resolve generated artifacts into the same payload shapes as freshly
    // attached chat inputs. Local artifact URLs are converted server-side so
    // providers never receive browser-only /api/files references.
    app.post<{
        Body: {
            artifacts?: {
                id?: string
                href?: string
                label?: string
                kind?: 'file' | 'image' | 'video' | 'audio'
            }[]
        }
    }>('/artifacts/resolve', async (req, reply) => {
        const artifacts = Array.isArray(req.body?.artifacts) ? req.body.artifacts : []
        if (artifacts.length > 100) {
            return reply.status(400).send({ error: 'No more than 100 artifacts can be selected' })
        }

        const images: { id: string; name: string; url: string }[] = []
        const audio: { id: string; name: string; url: string }[] = []
        const files: { id: string; name: string; content: string }[] = []
        const seen = new Set<string>()

        for (const artifact of artifacts) {
            const id = typeof artifact.id === 'string' ? artifact.id : ''
            const href = typeof artifact.href === 'string' ? artifact.href : ''
            const label = typeof artifact.label === 'string' ? basename(artifact.label) : ''
            const kind = artifact.kind
            if (!id || !href || !label || !kind || seen.has(id)) continue
            seen.add(id)

            if (kind === 'video') {
                return reply.status(400).send({ error: 'Video artifacts cannot currently be used as chat context' })
            }

            if (kind === 'file') {
                const path = extractFilePathFromFileUrl(href)
                if (!path || !existsSync(path)) {
                    return reply.status(404).send({ error: `Artifact "${label}" is no longer available` })
                }
                const encoded = readFileSync(path).toString('base64')
                files.push({ id, name: label, content: `data:application/octet-stream;base64,${encoded}` })
                continue
            }

            const resolved = artifactFileUrlToDataUrl(href)
            if (!resolved && href.startsWith('/api/files?')) {
                return reply.status(404).send({ error: `Artifact "${label}" is no longer available` })
            }
            const item = { id, name: label, url: resolved || href }
            if (kind === 'image') images.push(item)
            else audio.push(item)
        }

        return { images, audio, files }
    })

    // GET /api/chat/conversations — list (optionally filtered by agent_id or ma_workspace_id)
    // Supports pagination via ?limit=N&offset=N — when limit is set, returns { items, total }
    app.get<{ Querystring: { agentId?: string; maWorkspaceId?: string; limit?: string; offset?: string; sort?: string; search?: string; filters?: string } }>('/conversations', async (req) => {
        const db = getDb()
        const { agentId, maWorkspaceId } = req.query
        const limit = req.query.limit ? Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20)) : undefined
        const offset = req.query.offset ? Math.max(0, parseInt(req.query.offset, 10) || 0) : 0
        const search = req.query.search?.trim()
        const excerpt = `(SELECT SUBSTR(m.content, 1, 120) FROM messages m WHERE m.conversation_id = conversations.id AND m.role = 'user' ORDER BY m.created_at DESC LIMIT 1) AS last_user_message`
        const orderBy = req.query.sort === 'sidebar'
            ? 'ORDER BY EXISTS(SELECT 1 FROM pending_hitl WHERE pending_hitl.conversation_id = conversations.id) DESC, pinned DESC, updated_at DESC'
            : req.query.sort === 'updated'
                ? 'ORDER BY updated_at DESC'
                : 'ORDER BY pinned DESC, created_at DESC'

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
        const requestedFilters = new Set((req.query.filters || '').split(',').filter(Boolean))
        const filterConditions: string[] = []
        if (requestedFilters.has('free')) filterConditions.push("(origin = 'chat' AND agent_id IS NULL AND ma_workspace_id IS NULL)")
        if (requestedFilters.has('agents')) filterConditions.push("(origin = 'chat' AND agent_id IS NOT NULL)")
        if (requestedFilters.has('cron')) filterConditions.push("origin = 'cron'")
        if (requestedFilters.has('channel')) filterConditions.push("origin = 'channel'")
        if (filterConditions.length) conditions.push(`(${filterConditions.join(' OR ')})`)
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

        // Fetch conversation-level metadata (context tokens + execution config)
        const convRow = db.prepare('SELECT agent_id, last_context_tokens, execution_config_json FROM conversations WHERE id = ?').get(req.params.id) as { agent_id: string | null; last_context_tokens: number | null; execution_config_json: string } | undefined

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
                structured_content_json: string | null
                content_blocks_json: string | null
                memory_sources_json: string | null
                agent_id: string | null
                ma_codename: string | null
                ma_agent_name: string | null
                ma_invocation_id: string | null
                provider: string | null
                model: string | null
                prompt_tokens: number | null
                completion_tokens: number | null
                context_tokens: number | null
                latency_ms: number | null
                created_at: number
            }[]

        const attachmentRows = db.prepare(
            'SELECT message_id, name, original_path FROM message_attachments WHERE conversation_id = ? ORDER BY created_at ASC'
        ).all(req.params.id) as { message_id: string; name: string; original_path: string | null }[]
        const attachmentsByMessage = new Map<string, { name: string; originalPath: string }[]>()
        for (const row of attachmentRows) {
            if (!row.original_path) continue
            const existing = attachmentsByMessage.get(row.message_id) || []
            existing.push({ name: row.name, originalPath: row.original_path })
            attachmentsByMessage.set(row.message_id, existing)
        }

        const executionConfig = parseExecutionConfig(convRow?.execution_config_json)

        const messages = rows.map((row): StoredMessageDto => {
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
                let toolCalls: unknown[] | undefined
                try {
                    const parsed = row.tool_calls_json ? JSON.parse(row.tool_calls_json) : undefined
                    toolCalls = Array.isArray(parsed) ? parsed : undefined
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
                let structuredContent: unknown | undefined
                try {
                    structuredContent = row.structured_content_json ? JSON.parse(row.structured_content_json) : undefined
                } catch { /* malformed JSON - ignore */ }
                let contextEvidence: unknown | undefined
                try {
                    contextEvidence = row.memory_sources_json ? JSON.parse(row.memory_sources_json) : undefined
                } catch { /* malformed JSON - ignore */ }
                const fileAttachments = attachmentsByMessage.get(row.id)?.map((file) => ({
                    name: file.name,
                    href: toFileUrl(file.originalPath, file.name),
                }))
                const message: StoredMessageDto = {
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
                    structuredContent,
                    contextEvidence: contextEvidence as StoredMessageDto['contextEvidence'],
                    fileAttachments,
                    agentId: row.agent_id || undefined,
                    agentName,
                    agentIconUrl,
                    maCodename: row.ma_codename || undefined,
                    maAgentName: row.ma_agent_name || undefined,
                    maInvocationId: row.ma_invocation_id || undefined,
                    provider: row.provider,
                    model: row.model,
                    promptTokens: row.prompt_tokens,
                    completionTokens: row.completion_tokens,
                    contextTokens: row.context_tokens,
                    latencyMs: row.latency_ms,
                    createdAt: row.created_at
                }
                message.blocks = readContentBlocks(row.content_blocks_json, message)
                return message
            })
        return {
            conversationAgentId: convRow?.agent_id ?? null,
            lastContextTokens: convRow?.last_context_tokens ?? null,
            executionConfig,
            messages,
            transcript: messages.flatMap(toTranscriptItems),
            lastEventSequence: lastChatEventSequence(db, req.params.id),
        }
    })

    // Replay only events after a snapshot cursor. The event stream is scoped to
    // the requested conversation and ordered by its durable sequence number.
    app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
        '/conversations/:id/events',
        async (req) => {
            const after = Number(req.query.after ?? 0)
            return {
                events: listChatEvents(
                    getDb(), req.params.id,
                    Number.isSafeInteger(after) && after >= 0 ? after : 0,
                ),
            }
        },
    )

    // Resolve persisted attachments before retrying/editing a message. Stored
    // /api/files URLs are only browser-facing references and cannot be sent to
    // providers (or survive the subsequent history truncation) as-is.
    app.get<{ Params: { id: string; messageId: string } }>(
        '/conversations/:id/messages/:messageId/attachments',
        async (req, reply) => {
            const db = getDb()
            const message = db.prepare(
                `SELECT image_urls_json, audio_urls_json
                 FROM messages
                 WHERE id = ? AND conversation_id = ? AND role = 'user'`
            ).get(req.params.messageId, req.params.id) as {
                image_urls_json: string | null
                audio_urls_json: string | null
            } | undefined
            if (!message) return reply.status(404).send({ error: 'Message not found' })

            const resolveMedia = (json: string | null): string[] => {
                if (!json) return []
                let urls: unknown
                try {
                    urls = JSON.parse(json) as unknown
                } catch {
                    return []
                }
                if (!Array.isArray(urls)) return []
                return urls
                    .filter((url): url is string => typeof url === 'string')
                    .map((url) => {
                        const resolved = artifactFileUrlToDataUrl(url)
                        if (resolved) return resolved
                        if (url.startsWith('/api/files?')) {
                            throw new Error('A persisted attachment is no longer available')
                        }
                        return url
                    })
            }

            const attachmentRows = db.prepare(
                `SELECT name, original_path
                 FROM message_attachments
                 WHERE message_id = ? AND conversation_id = ? AND kind = 'file'
                 ORDER BY created_at ASC`
            ).all(req.params.messageId, req.params.id) as { name: string; original_path: string | null }[]
            const files = attachmentRows.map((row) => {
                if (!row.original_path || !existsSync(row.original_path)) {
                    throw new Error(`Persisted attachment "${row.name}" is no longer available`)
                }
                const encoded = readFileSync(row.original_path).toString('base64')
                return { name: row.name, content: `data:application/octet-stream;base64,${encoded}` }
            })
            const imageDataUrls = resolveMedia(message.image_urls_json)
            const audioDataUrls = resolveMedia(message.audio_urls_json)
            return {
                imageDataUrls: imageDataUrls.length ? imageDataUrls : undefined,
                audioDataUrls: audioDataUrls.length ? audioDataUrls : undefined,
                files: files.length ? files : undefined,
            }
        }
    )

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
                ma_invocation_id: string | null
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
            maInvocationId: row.ma_invocation_id,
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
            toolCalls: JSON.parse(row.tool_calls_json) as Array<{
                name: string
                arguments: string
                annotations?: ToolBehaviorAnnotations
            }>
        }))
    })

    // GET /api/chat/conversations/:id/planning-state — latest visible planning task list
    app.get<{ Params: { id: string } }>('/conversations/:id/planning-state', async (req) => {
        return getLatestPlanningState(req.params.id)
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
        await invalidateDreamConversation(req.params.id)
        clearDebugContextCapture(req.params.id)
        db.prepare('DELETE FROM execution_steps WHERE conversation_id = ?').run(req.params.id)
        db.prepare('DELETE FROM tasks WHERE conversation_id = ?').run(req.params.id)
        db.prepare('DELETE FROM session_tool_approvals WHERE conversation_id = ?').run(req.params.id)
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(req.params.id)
        db.prepare('DELETE FROM conversations WHERE id = ?').run(req.params.id)
        await collectOrphanedAttachmentAssets()
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
            for (const { id } of ids) await invalidateDreamConversation(id)
            for (const { id } of ids) clearDebugContextCapture(id)
            for (const { id } of ids) {
                db.prepare('DELETE FROM execution_steps WHERE conversation_id = ?').run(id)
                db.prepare('DELETE FROM tasks WHERE conversation_id = ?').run(id)
                db.prepare('DELETE FROM session_tool_approvals WHERE conversation_id = ?').run(id)
                db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
            }
            db.prepare(`DELETE FROM conversations WHERE ${filter} AND pinned = 0`).run(...(agentId === '' ? [] : [agentId]))
            await collectOrphanedAttachmentAssets()
        } else {
            const allIds = db.prepare('SELECT id FROM conversations WHERE pinned = 0').all() as { id: string }[]
            await cleanupConversationArtifactsAndIndexes(allIds.map(r => r.id))
            for (const { id } of allIds) await invalidateDreamConversation(id)
            for (const { id } of allIds) clearDebugContextCapture(id)
            for (const { id } of allIds) {
                db.prepare('DELETE FROM execution_steps WHERE conversation_id = ?').run(id)
                db.prepare('DELETE FROM tasks WHERE conversation_id = ?').run(id)
                db.prepare('DELETE FROM session_tool_approvals WHERE conversation_id = ?').run(id)
                db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
            }
            db.prepare('DELETE FROM conversations WHERE pinned = 0').run()
            await collectOrphanedAttachmentAssets()
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

            await invalidateDreamConversation(conversationId)

            // Cleanup locally materialized media for messages being truncated.
            const mediaRows = db.prepare(
                `SELECT image_urls_json, video_urls_json, audio_urls_json
                 FROM messages WHERE conversation_id = ? AND created_at >= ?`
            ).all(conversationId, row.created_at) as {
                image_urls_json: string | null
                video_urls_json: string | null
                audio_urls_json: string | null
            }[]
            const conversationArtifactsDir = resolve(getConversationArtifactsDir(conversationId))
            for (const mediaRow of mediaRows) {
                for (const json of [mediaRow.image_urls_json, mediaRow.video_urls_json, mediaRow.audio_urls_json]) {
                    if (!json) continue
                    try {
                        const urls: string[] = JSON.parse(json)
                        for (const url of urls) {
                            const filePath = extractFilePathFromFileUrl(url)
                            const resolvedPath = filePath ? resolve(filePath) : null
                            if (resolvedPath?.startsWith(`${conversationArtifactsDir}/`)) {
                                try { unlinkSync(resolvedPath) } catch { /* already gone */ }
                            }
                        }
                    } catch { /* skip malformed media metadata */ }
                }
            }

            const result = db
                .prepare('DELETE FROM messages WHERE conversation_id = ? AND created_at >= ?')
                .run(conversationId, row.created_at)
            await collectOrphanedAttachmentAssets()
            db.prepare('DELETE FROM execution_steps WHERE conversation_id = ? AND created_at >= ?')
                .run(conversationId, row.created_at)
            db.prepare('DELETE FROM tasks WHERE conversation_id = ? AND created_at >= ?')
                .run(conversationId, row.created_at)
            return { success: true, deleted: result.changes }
        }
    )
}
