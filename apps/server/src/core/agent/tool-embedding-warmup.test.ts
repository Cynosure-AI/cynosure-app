import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../../db/database.js'
import { getToolRegistry } from '../tools/tool-registry.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { cancelMemoryIndexJob, listMemoryIndexJobs } from '../memory/memory-index-jobs.js'

const embedding = vi.hoisted(() => ({
    model: 'test-model',
    embedBatch: vi.fn(),
    embed: vi.fn(),
}))
vi.mock('../memory/embedding.js', () => ({
    getEmbeddingService: () => ({
        profile: { fingerprint: `test:${embedding.model}` },
        getConfig: () => ({ providerId: 'test-provider' }),
        getModelName: () => embedding.model,
        getDimensions: () => 2,
        embedBatch: embedding.embedBatch,
        embed: embedding.embed,
    }),
}))

import { planToolEmbeddingWarmup, routeTools } from './tool-router.js'
import { startToolEmbeddingWarmup } from './tool-embedding-warmup.js'

let directory: string
let stop: (() => Promise<void>) | undefined
const registry = getToolRegistry()
function register(name = 'search', description = 'Search documents', namespace = 'mcp:test') {
    registry.register({ name, description, parameters: {}, timeout: 1_000, execute: async () => ({ success: true, output: '' }) }, { id: namespace, label: namespace })
}
const vector = () => ({ vector: [1, 0], dimensions: 2, model: embedding.model })

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-tool-warmup-'))
    process.env.CYNOSURE_DATA_DIR = directory
    getDb()
})
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    for (const { namespace } of registry.getAllWithNamespaces()) registry.unregisterByNamespace(namespace.id)
    getDb().prepare('DELETE FROM tool_router_embeddings').run()
    getDb().prepare('DELETE FROM tool_router_tool_embeddings').run()
    embedding.model = 'test-model'
    embedding.embedBatch.mockReset().mockImplementation(async (texts: string[]) => texts.map(vector))
    embedding.embed.mockReset().mockImplementation(async () => vector())
})
afterEach(async () => {
    await stop?.()
    stop = undefined
    vi.useRealTimers()
})
afterAll(() => {
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    rmSync(directory, { recursive: true, force: true })
})

async function waitForWarmCache() {
    await vi.waitFor(() => {
        expect(planToolEmbeddingWarmup().count).toBe(0)
        expect(listMemoryIndexJobs().filter(job => ['running', 'queued'].includes(job.status))).toHaveLength(0)
    })
}

