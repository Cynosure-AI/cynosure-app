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
    scheduledAt: number | null
    deliveredAt: number | null
}

export interface CreateAppNotificationInput {
    agentId: string
    conversationId: string | null
    title: string
    body: string
    priority?: string
    showAt?: number | string | null
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
    scheduled_at: number | null
    delivered_at: number | null
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const MAX_TIMEOUT_MS = 2_147_483_647

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

function normalizeShowAt(value: number | string | null | undefined): number | null {
    if (value === undefined || value === null || value === '') return null
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0) return null
        return value < 10_000_000_000 ? value * 1000 : value
    }

    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric

    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
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
        scheduledAt: row.scheduled_at,
        deliveredAt: row.delivered_at,
    }
}

export function createAppNotification(input: CreateAppNotificationInput): AppNotificationRecord {
    const db = getDb()
    const id = nanoid()
    const now = Date.now()
    const priority = normalizeNotificationPriority(input.priority)
    const requestedShowAt = normalizeShowAt(input.showAt)
    const scheduledAt = requestedShowAt && requestedShowAt > now ? requestedShowAt : null
    const deliveredAt = scheduledAt ? null : now
    const read = scheduledAt ? 1 : 0

    db.prepare(
        `INSERT INTO notifications (id, agent_id, conversation_id, title, body, severity, read, scheduled_at, delivered_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.agentId, input.conversationId, input.title, input.body, priority, read, scheduledAt, deliveredAt, now)

    const notification = mapNotificationRow({
        id,
        agent_id: input.agentId,
        conversation_id: input.conversationId,
        title: input.title,
        body: input.body,
        severity: priority,
        read,
        created_at: now,
        scheduled_at: scheduledAt,
        delivered_at: deliveredAt,
    })

    if (scheduledAt) {
        scheduleNotificationDelivery(id, scheduledAt, input.broadcast)
    } else {
        input.broadcast('notification:created', notification)
    }

    return notification
}

export function schedulePendingNotifications(broadcast: BroadcastFn): void {
    const db = getDb()
    const rows = db.prepare(
        'SELECT * FROM notifications WHERE scheduled_at IS NOT NULL AND delivered_at IS NULL ORDER BY scheduled_at ASC'
    ).all() as NotificationRow[]

    for (const row of rows) {
        scheduleNotificationDelivery(row.id, row.scheduled_at ?? Date.now(), broadcast)
    }
}

export function cancelScheduledNotification(id: string): void {
    const timer = timers.get(id)
    if (!timer) return
    clearTimeout(timer)
    timers.delete(id)
}

function scheduleNotificationDelivery(id: string, scheduledAt: number, broadcast: BroadcastFn): void {
    cancelScheduledNotification(id)

    const delay = Math.max(0, scheduledAt - Date.now())
    const timer = setTimeout(() => {
        timers.delete(id)
        if (delay > MAX_TIMEOUT_MS) {
            scheduleNotificationDelivery(id, scheduledAt, broadcast)
            return
        }
        deliverScheduledNotification(id, broadcast)
    }, Math.min(delay, MAX_TIMEOUT_MS))
    timers.set(id, timer)
}

function deliverScheduledNotification(id: string, broadcast: BroadcastFn): void {
    const db = getDb()
    const now = Date.now()
    const result = db.prepare(
        'UPDATE notifications SET delivered_at = ?, read = 0 WHERE id = ? AND delivered_at IS NULL'
    ).run(now, id)

    if (result.changes === 0) return

    const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as NotificationRow | undefined
    if (!row) return
    broadcast('notification:created', mapNotificationRow(row))
}
