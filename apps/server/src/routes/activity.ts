import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getAgent } from '../core/agents/agent-store.js'
import { listActiveInstances } from './instances.js'

type ActivityKind = 'instance' | 'artifact' | 'notification' | 'cron' | 'memory' | 'chat' | 'channels'

interface ActivityArtifact {
    href: string
    label: string
    kind: 'file' | 'image' | 'video' | 'audio'
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
    instanceType?: 'chat' | 'multi-agent' | 'cron' | 'channel'
    model?: string | null
    artifacts?: ActivityArtifact[]
}

type ActivityTotalsByKind = Record<ActivityKind, number>

const ARTIFACT_EXTENSIONS = [
    'png',
    'jpg',
    'jpeg',
    'webp',
    'gif',
    'bmp',
    'svg',
    'avif',
    'mp4',
    'webm',
    'mov',
    'mp3',
    'wav',
    'flac',
    'ogg',
    'm4a',
    'aac',
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

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'])

const artifactExtensionPattern = ARTIFACT_EXTENSIONS
    .map((ext) => ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')

const fileArtifactPattern = new RegExp(
    String.raw`/api/files\?path=([^)\]\s"'<>]+)|(?:^|\s)(/[^\s"'<>]+\.(?:${artifactExtensionPattern}))\b`,
    'gi'
)

function clampLimit(value: string | undefined): number {
    const parsed = Number.parseInt(value || '', 10)
    if (!Number.isFinite(parsed)) return 30
    return Math.min(100, Math.max(1, parsed))
}

function clampOffset(value: string | undefined): number {
    const parsed = Number.parseInt(value || '', 10)
    if (!Number.isFinite(parsed)) return 0
    return Math.max(0, parsed)
}

function cleanSearchQuery(value: string | undefined): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : ''
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
            part === 'memory' ||
            part === 'chat' ||
            part === 'channels'
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
    if (url.startsWith('data:')) {
        const mimeSubtype = url.match(/^data:[^/]+\/([^;,]+)/i)?.[1]?.toLowerCase()
        const ext = mimeSubtype === 'jpeg' ? 'jpg' : (mimeSubtype || kind)
        return {
            href: url,
            label: `Generated ${kind}.${ext}`,
            kind,
            ext: ext.toUpperCase(),
        }
    }

    try {
        const parsed = new URL(url, 'http://local')
        const path = parsed.searchParams.get('path')
        if (path) return artifactFromPath(path, kind)
    } catch {
        // Fall through to a plain link.
    }

    let label = url.split('/').pop()?.split('?')[0] || kind
    let ext = (label.split('.').pop() || kind).toUpperCase()
    if (kind === 'video' && !VIDEO_EXTENSIONS.has(ext.toLowerCase())) {
        label = 'Generated video'
        ext = 'VIDEO'
    }
    if (kind === 'audio' && !AUDIO_EXTENSIONS.has(ext.toLowerCase())) {
        label = 'Generated audio'
        ext = 'AUDIO'
    }
    if (kind === 'image' && !IMAGE_EXTENSIONS.has(ext.toLowerCase())) {
        label = 'Generated image'
        ext = 'IMAGE'
    }
    return { href: url, label, kind, ext }
}

function artifactKey(artifact: ActivityArtifact): string {
    try {
        const parsed = new URL(artifact.href, 'http://local')
        const path = parsed.searchParams.get('path')
        if (path) return `path:${path}`
    } catch {
        // Fall through to href-based matching.
    }
    return `href:${artifact.href}`
}

function dedupeArtifacts(artifacts: ActivityArtifact[]): ActivityArtifact[] {
    const seen = new Set<string>()
    const unique: ActivityArtifact[] = []
    for (const artifact of artifacts) {
        const key = artifactKey(artifact)
        if (seen.has(key)) continue
        seen.add(key)
        unique.push(artifact)
    }
    return unique
}

function artifactKindFromPath(path: string): ActivityArtifact['kind'] {
    const ext = (path.split('.').pop() || '').toLowerCase()
    if (IMAGE_EXTENSIONS.has(ext)) return 'image'
    if (VIDEO_EXTENSIONS.has(ext)) return 'video'
    if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
    return 'file'
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
        const artifact = artifactFromPath(rawPath, artifactKindFromPath(rawPath))
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

function activitySearchText(item: ActivityItem): string {
    return [
        item.kind,
        item.title,
        item.description,
        item.agentName,
        item.agentId,
        item.status,
        item.severity,
        item.sourceLabel,
        item.sourceId,
        ...(item.artifacts?.flatMap((artifact) => [
            artifact.label,
            artifact.ext,
            artifact.kind,
        ]) || []),
    ]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(' ')
        .toLowerCase()
}

export async function registerActivityRoutes(app: FastifyInstance): Promise<void> {
    app.get<{ Querystring: { limit?: string; offset?: string; types?: string; search?: string } }>('/', async (req) => {
        const db = getDb()
        const limit = clampLimit(req.query.limit)
        const offset = clampOffset(req.query.offset)
        const searchQuery = cleanSearchQuery(req.query.search)
        const queryLimit = searchQuery ? -1 : Math.max(limit + offset, limit)
        const typeFilter = parseTypeFilter(req.query.types)
        const items: ActivityItem[] = []
        const activeInstancesByIdentity = new Map<string, ReturnType<typeof listActiveInstances>[number]>()
        for (const instance of listActiveInstances()) {
            const identity = instance.conversationId ? `conversation:${instance.conversationId}` : `instance:${instance.id}`
            const existing = activeInstancesByIdentity.get(identity)
            if (!existing || instance.status === 'awaiting-approval') {
                activeInstancesByIdentity.set(identity, instance)
            }
        }
        const activeInstances = [...activeInstancesByIdentity.values()]
        const activeConversationIds = new Set(
            activeInstances
                .filter((instance) => instance.conversationId)
                .map((instance) => instance.conversationId!)
        )

        for (const instance of activeInstances) {
            const typeLabel = instance.type === 'multi-agent'
                ? 'Multi-agent'
                : instance.type.charAt(0).toUpperCase() + instance.type.slice(1)
            items.push({
                id: `instance:${instance.id}`,
                kind: 'instance',
                title: instance.agentName,
                description: instance.model || 'Model unknown',
                createdAt: instance.startedAt,
                agentId: instance.agentId || null,
                agentName: instance.agentName,
                agentIconUrl: instance.agentIconUrl,
                conversationId: instance.conversationId,
                status: instance.status,
                sourceId: instance.id,
                sourceLabel: `${typeLabel} instance`,
                instanceType: instance.type,
                model: instance.model,
            })
        }

        const notificationRows = db.prepare('SELECT id, agent_id, conversation_id, title, body, severity, read, created_at FROM notifications ORDER BY created_at DESC LIMIT ?').all(queryLimit) as {
            id: string
            agent_id: string
            conversation_id: string | null
            title: string
            body: string
            severity: string
            read: number
            created_at: number
        }[]
        for (const row of notificationRows) {
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

        const cronRows = db.prepare(
            "SELECT id, title, agent_id, created_at, updated_at FROM conversations WHERE origin = 'cron' ORDER BY updated_at DESC LIMIT ?"
        ).all(queryLimit) as { id: string; title: string | null; agent_id: string | null; created_at: number; updated_at: number }[]
        for (const row of cronRows) {
            if (activeConversationIds.has(row.id)) continue
            const title = row.title && row.title !== 'New Chat'
                ? row.title
                : 'Cron job finished'
            items.push({
                id: `cron:${row.id}`,
                kind: 'cron',
                title,
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

        const chatRows = db.prepare(
            `SELECT c.id, c.title, c.agent_id, c.created_at, c.updated_at,
                    (SELECT SUBSTR(m.content, 1, 220)
                     FROM messages m
                     WHERE m.conversation_id = c.id AND m.role = 'user'
                     ORDER BY m.created_at DESC
                     LIMIT 1) AS last_user_message
             FROM conversations c
             WHERE c.origin = 'chat'
             ORDER BY c.updated_at DESC
             LIMIT ?`
        ).all(queryLimit) as {
            id: string
            title: string | null
            agent_id: string | null
            created_at: number
            updated_at: number
            last_user_message: string | null
        }[]

        for (const row of chatRows) {
            if (activeConversationIds.has(row.id)) continue
            const title = row.title && row.title !== 'New Chat' ? row.title : 'Chat message'
            items.push({
                id: `chat:${row.id}`,
                kind: 'chat',
                title,
                description: row.last_user_message || 'User chat conversation',
                createdAt: row.updated_at || row.created_at,
                agentId: row.agent_id,
                ...agentInfo(row.agent_id),
                conversationId: row.id,
                status: 'completed',
                sourceId: row.id,
                sourceLabel: 'Chat',
            })
        }

        const channelRows = db.prepare(
            `SELECT c.id, c.title, c.agent_id, c.created_at, c.updated_at,
                    (SELECT SUBSTR(m.content, 1, 220)
                     FROM messages m
                     WHERE m.conversation_id = c.id AND m.role = 'user'
                     ORDER BY m.created_at DESC
                     LIMIT 1) AS last_user_message
             FROM conversations c
             WHERE c.origin = 'channel'
             ORDER BY c.updated_at DESC
             LIMIT ?`
        ).all(queryLimit) as {
            id: string
            title: string | null
            agent_id: string | null
            created_at: number
            updated_at: number
            last_user_message: string | null
        }[]

        for (const row of channelRows) {
            if (activeConversationIds.has(row.id)) continue
            const title = row.title && row.title !== 'New Chat' ? row.title : 'Channel message'
            items.push({
                id: `channels:${row.id}`,
                kind: 'channels',
                title,
                description: row.last_user_message || 'Channel conversation',
                createdAt: row.updated_at || row.created_at,
                agentId: row.agent_id,
                ...agentInfo(row.agent_id),
                conversationId: row.id,
                status: 'completed',
                sourceId: row.id,
                sourceLabel: 'Channel',
            })
        }

        const messageArtifactKeysByConversation = new Map<string, Set<string>>()
        const messageRows = db.prepare(
            `SELECT m.id, m.conversation_id, m.content, m.image_urls_json, m.video_urls_json, m.audio_urls_json, m.created_at, c.title, c.agent_id
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
             WHERE m.role IN ('assistant', 'tool')
             ORDER BY m.created_at DESC
             LIMIT ?`
        ).all(searchQuery ? -1 : Math.max(queryLimit * 3, 100)) as {
            id: string
            conversation_id: string
            content: string
            image_urls_json: string | null
            video_urls_json: string | null
            audio_urls_json: string | null
            created_at: number
            title: string | null
            agent_id: string | null
        }[]

        for (const row of messageRows) {
            const artifacts = dedupeArtifacts([
                ...parseJsonStringArray(row.image_urls_json).map((url) => artifactFromUrl(url, 'image')),
                ...parseJsonStringArray(row.video_urls_json).map((url) => artifactFromUrl(url, 'video')),
                ...parseJsonStringArray(row.audio_urls_json).map((url) => artifactFromUrl(url, 'audio')),
                ...fileArtifactsFromText(row.content),
            ])
            if (!artifacts.length) continue
            let conversationKeys = messageArtifactKeysByConversation.get(row.conversation_id)
            if (!conversationKeys) {
                conversationKeys = new Set<string>()
                messageArtifactKeysByConversation.set(row.conversation_id, conversationKeys)
            }
            const visibleArtifacts = artifacts.filter((artifact) => !conversationKeys.has(artifactKey(artifact)))
            if (!visibleArtifacts.length) continue
            for (const artifact of visibleArtifacts) {
                conversationKeys.add(artifactKey(artifact))
            }
            items.push({
                id: `artifact:${row.id}`,
                kind: 'artifact',
                title: visibleArtifacts.length === 1 ? `Generated ${visibleArtifacts[0].label}` : `Generated ${visibleArtifacts.length} artifacts`,
                description: row.title || 'Assistant response',
                createdAt: row.created_at,
                agentId: row.agent_id,
                ...agentInfo(row.agent_id),
                conversationId: row.conversation_id,
                sourceId: row.id,
                sourceLabel: 'Artifact',
                artifacts: visibleArtifacts,
            })
        }

        const memoryRows = db.prepare(
            `SELECT mfi.space_id, mfi.file_name, mfi.chunk_count, mfi.created_at, mfi.last_indexed_at, mfi.entity_indexed_at, ms.name AS space_name
             FROM memory_file_index mfi
             LEFT JOIN memory_spaces ms ON ms.id = mfi.space_id
             ORDER BY MAX(mfi.last_indexed_at, mfi.entity_indexed_at, mfi.created_at) DESC
             LIMIT ?`
        ).all(queryLimit) as {
            space_id: string
            file_name: string
            chunk_count: number
            created_at: number
            last_indexed_at: number
            entity_indexed_at: number
            space_name: string | null
        }[]

        for (const row of memoryRows) {
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

        const searched = items.filter((item) => !searchQuery || activitySearchText(item).includes(searchQuery))
        const totalsByKind = searched.reduce<ActivityTotalsByKind>((totals, item) => {
            totals[item.kind] += 1
            return totals
        }, {
            instance: 0,
            artifact: 0,
            notification: 0,
            cron: 0,
            memory: 0,
            chat: 0,
            channels: 0,
        })
        const filtered = searched.filter((item) => !typeFilter || typeFilter.has(item.kind))
        const sorted = filtered
            .sort((a, b) => {
                const aActive = a.status === 'running' || a.status === 'awaiting-approval'
                const bActive = b.status === 'running' || b.status === 'awaiting-approval'
                const aActiveInstance = a.kind === 'instance' && aActive
                const bActiveInstance = b.kind === 'instance' && bActive
                if (aActiveInstance !== bActiveInstance) return aActiveInstance ? -1 : 1
                if (aActive !== bActive) return aActive ? -1 : 1
                return b.createdAt - a.createdAt
            })
        const page = sorted.slice(offset, offset + limit)

        return { items: page, hasMore: offset + limit < sorted.length, total: sorted.length, totalsByKind }
    })
}