describe('background tool embeddings', () => {
    test('coalesces registry changes, reports progress, and skips unchanged embeddings', async () => {
        stop = startToolEmbeddingWarmup()
        register()
        register('read', 'Read documents')
        await vi.advanceTimersByTimeAsync(1_000)
        await waitForWarmCache()
        expect(embedding.embedBatch).toHaveBeenCalledTimes(1)
        expect(embedding.embedBatch.mock.calls[0][0]).toHaveLength(3)
        expect(listMemoryIndexJobs()[0]).toMatchObject({ kind: 'tool-embeddings', status: 'completed', progressCurrent: 3, progressTotal: 3 })
        register('read', 'Read documents')
        await vi.advanceTimersByTimeAsync(1_000)
        expect(embedding.embedBatch).toHaveBeenCalledTimes(1)
        register('read', 'Read updated documents')
        await vi.advanceTimersByTimeAsync(1_000)
        await waitForWarmCache()
        expect(embedding.embedBatch.mock.calls[1][0]).toHaveLength(2) // changed tool + namespace
    })

    test('foreground routing reuses warm tools even when callable aliases differ', async () => {
        register()
        register('search', 'Search other documents', 'mcp:other')
        const plan = planToolEmbeddingWarmup()
        await plan.run(new AbortController().signal, () => {}, () => true)
        embedding.embedBatch.mockClear()
        const tools = registry.resolveForExecution(['mcp:test::search'])
        await routeTools({ userQuery: 'search documents', allTools: tools })
        expect(embedding.embed).toHaveBeenCalledOnce() // query still needs an embedding
        expect(embedding.embedBatch).not.toHaveBeenCalled()
        expect(planToolEmbeddingWarmup().count).toBe(0) // foreground did not prune other namespace
    })

    test('reuses full namespace embeddings when routing a filtered catalogue', async () => {
        for (let i = 0; i < 9; i++) {
            register(`read_${i}`, 'Read documents', `mcp:group-${i}`)
            register(`write_${i}`, 'Write documents', `mcp:group-${i}`)
        }
        await planToolEmbeddingWarmup().run(new AbortController().signal, () => {}, () => true)
        expect(embedding.embedBatch.mock.calls.every(([texts]) => texts.length <= 8)).toBe(true)
        embedding.embedBatch.mockClear()
        await routeTools({
            userQuery: 'read documents',
            allTools: registry.getToolDefinitions().filter(tool => tool.name.startsWith('read_')),
        })
        expect(embedding.embedBatch).toHaveBeenCalledTimes(1)
        expect(embedding.embedBatch.mock.calls[0][0]).toEqual(['read documents'])
        expect(planToolEmbeddingWarmup().count).toBe(0)
    })

    test('cancels active warmup and does not restart it on the periodic sweep', async () => {
        register()
        embedding.embedBatch.mockImplementation((_texts: string[], signal: AbortSignal) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }))
        stop = startToolEmbeddingWarmup()
        await vi.advanceTimersByTimeAsync(1_000)
        const job = listMemoryIndexJobs()[0]
        expect(job.status).toBe('running')
        cancelMemoryIndexJob(job.id)
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000)
        expect(embedding.embedBatch).toHaveBeenCalledTimes(1)
        expect(listMemoryIndexJobs().find(item => item.id === job.id)?.status).toBe('cancelled')
        expect(planToolEmbeddingWarmup().count).toBe(2)
    })

    test('warms a new embedding model and repairs evicted cache entries', async () => {
        register()
        stop = startToolEmbeddingWarmup()
        await vi.advanceTimersByTimeAsync(1_000)
        await waitForWarmCache()
        embedding.model = 'replacement-model'
        getEventBus().emit('embedding:configured')
        await vi.advanceTimersByTimeAsync(1_000)
        await waitForWarmCache()
        expect(embedding.embedBatch).toHaveBeenCalledTimes(2)
        getDb().prepare('DELETE FROM tool_router_tool_embeddings').run()
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000)
        await waitForWarmCache()
        expect(embedding.embedBatch).toHaveBeenCalledTimes(3)
    })

    test('finishes warming the new model when an old in-flight request fails', async () => {
        register()
        let rejectOld!: (error: Error) => void
        embedding.embedBatch.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject }))
        stop = startToolEmbeddingWarmup()
        await vi.advanceTimersByTimeAsync(1_000)
        const jobId = listMemoryIndexJobs()[0].id
        embedding.model = 'replacement-model'
        getEventBus().emit('embedding:configured')
        rejectOld(new Error('Old provider disconnected'))
        await waitForWarmCache()
        expect(listMemoryIndexJobs().find(job => job.id === jobId)?.status).toBe('completed')
        expect(embedding.embedBatch).toHaveBeenCalledTimes(2)
        expect(getDb().prepare("SELECT count(*) AS n FROM tool_router_tool_embeddings WHERE embedding_model = 'test-model'").get()).toEqual({ n: 0 })
    })

    test('discards stale in-flight results and respects cancellation', async () => {
        register()
        let resolve!: (value: ReturnType<typeof vector>[]) => void
        embedding.embedBatch.mockImplementationOnce(() => new Promise(r => { resolve = r }))
        let current = true
        const plan = planToolEmbeddingWarmup()
        const run = plan.run(new AbortController().signal, () => {}, () => current)
        current = false
        resolve([vector(), vector()])
        await run
        expect(planToolEmbeddingWarmup().count).toBe(2)
        const controller = new AbortController()
        controller.abort()
        await expect(plan.run(controller.signal, () => {}, () => true)).rejects.toThrow()
        expect(planToolEmbeddingWarmup().count).toBe(2)
    })

    test('records provider failures without preventing foreground fallback', async () => {
        register()
        embedding.embedBatch.mockRejectedValue(new Error('Embedding unavailable'))
        stop = startToolEmbeddingWarmup()
        await vi.advanceTimersByTimeAsync(1_000)
        await vi.waitFor(() => expect(listMemoryIndexJobs()[0]).toMatchObject({ status: 'error', error: 'Embedding unavailable' }))
        embedding.embed.mockRejectedValue(new Error('Embedding unavailable'))
        const tools = await routeTools({ userQuery: 'search documents', allTools: registry.getToolDefinitions() })
        expect(tools.some(tool => tool.name === 'search')).toBe(true)
    })

    test('removes caches for uninstalled tools including the final namespace', async () => {
        register()
        const plan = planToolEmbeddingWarmup()
        await plan.run(new AbortController().signal, () => {}, () => true)
        registry.unregisterByNamespace('mcp:test')
        planToolEmbeddingWarmup().prune()
        expect(getDb().prepare('SELECT count(*) AS n FROM tool_router_embeddings').get()).toEqual({ n: 0 })
        expect(getDb().prepare('SELECT count(*) AS n FROM tool_router_tool_embeddings').get()).toEqual({ n: 0 })
    })
})
