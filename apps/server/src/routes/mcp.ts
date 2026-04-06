import type { FastifyInstance } from 'fastify'
import type { ToolDefinition } from '../core/gateway/providers/base.provider.js'
import { getDb } from '../db/database.js'
import { getMcpManager, type McpServerConfig } from '../core/tools/mcp/mcp-manager.js'
import { getToolRegistry, type ToolNamespace, type ToolRegistry } from '../core/tools/tool-registry.js'
import { nanoid } from 'nanoid'
import { existsSync, readFileSync } from 'fs'
import { dirname, join, isAbsolute, resolve } from 'path'

/**
 * Register MCP tools into the registry under their bare names.
 * Collision resolution is deferred to execution time via
 * registry.resolveForExecution(), which adds a slug prefix only
 * when two same-named tools are both selected by the same agent.
 */
function registerMcpTools(
    tools: ToolDefinition[],
    _slug: string,
    ns: ToolNamespace,
    registry: ToolRegistry
): void {
    for (const tool of tools) {
        registry.register(tool, ns)
    }
}

/** Set up the auth-complete callback so background OAuth completions auto-register tools. */
function setupAuthCompleteCallback(): void {
    const manager = getMcpManager()
    const registry = getToolRegistry()

    manager.setOnAuthComplete((serverId, tools, config) => {
        const slug = manager.getSlug(serverId)
        const ns: ToolNamespace = { id: `mcp:${serverId}`, label: config.name }
        registerMcpTools(tools, slug, ns, registry)
    })
}

const ICON_EXTS = ['png', 'jpg', 'jpeg', 'svg', 'webp'] as const
const MIME_MAP: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp' }

/**
 * Try to find an icon file (icon.png, icon.jpg, etc.) in the MCP server's folder.
 * Derives the folder from the first path-like argument.
 */
function findMcpIcon(command: string, argsJson: string): { path: string; mime: string } | null {
    const args = JSON.parse(argsJson) as string[]
    // Find the first argument that looks like a file path
    const entryPath = args.find(a => isAbsolute(a) && !a.startsWith('-'))
    if (!entryPath) return null

    // Walk up from the entry file directory (e.g. dist/index.js -> project root)
    let dir = dirname(resolve(entryPath))
    const root = dirname(dir) // stop after two levels up
    for (let i = 0; i < 3 && dir.length > 1; i++) {
        for (const ext of ICON_EXTS) {
            const p = join(dir, `icon.${ext}`)
            if (existsSync(p)) return { path: p, mime: MIME_MAP[ext] }
        }
        if (dir === root) break
        dir = dirname(dir)
    }
    return null
}

interface McpEnvHint {
    name: string
    description?: string
    required: boolean
}

/**
 * Try to find a `mcp-meta.json` next to the MCP server's entry file.
 * Returns parsed env var hints if found.
 */
function findMcpMeta(command: string, argsJson: string): McpEnvHint[] | null {
    const args = JSON.parse(argsJson) as string[]
    const entryPath = args.find(a => isAbsolute(a) && !a.startsWith('-'))
    if (!entryPath) return null

    let dir = dirname(resolve(entryPath))
    for (let i = 0; i < 3 && dir.length > 1; i++) {
        const p = join(dir, 'mcp-meta.json')
        if (existsSync(p)) {
            try {
                const meta = JSON.parse(readFileSync(p, 'utf-8')) as { envVars?: McpEnvHint[] }
                return meta.envVars || null
            } catch { return null }
        }
        dir = dirname(dir)
    }
    return null
}

