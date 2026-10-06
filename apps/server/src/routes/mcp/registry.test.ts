import Fastify from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { registerMcpRegistryRoutes } from './registry.js'

function officialServer(name: string, installable = true) {
    return {
        server: {
            name,
            version: '1.0.0',
            packages: installable ? [{ registryType: 'npm', identifier: name, transport: { type: 'stdio' } }] : [],
        },
        _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true } },
    }
}

function officialRemoteServer(name: string) {
    return {
        server: {
            name,
            version: '1.0.0',
            remotes: [{ type: 'streamable-http', url: `https://${name}.example.com/mcp` }],
        },
        _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true } },
    }
}

describe('MCP registry pagination', () => {
    afterEach(() => vi.unstubAllGlobals())

    test('does not advance the official cursor past rows that could fit on the page', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                servers: [officialServer('one'), officialServer('old', false), officialRemoteServer('remote')],
                metadata: { nextCursor: 'cursor-2' },
            })))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                servers: [officialServer('three')],
                metadata: { nextCursor: 'cursor-3' },
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
                    { server: { name: 'remote' } },
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

    test('requests 12 entries per Smithery page', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            servers: [],
            pagination: { currentPage: 1, pageSize: 12, totalPages: 1, totalCount: 0 },
        })))
        vi.stubGlobal('fetch', fetchMock)

        const app = Fastify()
        await app.register(registerMcpRegistryRoutes, { prefix: '/api/mcp' })
        try {
            const response = await app.inject({
                method: 'GET',
                url: '/api/mcp/registry?registry=smithery&limit=12',
            })

            expect(response.statusCode).toBe(200)
            expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('pageSize=12'))
        } finally {
            await app.close()
        }
    })

    test('exposes Cynosure packages, Exa and Chrome DevTools in the recommended storefront', async () => {
        const app = Fastify()
        await app.register(registerMcpRegistryRoutes, { prefix: '/api/mcp' })
        try {
            const response = await app.inject({
                method: 'GET',
                url: '/api/mcp/registry?registry=recommended',
            })

            expect(response.statusCode).toBe(200)
            const body = response.json()
            expect(body.servers.length).toBeGreaterThan(0)
            expect(body.metadata.count).toBe(body.servers.length)
            expect(body.servers.every((entry: { server: { name: string } }) =>
                entry.server.name.startsWith('@cynosure') || ['exa', 'chrome-devtools-mcp'].includes(entry.server.name))).toBe(true)
            expect(body.servers).toEqual(expect.arrayContaining([
                expect.objectContaining({ server: expect.objectContaining({ name: 'exa', remotes: [{ type: 'streamable-http', url: 'https://mcp.exa.ai/mcp' }] }) }),
                expect.objectContaining({ server: expect.objectContaining({ name: 'chrome-devtools-mcp' }) }),
            ]))
            expect(body.servers.some((entry: { server: { name: string } }) => entry.server.name === '@toolsdk.ai/tavily-mcp')).toBe(false)

            const search = await app.inject({ method: 'GET', url: '/api/mcp/registry?registry=recommended&search=exa' })
            expect(search.json().servers.map((entry: { server: { name: string } }) => entry.server.name)).toContain('exa')
        } finally {
            await app.close()
        }
    })
})
