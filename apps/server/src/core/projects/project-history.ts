import { randomUUID } from 'node:crypto'
import { diffWordsWithSpace } from 'diff'
import { getDb } from '../../db/database.js'
import type { ProjectBriefRevisionDto, ProjectChangeSource, ProjectDiffSegment, ProjectTaskStatus, ProjectTimelineEntry } from '@shared/types'

/** Who made a project change and where, recorded on brief revisions and timeline events. */
export interface ProjectChangeContext {
    source: ProjectChangeSource
    conversationId?: string
    agentId?: string
}

export const USER_CHANGE: ProjectChangeContext = { source: 'user' }

interface RevisionRow {
    id: string
    project_id: string
    revision_number: number
    content: string
    source: ProjectChangeSource
    conversation_id: string | null
    agent_id: string | null
    created_at: number
}

function rowToRevision(row: RevisionRow, latestNumber: number): ProjectBriefRevisionDto {
    return {
        id: row.id,
        revisionNumber: row.revision_number,
        content: row.content,
        source: row.source,
        conversationId: row.conversation_id,
        agentId: row.agent_id,
        createdAt: row.created_at,
        isCurrent: row.revision_number === latestNumber,
    }
}

function latestRevisionNumber(projectId: string): number {
    return (getDb().prepare('SELECT MAX(revision_number) AS n FROM project_brief_revisions WHERE project_id = ?').get(projectId) as { n: number | null }).n ?? 0
}

/** Store a new brief version; identical consecutive content is not a revision. */
export function recordBriefRevision(projectId: string, content: string, context: ProjectChangeContext, createdAt = Date.now()): void {
    const db = getDb()
    const latest = db.prepare('SELECT content FROM project_brief_revisions WHERE project_id = ? ORDER BY revision_number DESC LIMIT 1').get(projectId) as { content: string } | undefined
    if (latest?.content === content) return
    if (!latest && !content) return
    db.prepare(`INSERT INTO project_brief_revisions (id, project_id, revision_number, content, source, conversation_id, agent_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        randomUUID(), projectId, latestRevisionNumber(projectId) + 1, content, context.source,
        context.conversationId ?? null, context.agentId ?? null, createdAt,
    )
}

export function recordTaskEvent(projectId: string, event: {
    kind: 'task_created' | 'task_updated' | 'task_deleted'
    taskId: string
    taskTitle: string
    fromStatus?: ProjectTaskStatus | null
    toStatus?: ProjectTaskStatus | null
}, context: ProjectChangeContext): void {
    getDb().prepare(`INSERT INTO project_events (id, project_id, kind, task_id, task_title, from_status, to_status, source, conversation_id, agent_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        randomUUID(), projectId, event.kind, event.taskId, event.taskTitle, event.fromStatus ?? null, event.toStatus ?? null,
        context.source, context.conversationId ?? null, context.agentId ?? null, Date.now(),
    )
}

export function listBriefRevisions(projectId: string): ProjectBriefRevisionDto[] {
    const rows = getDb().prepare('SELECT * FROM project_brief_revisions WHERE project_id = ? ORDER BY revision_number DESC').all(projectId) as RevisionRow[]
    const latest = rows[0]?.revision_number ?? 0
    return rows.map((row) => rowToRevision(row, latest))
}

export function getBriefRevision(projectId: string, revisionId: string): ProjectBriefRevisionDto | undefined {
    const row = getDb().prepare('SELECT * FROM project_brief_revisions WHERE project_id = ? AND id = ?').get(projectId, revisionId) as RevisionRow | undefined
    return row ? rowToRevision(row, latestRevisionNumber(projectId)) : undefined
}

/**
 * Word-level changes between two brief revisions. Without `fromId` the
 * revision is compared with the one before it (what that update changed).
 */
export function diffBriefRevisions(projectId: string, toId: string, fromId?: string): ProjectDiffSegment[] | undefined {
    const db = getDb()
    const to = db.prepare('SELECT * FROM project_brief_revisions WHERE project_id = ? AND id = ?').get(projectId, toId) as RevisionRow | undefined
    if (!to) return undefined
    const from = fromId
        ? db.prepare('SELECT * FROM project_brief_revisions WHERE project_id = ? AND id = ?').get(projectId, fromId) as RevisionRow | undefined
        : db.prepare('SELECT * FROM project_brief_revisions WHERE project_id = ? AND revision_number < ? ORDER BY revision_number DESC LIMIT 1').get(projectId, to.revision_number) as RevisionRow | undefined
    if (fromId && !from) return undefined
    return diffWordsWithSpace(from?.content ?? '', to.content).map((part) => ({
        type: part.added ? 'added' : part.removed ? 'removed' : 'unchanged',
        text: part.value,
    }))
}

/**
 * The project's history, newest first: brief revisions, task changes, and
 * chats started in the project. `before` pages backwards by timestamp.
 */
export function listProjectTimeline(projectId: string, options: { limit?: number; before?: number } = {}): ProjectTimelineEntry[] {
    const db = getDb()
    const limit = Math.max(1, Math.min(200, options.limit ?? 50))
    const before = options.before ?? Number.MAX_SAFE_INTEGER
    const latest = latestRevisionNumber(projectId)
    const revisions = (db.prepare(`SELECT r.*, c.title AS conversation_title FROM project_brief_revisions r
        LEFT JOIN conversations c ON c.id = r.conversation_id
        WHERE r.project_id = ? AND r.created_at < ? ORDER BY r.created_at DESC LIMIT ?`).all(projectId, before, limit) as Array<RevisionRow & { conversation_title: string | null }>)
        .map((row): ProjectTimelineEntry => ({
            kind: 'brief',
            id: row.id,
            createdAt: row.created_at,
            source: row.source,
            conversationId: row.conversation_id,
            conversationTitle: row.conversation_title,
            agentId: row.agent_id,
            revisionNumber: row.revision_number,
            isCurrent: row.revision_number === latest,
        }))
    const events = (db.prepare(`SELECT e.*, c.title AS conversation_title FROM project_events e
        LEFT JOIN conversations c ON c.id = e.conversation_id
        WHERE e.project_id = ? AND e.created_at < ? ORDER BY e.created_at DESC LIMIT ?`).all(projectId, before, limit) as Array<{
        id: string; kind: 'task_created' | 'task_updated' | 'task_deleted'; task_id: string | null; task_title: string
        from_status: ProjectTaskStatus | null; to_status: ProjectTaskStatus | null; source: ProjectChangeSource
        conversation_id: string | null; agent_id: string | null; created_at: number; conversation_title: string | null
    }>).map((row): ProjectTimelineEntry => ({
        kind: row.kind,
        id: row.id,
        createdAt: row.created_at,
        source: row.source,
        conversationId: row.conversation_id,
        conversationTitle: row.conversation_title,
        agentId: row.agent_id,
        taskId: row.task_id,
        taskTitle: row.task_title,
        fromStatus: row.from_status,
        toStatus: row.to_status,
    }))
    const chats = (db.prepare(`SELECT id, title, agent_id, origin, created_at FROM conversations
        WHERE project_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`).all(projectId, before, limit) as Array<{
        id: string; title: string | null; agent_id: string | null; origin: string; created_at: number
    }>).map((row): ProjectTimelineEntry => ({
        kind: 'chat_started',
        id: `chat:${row.id}`,
        createdAt: row.created_at,
        source: row.origin === 'cron' ? 'ai' : 'user',
        conversationId: row.id,
        conversationTitle: row.title,
        agentId: row.agent_id,
        origin: row.origin,
    }))
    return [...revisions, ...events, ...chats].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}
