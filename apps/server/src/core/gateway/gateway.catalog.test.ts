import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../model-dev-fetcher.js', () => ({
    ensurePricingLoaded: vi.fn().mockResolvedValue(undefined),
    getModelMetadata: vi.fn().mockReturnValue(null),
}))

import { closeDb, getDb } from '../../db/database.js'
import { LLMGateway } from './gateway.js'
import type { BaseLLMProvider, ModelListItem } from './providers/base.provider.js'

describe('LLMGateway persisted catalogues', () => {
    let directory = ''

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'cynosure-catalog-'))
        process.env.CYNOSURE_DATA_DIR = directory
        getDb()
    })

    afterEach(async () => {
        vi.useRealTimers()
        closeDb()
        delete process.env.CYNOSURE_DATA_DIR
        await rm(directory, { recursive: true, force: true })
    })

    /** A gateway as a fresh server process would build it, with a stub remote provider. */
    function startGateway(apiKey: string, models: ModelListItem[]) {
        const gateway = new LLMGateway()
        const provider = {
            config: { id: 'router', type: 'openrouter', baseUrl: 'https://example.com', apiKey },
            listModelItems: vi.fn().mockResolvedValue(models),
            getModelInfo: vi.fn().mockResolvedValue({ id: 'model-a', contextLength: 128_000, inputModalities: ['text'], outputModalities: ['text'], pricing: { prompt: 0.000001, completion: 0.000002 } }),
        } as unknown as BaseLLMProvider
        gateway.getAllProviders().set('router', provider)
        return { gateway, provider }
    }

    test('a restart serves the saved model list and refreshes it once stale', async () => {
        const first = startGateway('key-1', [{ id: 'model-a' }])
        expect(await first.gateway.listModelItems('router', 'llm')).toEqual([{ id: 'model-a' }])

        const restarted = startGateway('key-1', [{ id: 'model-a' }, { id: 'model-b' }])
        expect(await restarted.gateway.listModelItems('router', 'llm')).toEqual([{ id: 'model-a' }])
        expect(restarted.provider.listModelItems).not.toHaveBeenCalled()

        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(Date.now() + 11 * 60 * 1000)
        const later = startGateway('key-1', [{ id: 'model-a' }, { id: 'model-b' }])
        // The stale list answers at once; the refresh replaces it in the background.
        expect(await later.gateway.listModelItems('router', 'llm')).toEqual([{ id: 'model-a' }])
        await vi.waitFor(() => expect(later.provider.listModelItems).toHaveBeenCalledTimes(1))
        await new Promise((resolve) => setImmediate(resolve))
        expect(await later.gateway.listModelItems('router', 'llm')).toEqual([{ id: 'model-a' }, { id: 'model-b' }])
    })

    test('a changed API key never sees the previous account catalogue', async () => {
        await startGateway('key-1', [{ id: 'old-account-model' }]).gateway.listModelItems('router', 'llm')

        const otherAccount = startGateway('key-2', [{ id: 'new-account-model' }])
        expect(await otherAccount.gateway.listModelItems('router', 'llm')).toEqual([{ id: 'new-account-model' }])
        const stored = getDb().prepare('SELECT key, value_json FROM catalog_cache').all() as Array<{ key: string; value_json: string }>
        expect(stored.every((row) => !row.key.includes('key-1') && !row.key.includes('key-2'))).toBe(true)
    })

    test('a restart answers model info from the saved copy without a provider call', async () => {
        const first = startGateway('key-1', [])
        const info = await first.gateway.getModelInfo('model-a', 'router')
        expect(info.contextLength).toBe(128_000)

        const restarted = startGateway('key-1', [])
        expect(await restarted.gateway.getModelInfo('model-a', 'router')).toEqual(info)
        expect(restarted.provider.getModelInfo).not.toHaveBeenCalled()
    })
})
