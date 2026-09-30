import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'

type BroadcastFn = (event: string, data: unknown) => void

export type NotificationPriority = 'notice' | 'action' | 'alert'

export interface AppNotificationRecord {
    id: string
    agentId: string
    conversationId: string | null
    title: string
    body: string
    priority: NotificationPriority
    read: boolean
    createdAt: number
}

export interface CreateAppNotificationInput {
    agentId: string
    conversationId: string | null
    title: string
    body: string
    broadcast: BroadcastFn
}

type NotificationRow = {
    id: string
    agent_id: string
    conversation_id: string | null
    title: string
    body: string
    severity: string
    read: number
    created_at: number
}

export function normalizeNotificationPriority(value?: string): NotificationPriority {
    switch (value) {
        case 'critical':
        case 'alert':
            return 'alert'
        case 'warning':
        case 'action':
            return 'action'
        default:
            return 'notice'
    }
}

export function mapNotificationRow(row: NotificationRow): AppNotificationRecord {
    return {
        id: row.id,
        agentId: row.agent_id,
        conversationId: row.conversation_id,
        title: row.title,
        body: row.body,
        priority: normalizeNotificationPriority(row.severity),
        read: row.read === 1,
        createdAt: row.created_at,
    }
}

export function createAppNotification(input: CreateAppNotificationInput): AppNotificationRecord {
    const db = getDb()
    const id = nanoid()
    const now = Date.now()
    const priority: NotificationPriority = 'notice'

    db.prepare(
        `INSERT INTO notifications (id, agent_id, conversation_id, title, body, severity, read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.agentId, input.conversationId, input.title, input.body, priority, 0, now)

    const notification = mapNotificationRow({
        id,
        agent_id: input.agentId,
        conversation_id: input.conversationId,
        title: input.title,
        body: input.body,
        severity: priority,
        read: 0,
        created_at: now,
    })

    input.broadcast('notification:created', notification)

    return notification
}
