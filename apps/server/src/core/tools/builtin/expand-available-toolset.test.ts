import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { RegistryAwareToolDefinition } from '../../gateway/providers/base.provider.js'
import { makeSearchAvailableMcpToolsTool } from './expand-available-toolset.js'

const { embed, embedBatch } = vi.hoisted(() => ({ embed: vi.fn(), embedBatch: vi.fn() }))
vi.mock('../../memory/embedding.js', () => ({
    getEmbeddingService: () => ({
        embed, embedBatch,
        profile: { fingerprint: 'test-profile' },
        getConfig: () => ({ providerId: 'test' }),
        getModelName: () => 'test',
        getDimensions: () => 2,
    }),
}))
vi.mock('../../agent/router-embedding-cache.js', () => ({
    loadCachedRouterEmbeddings: () => new Map(),
    loadCachedToolEmbeddings: () => new Map(),
    saveCachedRouterEmbedding: vi.fn(),
    saveCachedToolEmbedding: vi.fn(),
    pruneRouterEmbeddingCache: vi.fn(),
    pruneToolEmbeddingCache: vi.fn(),
}))

function tool(name: string, namespaceId = 'mcp:test'): RegistryAwareToolDefinition {
    return { name, namespaceId, description: name, parameters: {}, timeout: 1000,
        execute: async () => ({ success: true, output: 'ok' }) }
}

beforeEach(() => {
    embed.mockResolvedValue({ vector: [1, 0] })
    embedBatch.mockImplementation(async (texts: string[]) => texts.map(text => ({
        vector: text.includes('inbox') ? [1, 0] : [0, 1],
    })))
})

describe('runtime semantic tool expansion', () => {
    test('finds semantic matches without keyword overlap and excludes loaded and local tools', async () => {
        const expansion = makeSearchAvailableMcpToolsTool({
            allTools: [tool('weather'), tool('inbox'), tool('inbox_loaded'), tool('inbox_local', 'builtin:test')],
            getLoadedToolNames: () => new Set(['inbox_loaded']),
        })
        const result = await expansion.execute({ requested_capability: 'correspondence', limit: 1 })
        expect(result.loadedTools?.map(t => t.name)).toEqual(['inbox'])
        expect(embed).toHaveBeenCalledWith('correspondence')
        const second = await expansion.execute({ requested_capability: 'correspondence' })
        expect(second.loadedTools?.map(t => t.name)).not.toContain('inbox')
    })

    test('falls back to lexical retrieval when embeddings fail', async () => {
        embed.mockRejectedValue(new Error('offline'))
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const expansion = makeSearchAvailableMcpToolsTool({
            allTools: [tool('weather'), tool('inbox')], getLoadedToolNames: () => new Set(),
        })
        const result = await expansion.execute({ requested_capability: 'inbox' })
        expect(result.loadedTools?.map(t => t.name)).toEqual(['inbox'])
    })

    test('does not retrieve for empty capabilities or exhausted catalogues', async () => {
        const expansion = makeSearchAvailableMcpToolsTool({ allTools: [], getLoadedToolNames: () => new Set() })
        expect((await expansion.execute({ requested_capability: ' ' })).success).toBe(false)
        expect((await expansion.execute({ requested_capability: 'email' })).output).toContain('No additional tools')
        expect(embed).not.toHaveBeenCalled()
    })

    test('does not mark results loaded after cancellation', async () => {
        const controller = new AbortController()
        embed.mockImplementationOnce(async () => { controller.abort(); return { vector: [1, 0] } })
        const expansion = makeSearchAvailableMcpToolsTool({ allTools: [tool('inbox')], getLoadedToolNames: () => new Set() })
        await expect(expansion.execute({ requested_capability: 'email' }, controller.signal)).rejects.toThrow()
        expect((await expansion.execute({ requested_capability: 'email' })).loadedTools?.map(t => t.name)).toEqual(['inbox'])
    })
})
