import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const gateway = vi.hoisted(() => ({ getModelInfo: vi.fn() }))
vi.mock('../core/gateway/gateway.js', () => ({ getGateway: () => gateway }))
vi.mock('../core/model-dev-fetcher.js', () => ({
    ensurePricingLoaded: async () => {},
    // models.dev knows the slow model at a different price than the gateway.
    getModelCost: (_provider: string, model: string) => model === 'slow/model' ? { input: 1, output: 1 } : null,
}))

import { closeDb, getDb } from '../db/database.js'
import { registerMetricsRoutes } from './metrics.js'

describe('usage metrics gateway pricing', () => {
    let directory = ''

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'cynosure-metrics-'))
        process.env.CYNOSURE_DATA_DIR = directory
        gateway.getModelInfo.mockReset()
        const db = getDb()
        const now = Date.now()
        db.prepare(`INSERT INTO providers (id, name, type, base_url, default_model, config_json, created_at, updated_at)
            VALUES ('router', 'Router', 'openrouter', 'https://example.com', 'fast/model', '{}', ?, ?)`).run(now, now)
        db.prepare("INSERT INTO conversations (id, created_at, updated_at) VALUES ('chat', ?, ?)").run(now, now)
        const insert = db.prepare(`INSERT INTO messages (id, conversation_id, role, content, provider, model, prompt_tokens, completion_tokens, created_at)
            VALUES (?, 'chat', 'assistant', 'reply', 'router', ?, 1000000, 0, ?)`)
        insert.run('fast', 'fast/model', now)
        insert.run('slow', 'slow/model', now)
    })

    afterEach(async () => {
        closeDb()
        delete process.env.CYNOSURE_DATA_DIR
        await rm(directory, { recursive: true, force: true })
    })

    async function costs(): Promise<Record<string, number | null>> {
        const app = Fastify()
        await app.register(registerMetricsRoutes, { prefix: '/api/metrics' })
        const response = await app.inject({ method: 'GET', url: '/api/metrics?days=1' })
        await app.close()
        const body = response.json() as { modelUsage: Array<{ model: string; estimatedCost: number | null }> }
        return Object.fromEntries(body.modelUsage.map((usage) => [usage.model, usage.estimatedCost]))
    }

    test('does not hold the page on a slow first price lookup and reuses prices afterwards', async () => {
        let finishSlowLookup: (() => void) | undefined
        gateway.getModelInfo.mockImplementation(async (model: string) => {
            if (model === 'slow/model') await new Promise<void>((resolve) => { finishSlowLookup = resolve })
            return { id: model, pricing: { prompt: model === 'slow/model' ? 0.000003 : 0.000002, completion: 0 } }
        })

        const started = Date.now()
        // The fast model has its gateway price; the slow one falls back to models.dev for now.
        expect(await costs()).toEqual({ 'fast/model': 2, 'slow/model': 1 })
        expect(Date.now() - started).toBeLessThan(4_000)
        // A visit while that lookup is still running does not wait for it again.
        const again = Date.now()
        expect(await costs()).toEqual({ 'fast/model': 2, 'slow/model': 1 })
        expect(Date.now() - again).toBeLessThan(500)

        finishSlowLookup?.()
        await vi.waitFor(() => expect(gateway.getModelInfo).toHaveBeenCalledTimes(2))
        await new Promise((resolve) => setImmediate(resolve))
        expect(await costs()).toEqual({ 'fast/model': 2, 'slow/model': 3 })
        // Both prices came from the cache on the second visit.
        expect(gateway.getModelInfo).toHaveBeenCalledTimes(2)
    }, 10_000)
})
