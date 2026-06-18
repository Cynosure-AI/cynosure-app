import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getAgent } from '../core/agents/agent-store.js'
import { listMemoryIndexJobs } from '../core/memory/memory-index-jobs.js'
import { listActiveInstances } from './instances.js'

type ActivityKind = 'instance' | 'artifact' | 'notification' | 'cron' | 'memory'

interface ActivityArtifact {
    href: string
    label: string
    kind: 'file' | 'image' | 'video'
    ext: string
}

interface ActivityItem {
    id: string
    kind: ActivityKind
    title: string
    description: string
    createdAt: number
    agentId: string | null
    agentName: string | null
    agentIconUrl: string | null
    conversationId: string | null
    status?: string
    severity?: string
    sourceId?: string
    sourceLabel?: string
    artifacts?: ActivityArtifact[]
}

const ARTIFACT_EXTENSIONS = [
    'pdf',
    'doc',
    'docx',
    'odt',
    'rtf',
    'txt',
    'md',
    'csv',
    'tsv',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
    'zip',
    'json',
]

const artifactExtensionPattern = ARTIFACT_EXTENSIONS
    .map((ext) => ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')

const fileArtifactPattern = new RegExp(
    String.raw`/api/files\?path=([^)\]\s"'<>]+)|(?:^|\s)(/[^\s"'<>]+\.(?:${artifactExtensionPattern}))\b`,
    'gi'
)

function clampLimit(value: string | undefined): number {
    const parsed = Number.parseInt(value || '', 10)
    if (!Number.isFinite(parsed)) return 100
    return Math.min(200, Math.max(20, parsed))
}

function parseTypeFilter(value: string | undefined): Set<ActivityKind> | null {
    if (!value) return null
    const kinds = value
        .split(',')
        .map((part) => part.trim())
        .filter((part): part is ActivityKind =>
            part === 'instance' ||
            part === 'artifact' ||
            part === 'notification' ||
            part === 'cron' ||
            part === 'memory'
        )
    return kinds.length ? new Set(kinds) : null
}

function parseJsonStringArray(value: string | null): string[] {
    if (!value) return []
    try {
        const parsed = JSON.parse(value) as unknown
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    } catch {
        return []
    }
}

function artifactFromPath(path: string, kind: ActivityArtifact['kind']): ActivityArtifact {
    const label = path.split('/').pop() || (kind === 'file' ? 'file' : kind)
    const ext = (label.split('.').pop() || kind).toUpperCase()
    return {
        href: `/api/files?path=${encodeURIComponent(path)}`,
        label,
        kind,
        ext,
    }
}

function artifactFromUrl(url: string, kind: ActivityArtifact['kind']): ActivityArtifact {
    try {
        const parsed = new URL(url, 'http://local')
        const path = parsed.searchParams.get('path')
        if (path) return artifactFromPath(path, kind)
    } catch {
        // Fall through to a plain link.
    }

    const label = url.split('/').pop()?.split('?')[0] || kind
    const ext = (label.split('.').pop() || kind).toUpperCase()
    return { href: url, label, kind, ext }
}

function fileArtifactsFromText(text: string): ActivityArtifact[] {
    const artifacts: ActivityArtifact[] = []
    const seen = new Set<string>()
    let match: RegExpExecArray | null
    fileArtifactPattern.lastIndex = 0

    while ((match = fileArtifactPattern.exec(text || ''))) {
        const encodedPath = match[1]
        const rawPath = encodedPath ? decodeURIComponent(encodedPath) : match[2]
        if (!rawPath) continue
        const artifact = artifactFromPath(rawPath, 'file')
        if (seen.has(artifact.href)) continue
        seen.add(artifact.href)
        artifacts.push(artifact)
    }

    return artifacts
}

function agentInfo(agentId: string | null): Pick<ActivityItem, 'agentName' | 'agentIconUrl'> {
    const agent = agentId ? getAgent(agentId) : null
    return {
        agentName: agent?.name || null,
        agentIconUrl: agent?.iconUrl || null,
    }
}

export async function registerActivityRoutes(app: FastifyInstance): Promise<void> {
    app.get<{ Querystring: { limit?: string; types?: string } }>('/', async (req) => {
        const db = getDb()
        const limit = clampLimit(req.query.limit)
        const typeFilter = parseTypeFilter(req.query.types)
        const includes = (kind: ActivityKind) => !typeFilter || typeFilter.has(kind)
        const items: ActivityItem[] = []

        if (includes('instance')) {
            for (const instance of listActiveInstances()) {
                items.push({
                    id: `instance:${instance.id}`,
                    kind: 'instance',
                    title: instance.status === 'awaiting-approval'
                        ? `${instance.agentName} needs approval`
                        : `${instance.agentName} is running`,
                    description: instance.model || instance.type,
                    createdAt: instance.startedAt,
                    agentId: instance.agentId || null,
                    agentName: instance.agentName,
                    agentIconUrl: instance.agentIconUrl,
                    conversationId: instance.conversationId,
                    status: instance.status,
                    sourceId: instance.id,
                    sourceLabel: instance.type,
                })
            }
        }

        if (includes('notification')) {
            const rows = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?').all(limit) as {
                id: string
                agent_id: string
                conversation_id: string | null
                title: string
                body: string
                severity: string
                read: number
                created_at: number
            }[]
            for (const row of rows) {
                items.push({
                    id: `notification:${row.id}`,
                    kind: 'notification',
                    title: row.title,
                    description: row.body,
                    createdAt: row.created_at,
                    agentId: row.agent_id || null,
                    ...agentInfo(row.agent_id || null),
                    conversationId: row.conversation_id,
                    severity: row.severity,
                    status: row.read === 1 ? 'read' : 'unread',
                    sourceId: row.id,
                    sourceLabel: 'Notification',
                })
            }
        }

        if (includes('cron')) {
            const rows = db.prepare(
                "SELECT id, title, agent_id, updated_at FROM conversations WHERE origin = 'cron' ORDER BY updated_at DESC LIMIT ?"
            ).all(limit) as { id: string; title: string | null; agent_id: string | null; updated_at: number }[]
            for (const row of rows) {
                items.push({
                    id: `cron:${row.id}`,
                    kind: 'cron',
                    title: row.title || 'Cron job finished',
                    description: 'Scheduled run completed',
                    createdAt: row.updated_at,
                    agentId: row.agent_id,
                    ...agentInfo(row.agent_id),
                    conversationId: row.id,
                    status: 'completed',
                    sourceId: row.id,
                    sourceLabel: 'Cron',
                })
            }
        }

        if (includes('artifact')) {
            const messageRows = db.prepare(
                `SELECT m.id, m.conversation_id, m.content, m.image_urls_json, m.video_urls_json, m.created_at, c.title, c.agent_id
                 FROM messages m
                 JOIN conversations c ON c.id = m.conversation_id
                 WHERE m.role = 'assistant'
                 ORDER BY m.created_at DESC
                 LIMIT ?`
            ).all(Math.max(limit * 3, 100)) as {
                id: string
                conversation_id: string
                content: string
                image_urls_json: string | null
                video_urls_json: string | null
                created_at: number
                title: string | null
                agent_id: string | null
            }[]

            for (const row of messageRows) {
                const artifacts = [
                    ...parseJsonStringArray(row.image_urls_json).map((url) => artifactFromUrl(url, 'image')),
                    ...parseJsonStringArray(row.video_urls_json).map((url) => artifactFromUrl(url, 'video')),
                    ...fileArtifactsFromText(row.content),
                ]
                if (!artifacts.length) continue
                items.push({
                    id: `artifact:${row.id}`,
                    kind: 'artifact',
                    title: artifacts.length === 1 ? `Generated ${artifacts[0].label}` : `Generated ${artifacts.length} artifacts`,
                    description: row.title || 'Assistant response',
                    createdAt: row.created_at,
                    agentId: row.agent_id,
                    ...agentInfo(row.agent_id),
                    conversationId: row.conversation_id,
                    sourceId: row.id,
                    sourceLabel: 'Artifact',
                    artifacts,
                })
            }

            const stepRows = db.prepare(
                `SELECT s.id, s.conversation_id, s.results_json, s.created_at, c.title, c.agent_id
                 FROM execution_steps s
                 JOIN conversations c ON c.id = s.conversation_id
                 WHERE s.results_json IS NOT NULL AND s.results_json != ''
                 ORDER BY s.created_at DESC
                 LIMIT ?`
            ).all(Math.max(limit * 2, 100)) as {
                id: string
                conversation_id: string
                results_json: string
                created_at: number
                title: string | null
                agent_id: string | null
            }[]

            for (const row of stepRows) {
                const artifacts = fileArtifactsFromText(row.results_json)
                if (!artifacts.length) continue
                items.push({
                    id: `artifact-step:${row.id}`,
                    kind: 'artifact',
                    title: artifacts.length === 1 ? `Generated ${artifacts[0].label}` : `Generated ${artifacts.length} artifacts`,
                    description: row.title || 'Tool output',
                    createdAt: row.created_at,
                    agentId: row.agent_id,
                    ...agentInfo(row.agent_id),
                    conversationId: row.conversation_id,
                    sourceId: row.id,
                    sourceLabel: 'Tool artifact',
                    artifacts,
                })
            }
        }

        if (includes('memory')) {
            for (const job of listMemoryIndexJobs()) {
                if (job.status === 'running') continue
                items.push({
                    id: `memory-job:${job.id}`,
                    kind: 'memory',
                    title: job.kind === 'entity-index' ? `Extracted entities from ${job.fileName}` : `Indexed ${job.fileName}`,
                    description: job.error || (job.status === 'completed' ? 'Memory job completed' : `Memory job ${job.status}`),
                    createdAt: job.updatedAt,
                    agentId: null,
                    agentName: null,
                    agentIconUrl: null,
                    conversationId: null,
                    status: job.status,
                    sourceId: job.id,
                    sourceLabel: job.kind,
                })
            }

            const rows = db.prepare(
                `SELECT mfi.space_id, mfi.file_name, mfi.chunk_count, mfi.created_at, mfi.last_indexed_at, mfi.entity_indexed_at, ms.name AS space_name
                 FROM memory_file_index mfi
                 LEFT JOIN memory_spaces ms ON ms.id = mfi.space_id
                 ORDER BY MAX(mfi.last_indexed_at, mfi.entity_indexed_at, mfi.created_at) DESC
                 LIMIT ?`
            ).all(limit) as {
                space_id: string
                file_name: string
                chunk_count: number
                created_at: number
                last_indexed_at: number
                entity_indexed_at: number
                space_name: string | null
            }[]

            for (const row of rows) {
                const createdAt = Math.max(row.last_indexed_at || 0, row.entity_indexed_at || 0, row.created_at || 0)
                if (!createdAt) continue
                const entityIndexed = row.entity_indexed_at && row.entity_indexed_at >= row.last_indexed_at
                items.push({
                    id: `memory-file:${row.space_id}:${row.file_name}:${createdAt}`,
                    kind: 'memory',
                    title: entityIndexed ? `Updated memory graph for ${row.file_name}` : `Indexed memory file ${row.file_name}`,
                    description: `${row.space_name || 'Memory folder'} · ${row.chunk_count} chunk${row.chunk_count === 1 ? '' : 's'}`,
                    createdAt,
                    agentId: null,
                    agentName: null,
                    agentIconUrl: null,
                    conversationId: null,
                    status: 'completed',
                    sourceId: row.space_id,
                    sourceLabel: 'Memory',
                })
            }
        }

        const sorted = items
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, limit)

        return { items: sorted }
    })
}
