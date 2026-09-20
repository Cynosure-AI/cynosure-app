import Fastify from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { registerMcpRegistryRoutes } from './registry.js'

function officialServer(name: string, installable = true) {
    return {
        server: {
            name,
            version: '1.0.0',
            packages: installable ? [{ registryType: 'npm', identifier: name }] : [],
        },
        _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true } },
    }
}

describe('MCP registry pagination', () => {
    afterEach(() => vi.unstubAllGlobals())

    test('does not advance the official cursor past rows that could fit on the page', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                servers: [officialServer('one'), officialServer('old', false), officialServer('two')],
                nextCursor: 'cursor-2',
            })))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                servers: [officialServer('three')],
                nextCursor: 'cursor-3',
            })))
        vi.stubGlobal('fetch', fetchMock)

        const app = Fastify()
        await app.register(registerMcpRegistryRoutes, { prefix: '/api/mcp' })
        try {
            const response = await app.inject({
                method: 'GET',
                url: '/api/mcp/registry?registry=official&search=weather&limit=3',
            })

            expect(response.statusCode).toBe(200)
            expect(response.json()).toMatchObject({
                servers: [
                    { server: { name: 'one' } },
                    { server: { name: 'two' } },
                    { server: { name: 'three' } },
                ],
                metadata: { count: 3, nextCursor: 'cursor-3' },
            })
            expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringContaining('limit=3'))
            expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringContaining('search=weather'))
            expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining('limit=1'))
            expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining('cursor=cursor-2'))
        } finally {
            await app.close()
        }
    })
})
