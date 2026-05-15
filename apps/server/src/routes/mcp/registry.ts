import type { FastifyInstance } from 'fastify'

type RegistryServerEntry = {
    server: Record<string, unknown>
    _meta?: Record<string, unknown>
}

export async function registerMcpRegistryRoutes(app: FastifyInstance): Promise<void> {
    // GET /api/mcp/registry — proxy to MCP registries (official, smithery, glama)
    app.get<{
        Querystring: { search?: string; cursor?: string; limit?: string; registry?: string; }
    }>('/registry', async (req, reply) => {
        const { search, cursor, limit, registry: registrySource } = req.query
        const targetLimit = parseInt(limit || '20', 10)
        let currentCursor = cursor || ''
        const collectedServers: RegistryServerEntry[] = []

        try {
            if (registrySource === 'smithery') {
                const params = new URLSearchParams()
                if (search) params.set('q', search)
                const pageNum = parseInt(currentCursor || '1', 10)
                params.set('page', pageNum.toString())

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

            // ── Glama.ai registry ──
            if (registrySource === 'glama') {
                const params = new URLSearchParams()
                params.set('first', String(targetLimit))
                if (search) params.set('query', search)
                if (currentCursor) params.set('after', currentCursor)

                const url = `https://glama.ai/api/mcp/v1/servers?${params}`
                const res = await fetch(url)

                if (!res.ok) return reply.status(res.status).send({ error: `Glama Registry returned ${res.status}` })

                const data = await res.json()
                if (data.servers && Array.isArray(data.servers)) {
                    for (const s of data.servers) {
                        const isRemote = (s.attributes || []).some((a: string) => a === 'hosting:remote-capable')
                        const isLocal = (s.attributes || []).some((a: string) => a === 'hosting:local-only')

                        // Build env vars from JSON Schema
                        const envVars: { name: string; description?: string; isRequired: boolean }[] = []
                        if (s.environmentVariablesJsonSchema?.properties) {
                            const schema = s.environmentVariablesJsonSchema
                            const required: string[] = schema.required || []
                            for (const [name, prop] of Object.entries(schema.properties as Record<string, { description?: string }>)) {
                                envVars.push({
                                    name,
                                    description: prop.description,
                                    isRequired: required.includes(name)
                                })
                            }
                        }

                        collectedServers.push({
                            server: {
                                name: `${s.namespace}/${s.slug}`,
                                title: s.name,
                                description: s.description || '',
                                version: 'latest',
                                repository: s.repository,
                                websiteUrl: s.url,
                                isRemote,
                                isLocal,
                                packages: [{
                                    registryType: 'npm',
                                    identifier: s.slug,
                                    version: 'latest',
                                    transport: { type: 'stdio' },
                                    environmentVariables: envVars
                                }]
                            }
                        })
                    }
                }

                const nextCursor = data.pageInfo?.hasNextPage ? data.pageInfo.endCursor : undefined
                return { servers: collectedServers, metadata: { nextCursor, count: collectedServers.length } }
            }

            // ── Official MCP registry (default) ──
            while (collectedServers.length < targetLimit) {
                const params = new URLSearchParams()
                params.set('limit', '50')
                if (search) params.set('search', search)
                if (currentCursor) params.set('cursor', currentCursor)

                const url = `https://registry.modelcontextprotocol.io/v0/servers?${params}`
                const res = await fetch(url)

                if (!res.ok) return reply.status(res.status).send({ error: `Registry returned ${res.status}` })

                const data = await res.json()
                if (!data.servers || !Array.isArray(data.servers)) break

                for (const s of data.servers) {
                    const isLatest = s._meta?.['io.modelcontextprotocol.registry/official']?.isLatest !== false
                    const hasPackages = s.server?.packages && Array.isArray(s.server.packages) && s.server.packages.length > 0
                    if (isLatest && hasPackages) {
                        const name = s.server?.name
                        if (name && !collectedServers.find(x => x.server?.name === name)) {
                            collectedServers.push(s)
                            if (collectedServers.length >= targetLimit) break
                        }
                    }
                }

                currentCursor = data.nextCursor
                if (!currentCursor) break
            }

            return { servers: collectedServers, metadata: { nextCursor: currentCursor, count: collectedServers.length } }
        } catch (err) {
            return reply.status(502).send({ error: (err as Error).message })
        }
    })
}
