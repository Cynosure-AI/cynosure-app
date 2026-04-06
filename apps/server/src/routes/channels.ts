import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getChannelManager } from '../core/channels/channel-manager.js'
import { nanoid } from 'nanoid'
import type { ChannelType } from '../core/channels/base.channel.js'

export async function registerChannelRoutes(app: FastifyInstance): Promise<void> {
    const manager = getChannelManager()

    // GET /api/channels — list all channels with runtime status
    app.get('/', async () => {
        const channels = manager.listFromDb()
        return channels.map((ch) => ({
            ...ch,
            status: manager.getStatus(ch.id)
        }))
    })

    // GET /api/channels/:id — get single channel
    app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
        const ch = manager.getFromDb(req.params.id)
        if (!ch) return reply.status(404).send({ error: 'Channel not found' })
        return { ...ch, status: manager.getStatus(ch.id) }
    })

    // POST /api/channels — create a new channel
    app.post<{
        Body: {
            name: string
            type: ChannelType
            agentId: string
            config: Record<string, unknown>
            enabled?: boolean
        }
    }>('/', async (req) => {
        const { name, type, agentId, config, enabled } = req.body
        const db = getDb()
        const id = nanoid()
        const now = Date.now()
        const isEnabled = enabled !== false ? 1 : 0

        db.prepare(
            'INSERT INTO channels (id, name, type, agent_id, config_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(id, name, type, agentId, JSON.stringify(config), isEnabled, now, now)

        const channel = manager.getFromDb(id)!

        // Auto-start if enabled
        if (channel.enabled) {
            await manager.startChannel(channel)
        }

        return { ...channel, status: manager.getStatus(id) }
    })

    // PUT /api/channels/:id — update a channel
    app.put<{
        Params: { id: string }
        Body: {
            name?: string
            agentId?: string
            config?: Record<string, unknown>
            enabled?: boolean
        }
    }>('/:id', async (req, reply) => {
        const db = getDb()
        const existing = manager.getFromDb(req.params.id)
        if (!existing) return reply.status(404).send({ error: 'Channel not found' })

        const { name, agentId, config, enabled } = req.body
        const now = Date.now()

        const updates: string[] = []
        const values: unknown[] = []

        if (name !== undefined) { updates.push('name = ?'); values.push(name) }
        if (agentId !== undefined) { updates.push('agent_id = ?'); values.push(agentId) }
        if (config !== undefined) { updates.push('config_json = ?'); values.push(JSON.stringify(config)) }
        if (enabled !== undefined) { updates.push('enabled = ?'); values.push(enabled ? 1 : 0) }
        updates.push('updated_at = ?'); values.push(now)
        values.push(req.params.id)

        db.prepare(`UPDATE channels SET ${updates.join(', ')} WHERE id = ?`).run(...values)

        const updated = manager.getFromDb(req.params.id)!

        // Restart or stop based on enabled status
        if (updated.enabled) {
            await manager.startChannel(updated)
        } else {
            await manager.stopChannel(updated.id)
        }

        return { ...updated, status: manager.getStatus(updated.id) }
    })

    // DELETE /api/channels/:id — delete a channel
    app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
        const db = getDb()
        const existing = manager.getFromDb(req.params.id)
        if (!existing) return reply.status(404).send({ error: 'Channel not found' })

        await manager.stopChannel(req.params.id)
        db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.id)
        return { success: true }
    })

    // POST /api/channels/:id/toggle — toggle enabled/disabled
    app.post<{ Params: { id: string } }>('/:id/toggle', async (req, reply) => {
        const db = getDb()
        const existing = manager.getFromDb(req.params.id)
        if (!existing) return reply.status(404).send({ error: 'Channel not found' })

        const newEnabled = !existing.enabled
        db.prepare('UPDATE channels SET enabled = ?, updated_at = ? WHERE id = ?')
            .run(newEnabled ? 1 : 0, Date.now(), req.params.id)

        const updated = manager.getFromDb(req.params.id)!

        if (updated.enabled) {
            await manager.startChannel(updated)
        } else {
            await manager.stopChannel(updated.id)
        }

        return { ...updated, status: manager.getStatus(updated.id) }
    })

    // POST /api/channels/:id/test — test connectivity
    app.post<{ Params: { id: string } }>('/:id/test', async (req, reply) => {
        const existing = manager.getFromDb(req.params.id)
        if (!existing) return reply.status(404).send({ error: 'Channel not found' })
        return manager.testChannel(existing)
    })

    // POST /api/channels/test — test a config without saving
    app.post<{
        Body: {
            type: ChannelType
            agentId: string
            config: Record<string, unknown>
        }
    }>('/test', async (req) => {
        const tempConfig = {
            id: 'test',
            name: 'test',
            type: req.body.type,
            agentId: req.body.agentId,
            config: req.body.config,
            enabled: false,
            createdAt: 0,
            updatedAt: 0
        }
        return manager.testChannel(tempConfig)
    })
}
