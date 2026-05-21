import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'

type BroadcastFn = (event: string, data: unknown) => void

export async function registerNotificationRoutes(
    app: FastifyInstance,
    _broadcast: BroadcastFn
): Promise<void> {
    // GET /api/notifications — list (optionally filtered, ordered newest first)
    app.get<{ Querystring: { unreadOnly?: string } }>('/', async (req) => {
        const db = getDb()
        const unreadOnly = req.query.unreadOnly === 'true'
        const query = unreadOnly
            ? 'SELECT * FROM notifications WHERE read = 0 ORDER BY created_at DESC'
            : 'SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100'
        const rows = db.prepare(query).all() as {
            id: string
            agent_id: string
            conversation_id: string | null
            title: string
            body: string
            severity: string
            read: number
            created_at: number
        }[]

        return rows.map((r) => ({
            id: r.id,
            agentId: r.agent_id,
            conversationId: r.conversation_id,
            title: r.title,
            body: r.body,
            severity: r.severity,
            read: r.read === 1,
            createdAt: r.created_at
        }))
    })

    // PATCH /api/notifications/:id/read — mark one as read
    app.patch<{ Params: { id: string } }>('/:id/read', async (req) => {
        const db = getDb()
        db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(req.params.id)
        return { success: true }
    })

    // POST /api/notifications/read-all — mark all as read
    app.post('/read-all', async () => {
        const db = getDb()
        db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run()
        return { success: true }
    })

    // DELETE /api/notifications/:id — delete one
    app.delete<{ Params: { id: string } }>('/:id', async (req) => {
        const db = getDb()
        db.prepare('DELETE FROM notifications WHERE id = ?').run(req.params.id)
        return { success: true }
    })

    // DELETE /api/notifications — delete all
    app.delete('/', async () => {
        const db = getDb()
        db.prepare('DELETE FROM notifications').run()
        return { success: true }
    })

    // GET /api/notifications/unread-count — quick count of unread
    app.get('/unread-count', async () => {
        const db = getDb()
        const row = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE read = 0').get() as { count: number }
        return { count: row.count }
    })
}