/** Load saved MCP servers from DB and connect enabled ones */
export async function loadSavedMcpServers(): Promise<void> {
    setupAuthCompleteCallback()

    const db = getDb()
    const rows = db.prepare('SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY created_at').all() as {
        id: string
        name: string
        command: string
        args_json: string
        env_json: string
        enabled: number
    }[]

    const manager = getMcpManager()
    const registry = getToolRegistry()

    const configs: McpServerConfig[] = rows.map((row) => ({
        id: row.id,
        name: row.name,
        command: row.command,
        args: JSON.parse(row.args_json),
        env: JSON.parse(row.env_json),
        enabled: true
    }))

    await Promise.allSettled(
        configs.map(async (config) => {
            try {
                const tools = await manager.connect(config)
                const slug = manager.getSlug(config.id)
                const ns: ToolNamespace = { id: `mcp:${config.id}`, label: config.name }
                registerMcpTools(tools, slug, ns, registry)
            } catch (err) {
                console.error(`Failed to connect MCP server '${config.name}':`, (err as Error).message)
            }
        })
    )
}

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
    // GET /api/mcp/servers — list all MCP server configs
    app.get('/servers', async () => {
        const db = getDb()
        const rows = db.prepare('SELECT * FROM mcp_servers ORDER BY created_at').all() as {
            id: string
            name: string
            command: string
            args_json: string
            env_json: string
            enabled: number
            icon_url: string | null
            origin: string | null
            created_at: number
            updated_at: number
        }[]

        const manager = getMcpManager()
        const pendingAuths = manager.getPendingAuths()

        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            command: row.command,
            args: JSON.parse(row.args_json) as string[],
            env: JSON.parse(row.env_json) as Record<string, string>,
            enabled: row.enabled === 1,
            icon_url: row.icon_url || (findMcpIcon(row.command, row.args_json) ? `/api/mcp/servers/${row.id}/icon` : null),
            origin: row.origin,
            connected: manager.isConnected(row.id),
            toolCount: manager.getTools(row.id).length,
            pendingAuthUrl: pendingAuths[row.id] || null,
            envHints: findMcpMeta(row.command, row.args_json),
            serverInfo: manager.getServerInfo(row.id) || null,
        }))
    })

    // GET /api/mcp/servers/:id/icon — serve icon from MCP folder
    app.get<{ Params: { id: string } }>('/servers/:id/icon', async (req, reply) => {
        const { id } = req.params
        const db = getDb()
        const row = db.prepare('SELECT command, args_json, icon_url FROM mcp_servers WHERE id = ?').get(id) as {
            command: string; args_json: string; icon_url: string | null
        } | undefined
        if (!row) return reply.status(404).send({ error: 'Server not found' })

        // If the server has an explicit icon_url, redirect to it
        if (row.icon_url) return reply.redirect(row.icon_url)

        const icon = findMcpIcon(row.command, row.args_json)
        if (!icon) return reply.status(404).send({ error: 'No icon found' })

        const data = readFileSync(icon.path)
        return reply.header('Content-Type', icon.mime).header('Cache-Control', 'public, max-age=3600').send(data)
    })

    // POST /api/mcp/servers — add a new MCP server
    app.post<{
        Body: {
            name: string
            command: string
            args?: string[]
            env?: Record<string, string>
            enabled?: boolean
            icon_url?: string
            origin?: string
        }
    }>('/servers', async (req, reply) => {
        const { name, command, args, env, enabled, icon_url, origin } = req.body

        if (!name || !command) {
            return reply.status(400).send({ error: 'name and command are required' })
        }

        const db = getDb()
        const id = nanoid()
        const now = Date.now()
        const isEnabled = enabled !== false

        db.prepare(
            `INSERT INTO mcp_servers (id, name, command, args_json, env_json, enabled, icon_url, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, name, command, JSON.stringify(args || []), JSON.stringify(env || {}), isEnabled ? 1 : 0, icon_url || null, origin || null, now, now)

        const config: McpServerConfig = {
            id,
            name,
            command,
            args: args || [],
            env: env || {},
            enabled: isEnabled
        }

        // Connect if enabled
        if (isEnabled) {
            try {
                const manager = getMcpManager()
                const registry = getToolRegistry()
                const tools = await manager.connect(config)
                const ns: ToolNamespace = { id: `mcp:${id}`, label: name }
                registerMcpTools(tools, manager.getSlug(id), ns, registry)
                return { id, connected: true, toolCount: tools.length }
            } catch (err) {
                const manager = getMcpManager()
                const pendingAuthUrl = manager.getPendingAuths()[id] || null
                return { id, connected: false, error: (err as Error).message, pendingAuthUrl }
            }
        }

        return { id, connected: false }
    })
    // POST /api/mcp/servers/:id/toggle — enable/disable a server
    app.post<{ Params: { id: string } }>('/servers/:id/toggle', async (req, reply) => {
        const { id } = req.params
        const db = getDb()
        const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as {
            id: string
            name: string
            command: string
            args_json: string
            env_json: string
            enabled: number
        } | undefined

        if (!row) {
            return reply.status(404).send({ error: 'Server not found' })
        }

        const newEnabled = row.enabled === 0
        db.prepare('UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?').run(
            newEnabled ? 1 : 0,
            Date.now(),
            id
        )

        const manager = getMcpManager()
        const registry = getToolRegistry()

        if (newEnabled) {
            const config: McpServerConfig = {
                id: row.id,
                name: row.name,
                command: row.command,
                args: JSON.parse(row.args_json),
                env: JSON.parse(row.env_json),
                enabled: true
            }
            try {
                const tools = await manager.connect(config)
                const ns: ToolNamespace = { id: `mcp:${id}`, label: row.name }
                registerMcpTools(tools, manager.getSlug(id), ns, registry)
                return { enabled: true, connected: true, toolCount: tools.length }
            } catch (err) {
                return { enabled: true, connected: false, error: (err as Error).message }
            }
        } else {
            registry.unregisterByNamespace(`mcp:${id}`)
            await manager.disconnect(id)
            return { enabled: false, connected: false }
        }
    })

    // DELETE /api/mcp/servers/:id — remove a server
    app.delete<{ Params: { id: string } }>('/servers/:id', async (req) => {
        const { id } = req.params
        const db = getDb()
        const manager = getMcpManager()
        const registry = getToolRegistry()

        registry.unregisterByNamespace(`mcp:${id}`)
        await manager.disconnect(id)
        db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
        return { success: true }
    })

    // PUT /api/mcp/servers/:id — update a server's config
    app.put<{
        Params: { id: string }
        Body: { name?: string; command?: string; args?: string[]; env?: Record<string, string> }
    }>('/servers/:id', async (req, reply) => {
        const { id } = req.params
        const { name, command, args, env } = req.body

        const db = getDb()
        const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as {
            id: string
            name: string
            command: string
            args_json: string
            env_json: string
            enabled: number
        } | undefined

        if (!row) {
            return reply.status(404).send({ error: 'Server not found' })
        }

        const updatedName = name ?? row.name
        const updatedCommand = command ?? row.command
        const updatedArgs = args ?? JSON.parse(row.args_json)
        const updatedEnv = env ?? JSON.parse(row.env_json)

        db.prepare(
            'UPDATE mcp_servers SET name = ?, command = ?, args_json = ?, env_json = ?, updated_at = ? WHERE id = ?'
        ).run(updatedName, updatedCommand, JSON.stringify(updatedArgs), JSON.stringify(updatedEnv), Date.now(), id)

        // Reconnect if the server was enabled
        const manager = getMcpManager()
        const registry = getToolRegistry()

        if (row.enabled) {
            registry.unregisterByNamespace(`mcp:${id}`)

            const config: McpServerConfig = {
                id,
                name: updatedName,
                command: updatedCommand,
                args: updatedArgs,
                env: updatedEnv,
                enabled: true
            }

            try {
                const tools = await manager.connect(config)
                const ns: ToolNamespace = { id: `mcp:${id}`, label: updatedName }
                registerMcpTools(tools, manager.getSlug(id), ns, registry)
                return { success: true, connected: true, toolCount: tools.length }
            } catch (err) {
                return { success: true, connected: false, error: (err as Error).message }
            }
        } else {
            return { success: true, connected: false }
        }
    })

    // POST /api/mcp/servers/:id/reconnect — reconnect a server
    app.post<{ Params: { id: string } }>('/servers/:id/reconnect', async (req, reply) => {
        const { id } = req.params
        const db = getDb()
        const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as {
            id: string
            name: string
            command: string
            args_json: string
            env_json: string
            enabled: number
        } | undefined

        if (!row) {
            return reply.status(404).send({ error: 'Server not found' })
        }

        const manager = getMcpManager()
        const registry = getToolRegistry()

        registry.unregisterByNamespace(`mcp:${id}`)

        const config: McpServerConfig = {
            id: row.id,
            name: row.name,
            command: row.command,
            args: JSON.parse(row.args_json),
            env: JSON.parse(row.env_json),
            enabled: row.enabled === 1
        }

        try {
            const tools = await manager.connect(config)
            const ns: ToolNamespace = { id: `mcp:${id}`, label: row.name }
            registerMcpTools(tools, manager.getSlug(id), ns, registry)
            return { connected: true, toolCount: tools.length }
        } catch (err) {
            return { connected: false, error: (err as Error).message }
        }
    })

    // GET /api/mcp/registry — proxy to MCP registries (official, smithery, glama)
    app.get<{
        Querystring: { search?: string; cursor?: string; limit?: string; registry?: string; }
    }>('/registry', async (req, reply) => {
        const { search, cursor, limit, registry: registrySource } = req.query
        const targetLimit = parseInt(limit || '20', 10)
        let currentCursor = cursor || ''
        const collectedServers: any[] = []

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
                        collectedServers.push({
                            server: {
                                name: s.qualifiedName,
                                title: s.displayName,
                                description: s.description || (s.remote ? "[Remote/Hosted Tool - See Documentation]" : ""),
                                version: 'latest',
                                websiteUrl: s.homepage,
                                icons: s.iconUrl ? [{ src: s.iconUrl, mimeType: 'image/png' }] : undefined,
                                isRemote: !!s.remote,
                                packages: [{
                                    registryType: 'smithery',
                                    identifier: s.qualifiedName,
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
