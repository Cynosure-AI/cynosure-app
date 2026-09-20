import type { FastifyInstance } from 'fastify'
import { recommendedServers } from './recommended-servers.js'

type RegistryServerEntry = {
    server: Record<string, unknown>
    _meta?: Record<string, unknown>
}

const CYNOSURE_NPM_NAMESPACE = '@cynosure'

function isCynosureServer(entry: RegistryServerEntry): boolean {
    const name = String(entry.server.name || '')
    // The currently published packages use the @cynosure-mcp scope. Keep the
    // prefix check compatible with a future @cynosure/ scope migration while
    // excluding every unrelated namespace from the curated storefront.
    return name === CYNOSURE_NPM_NAMESPACE
        || name.startsWith(`${CYNOSURE_NPM_NAMESPACE}/`)
        || name.startsWith(`${CYNOSURE_NPM_NAMESPACE}-mcp/`)
}

export async function registerMcpRegistryRoutes(app: FastifyInstance): Promise<void> {
    // GET /api/mcp/registry — browse MCP sources (recommended, official, smithery)
    app.get<{
        Querystring: { search?: string; cursor?: string; limit?: string; registry?: string; }
    }>('/registry', async (req, reply) => {
        const { search, cursor, limit, registry: registrySource } = req.query
        const targetLimit = parseInt(limit || '20', 10)
        let currentCursor = cursor || ''
        const collectedServers: RegistryServerEntry[] = []

        try {
            if (registrySource === 'recommended') {
                const query = search?.trim().toLowerCase()
                const cynosureServers = recommendedServers.filter(isCynosureServer)
                const servers = query
                    ? cynosureServers.filter((entry) => {
                        const server = entry.server
                        return [
                            server.name,
                            server.title,
                            server.description,
                            ...(Array.isArray(server.packages)
                                ? server.packages.map((pkg) => (pkg as { identifier?: string }).identifier)
                                : []),
                        ].some((value) => String(value || '').toLowerCase().includes(query))
                    })
                    : cynosureServers

                return { servers, metadata: { count: servers.length } }
            }

            if (registrySource === 'smithery') {
                const params = new URLSearchParams()
                if (search) params.set('q', search)
                const pageNum = parseInt(currentCursor || '1', 10)
                params.set('page', pageNum.toString())
                params.set('pageSize', String(targetLimit))

                const url = `https://api.smithery.ai/servers?${params}`
                const res = await fetch(url)

                if (!res.ok) return reply.status(res.status).send({ error: `Smithery Registry returned ${res.status}` })

                const data = await res.json()
                if (data.servers && Array.isArray(data.servers)) {
                    for (const s of data.servers) {
                        if (s.remote && !s.isDeployed && !s.name) continue;
                        let remotes: Array<{ type: string; url: string }> | undefined
                        if (s.remote && s.isDeployed) {
                            const detailUrl = `https://api.smithery.ai/servers/${encodeURI(s.qualifiedName)}`
                            try {
                                const detailRes = await fetch(detailUrl)
                                if (detailRes.ok) {
                                    const detail = await detailRes.json()
                                    const deploymentUrl = detail.deploymentUrl
                                        || detail.connections?.find((conn: { type?: string; deploymentUrl?: string }) => conn.type === 'http' && conn.deploymentUrl)?.deploymentUrl
                                    if (deploymentUrl) remotes = [{ type: 'streamable-http', url: deploymentUrl }]
                                }
                            } catch {
                                // Keep the registry row usable via Smithery CLI if detail lookup fails.
                            }
                        }
                        collectedServers.push({
                            server: {
                                name: s.qualifiedName,
                                title: s.displayName,
                                description: s.description || (s.remote ? "[Remote/Hosted Tool - See Documentation]" : ""),
                                version: 'latest',
                                websiteUrl: s.homepage,
                                icons: s.iconUrl ? [{ src: s.iconUrl, mimeType: 'image/png' }] : undefined,
                                isRemote: !!s.remote,
                                remotes,
                                packages: [{
                                    registryType: 'smithery',
                                    identifier: s.qualifiedName,
                                    transport: { type: 'stdio' },
                                    command: 'npx',
                                    env: []
                                }]
                            }
                        })
                    }
                }

                let next = undefined;
                if (data.pagination && data.pagination.currentPage < data.pagination.totalPages) {
                    next = (data.pagination.currentPage + 1).toString();
                }

                return { servers: collectedServers, metadata: { nextCursor: next, count: collectedServers.length } }
            }

            // ── Official MCP registry (default) ──
            while (collectedServers.length < targetLimit) {
                const params = new URLSearchParams()
                // Only request as many upstream rows as this page can still hold.
                // Advancing an opaque cursor past a larger response would otherwise
                // skip installable servers that did not fit in the current page.
                params.set('limit', String(targetLimit - collectedServers.length))
                if (search) params.set('search', search)
                if (currentCursor) params.set('cursor', currentCursor)

                const url = `https://registry.modelcontextprotocol.io/v0/servers?${params}`
                const res = await fetch(url)

                if (!res.ok) return reply.status(res.status).send({ error: `Registry returned ${res.status}` })

                const data = await res.json()
                if (!data.servers || !Array.isArray(data.servers)) break

                for (const s of data.servers) {
                    const isLatest = s._meta?.['io.modelcontextprotocol.registry/official']?.isLatest !== false
                    const hasSupportedPackage = Array.isArray(s.server?.packages) && s.server.packages.some((pkg: { registryType?: string; transport?: { type?: string } }) =>
                        pkg.transport?.type === 'stdio' && (pkg.registryType === 'npm' || pkg.registryType === 'pypi'))
                    const hasSupportedRemote = Array.isArray(s.server?.remotes) && s.server.remotes.some((remote: { type?: string; url?: string }) =>
                        (remote.type === 'streamable-http' || remote.type === 'http') && /^https?:\/\//.test(remote.url || ''))
                    if (isLatest && (hasSupportedPackage || hasSupportedRemote)) {
                        const name = s.server?.name
                        if (name && !collectedServers.find(x => x.server?.name === name)) {
                            collectedServers.push(s)
                            if (collectedServers.length >= targetLimit) break
                        }
                    }
                }

                currentCursor = data.metadata?.nextCursor || data.nextCursor || ''
                if (!currentCursor) break
            }

            return { servers: collectedServers, metadata: { nextCursor: currentCursor, count: collectedServers.length } }
        } catch (err) {
            return reply.status(502).send({ error: (err as Error).message })
        }
    })
}
