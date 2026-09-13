import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../../../src/db/database.js'
import { registerMemoryRoutes } from '../../../src/routes/memory.js'
import { registerActivityRoutes } from '../../../src/routes/activity.js'
import { getGateway } from '../../../src/core/gateway/gateway.js'
import { getDreamConfig } from '../../../src/core/memory/dream-store.js'

let directory: string
let app: ReturnType<typeof Fastify>
beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-dream-routes-'))
    process.env.CYNOSURE_DATA_DIR = directory
    app = Fastify()
    await app.register((instance: FastifyInstance) => registerMemoryRoutes(instance, () => undefined), { prefix: '/api/memory' })
    await app.register(registerActivityRoutes, { prefix: '/api/activity' })
    getGateway().registerProvider({ id: 'dream-test', name: 'Dream test', type: 'ollama', baseUrl: 'http://localhost:11434', defaultModel: 'model', availableModels: ['model'], supportsStreaming: true, supportsToolCalls: true, supportsVision: false })
})
afterEach(async () => {
    await app.close()
    getGateway().removeProvider('dream-test')
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    rmSync(directory, { recursive: true, force: true })
})
test('Dream config defaults off and validates opt-in model selection', async () => {
    expect((await app.inject('/api/memory/dream/config')).json()).toMatchObject({ enabled: false })
    for (const payload of [{}, { enabled: 'true', providerId: 'dream-test', model: 'model' }, { enabled: true, providerId: 'missing', model: 'model' }, { enabled: true, providerId: 'dream-test', model: ' ' }]) {
        expect((await app.inject({ method: 'POST', url: '/api/memory/dream/configure', payload })).statusCode).toBe(400)
    }
    const response = await app.inject({ method: 'POST', url: '/api/memory/dream/configure', payload: { enabled: true, providerId: ' dream-test ', model: ' model ' } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ enabled: true, providerId: 'dream-test', model: 'model' })
    expect((await app.inject('/api/memory/dream/config')).json()).toEqual(response.json())
})
async function seedRun(status = 'completed') {
    await app.inject({ method: 'POST', url: '/api/memory/dream/configure', payload: { enabled: true, providerId: 'dream-test', model: 'model' } })
    const now = Date.now()
    getDb().prepare("INSERT INTO conversations(id, title, origin, created_at, updated_at) VALUES ('chat', 'My preferences', 'chat', ?, ?)").run(now, now)
    getDb().prepare(`INSERT INTO dream_runs(id, conversation_id, window_id, status, provider_id, model, input_json, reviewed_count, changes_json, created_at, updated_at)
        VALUES ('run', 'chat', ?, ?, 'dream-test', 'model', '{}', 2, ?, ?, ?)`)
        .run(getDreamConfig().windowId, status, JSON.stringify([{ key: 'change', tool: 'memory_append', output: 'Updated preferences.md' }]), now, now)
}
test('activity exposes a single filterable Dream entry with memory changes and a conversation link', async () => {
    await seedRun()
    const response = await app.inject('/api/activity?types=dream&search=Dream')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ total: 1, totalsByKind: { dream: 1 }, items: [{ id: 'dream:run', kind: 'dream', sourceId: 'run', conversationId: 'chat', conversationTitle: 'My preferences', status: 'completed', dreamChanges: [{ tool: 'memory_append', output: 'Updated preferences.md' }] }] })
    expect(response.json().items[0].description).toContain('2 message excerpts reviewed')
    expect((await app.inject('/api/activity?types=memory')).json().items).toEqual([])
})
test('individual cancellation and Stop All cancel Dream runs', async () => {
    await seedRun('running')
    expect((await app.inject({ method: 'POST', url: '/api/memory/dream/runs/run/cancel' })).statusCode).toBe(200)
    expect((await app.inject('/api/activity?types=dream')).json().items[0].status).toBe('cancelled')
    expect((await app.inject({ method: 'POST', url: '/api/memory/dream/runs/run/cancel' })).statusCode).toBe(409)
    getDb().prepare("UPDATE dream_runs SET status = 'running' WHERE id = 'run'").run()
    const stopped = (await app.inject({ method: 'POST', url: '/api/activity/stop-all' })).json()
    expect(stopped.counts.dreamRuns).toBe(1)
    expect(stopped.total).toBe(1)
})
test('disabling Dream cancels pending retries and persists the disabled state', async () => {
    await seedRun('failed')
    const response = await app.inject({ method: 'POST', url: '/api/memory/dream/configure', payload: { enabled: false, providerId: 'dream-test', model: 'model' } })
    expect(response.json().enabled).toBe(false)
    expect((await app.inject('/api/activity?types=dream')).json().items[0].status).toBe('cancelled')
})
