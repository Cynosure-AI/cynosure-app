import type { FastifyInstance } from 'fastify'
import { getDb } from '../../db/database.js'
import { getMcpManager, McpManager, type McpServerConfig } from '../../core/tools/mcp/mcp-manager.js'
import { getToolRegistry, type ToolNamespace } from '../../core/tools/tool-registry.js'
import { nanoid } from 'nanoid'
import { readFileSync } from 'fs'
import { registerMcpTools, findMcpIcon, findEnvHints, type McpEnvHint } from './utils.js'

/** Set up the auth-complete callback so background OAuth completions auto-register tools. */
function setupAuthCompleteCallback(): void {
    const manager = getMcpManager()
    const registry = getToolRegistry()

    manager.setOnAuthComplete((serverId, tools, config) => {
        const ns: ToolNamespace = { id: `mcp:${serverId}`, label: config.name }
        registerMcpTools(tools, ns, registry)
    })
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
                const ns: ToolNamespace = { id: `mcp:${config.id}`, label: config.name }
                registerMcpTools(tools, ns, registry)
            } catch (err) {
                console.error(`Failed to connect MCP server '${config.name}':`, (err as Error).message)
            }
        })
    )
}

export async function registerMcpServerRoutes(app: FastifyInstance): Promise<void> {
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
            env_hints_json: string | null
            created_at: number
            updated_at: number
        }[]

        const manager = getMcpManager()
        const pendingAuths = manager.getPendingAuths()

        return rows.map((row) => {
            const srvInfo = manager.getServerInfo(row.id) || null

            // Resolve icon: explicit icon_url > protocol-native icons > local icon file
            const iconUrl = row.icon_url
                || srvInfo?.icons?.[0]?.src
                || (findMcpIcon(row.command, row.args_json) ? `/api/mcp/servers/${row.id}/icon` : null)

            // Resolve env hints: local server.json > stored DB hints
            const liveHints = findEnvHints(row.command, row.args_json)
            const storedHints = row.env_hints_json ? JSON.parse(row.env_hints_json) as McpEnvHint[] : null

            // Sync live hints back to DB so npx packages stay up-to-date
            if (liveHints && JSON.stringify(liveHints) !== row.env_hints_json) {
                db.prepare('UPDATE mcp_servers SET env_hints_json = ? WHERE id = ?')
                    .run(JSON.stringify(liveHints), row.id)
            }

            return {
                id: row.id,
                name: row.name,
                command: row.command,
                args: JSON.parse(row.args_json) as string[],
                env: JSON.parse(row.env_json) as Record<string, string>,
                enabled: row.enabled === 1,
                icon_url: iconUrl,
                origin: row.origin,
                connected: manager.isConnected(row.id),
                toolCount: manager.getTools(row.id).length,
                pendingAuthUrl: pendingAuths[row.id] || null,
                envHints: liveHints || storedHints,
                serverInfo: srvInfo,
            }
        })
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
            env_hints?: McpEnvHint[]
        }
    }>('/servers', async (req, reply) => {
        const { name, command, args, env, enabled, icon_url, origin, env_hints } = req.body

        if (!name || !command) {
            return reply.status(400).send({ error: 'name and command are required' })
        }

        const db = getDb()
        const id = nanoid()
        const now = Date.now()
        const isEnabled = enabled !== false
        const envHintsJson = env_hints?.length ? JSON.stringify(env_hints) : null

        db.prepare(
            `INSERT INTO mcp_servers (id, name, command, args_json, env_json, enabled, icon_url, origin, env_hints_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, name, command, JSON.stringify(args || []), JSON.stringify(env || {}), isEnabled ? 1 : 0, icon_url || null, origin || null, envHintsJson, now, now)

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
                registerMcpTools(tools, ns, registry)
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
                registerMcpTools(tools, ns, registry)
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

        // Clean up cached OAuth tokens for remote servers
        const row = db.prepare('SELECT args_json FROM mcp_servers WHERE id = ?').get(id) as { args_json: string } | undefined
        if (row) {
            const remoteUrl = McpManager.extractRemoteUrl(JSON.parse(row.args_json))
            if (remoteUrl) McpManager.clearMcpRemoteAuth(remoteUrl)
        }

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
                registerMcpTools(tools, ns, registry)
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
            registerMcpTools(tools, ns, registry)
            return { connected: true, toolCount: tools.length }
        } catch (err) {
            return { connected: false, error: (err as Error).message }
        }
    })

    // POST /api/mcp/servers/:id/reauth — clear cached OAuth tokens and reconnect (forces fresh auth)
    app.post<{ Params: { id: string } }>('/servers/:id/reauth', async (req, reply) => {
        const { id } = req.params
        const db = getDb()
        const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as {
            id: string; name: string; command: string; args_json: string; env_json: string; enabled: number
        } | undefined

        if (!row) {
            return reply.status(404).send({ error: 'Server not found' })
        }

        const args: string[] = JSON.parse(row.args_json)
        const remoteUrl = McpManager.extractRemoteUrl(args)
        let cleared = 0
        if (remoteUrl) {
            cleared = McpManager.clearMcpRemoteAuth(remoteUrl)
        }

        // Disconnect, unregister tools, then reconnect to trigger fresh auth
        const manager = getMcpManager()
        const registry = getToolRegistry()
        registry.unregisterByNamespace(`mcp:${id}`)
        await manager.disconnect(id)

        const config: McpServerConfig = {
            id: row.id,
            name: row.name,
            command: row.command,
            args,
            env: JSON.parse(row.env_json),
            enabled: row.enabled === 1
        }

        try {
            const tools = await manager.connect(config)
            const ns: ToolNamespace = { id: `mcp:${id}`, label: row.name }
            registerMcpTools(tools, ns, registry)
            return { connected: true, toolCount: tools.length, clearedTokenFiles: cleared }
        } catch (err) {
            // Expected when auth is required — the process stays alive for OAuth
            return { connected: false, authRequired: manager.hasPendingAuthConnection(id), error: (err as Error).message, clearedTokenFiles: cleared }
        }
    })

    // GET /api/mcp/oauth/callback/:serverId — OAuth redirect callback for HTTP transport
    app.get<{ Params: { serverId: string }; Querystring: { code?: string; error?: string } }>(
        '/oauth/callback/:serverId',
        async (req, reply) => {
            const { serverId } = req.params
            const { code, error: oauthError } = req.query

            if (oauthError) {
                return reply.type('text/html').send(`
                    <html><body style="font-family:system-ui;text-align:center;padding:80px 20px">
                        <h2 style="color:#ef4444">Authorization Failed</h2>
                        <p style="color:#71717a">Error: ${oauthError.replace(/</g, '&lt;')}</p>
                        <p style="color:#a1a1aa;font-size:14px">You can close this window.</p>
                    </body></html>
                `)
            }

            if (!code) {
                return reply.status(400).type('text/html').send(`
                    <html><body style="font-family:system-ui;text-align:center;padding:80px 20px">
                        <h2 style="color:#ef4444">Missing Authorization Code</h2>
                        <p style="color:#a1a1aa;font-size:14px">No code was provided in the callback.</p>
                    </body></html>
                `)
            }

            const manager = getMcpManager()
            const registry = getToolRegistry()

            try {
                const tools = await manager.finishHttpAuth(serverId, code)
                // Tools were auto-registered via the auth-complete callback,
                // but register explicitly in case the callback wasn't set up
                const db = getDb()
                const row = db.prepare('SELECT name FROM mcp_servers WHERE id = ?').get(serverId) as { name: string } | undefined
                if (row) {
                    const ns: ToolNamespace = { id: `mcp:${serverId}`, label: row.name }
                    registerMcpTools(tools, ns, registry)
                }

                return reply.type('text/html').send(`
                    <html><body style="font-family:system-ui;text-align:center;padding:80px 20px">
                        <h2 style="color:#22c55e">Authorization Complete</h2>
                        <p style="color:#a1a1aa">${tools.length} tool(s) connected successfully.</p>
                        <p style="color:#71717a;font-size:14px">You can close this window and return to Open Agent.</p>
                        <script>setTimeout(function(){ window.close() }, 2000)</script>
                    </body></html>
                `)
            } catch (err) {
                return reply.status(500).type('text/html').send(`
                    <html><body style="font-family:system-ui;text-align:center;padding:80px 20px">
                        <h2 style="color:#ef4444">Connection Failed</h2>
                        <p style="color:#71717a">${(err as Error).message?.replace(/</g, '&lt;') || 'Unknown error'}</p>
                        <p style="color:#a1a1aa;font-size:14px">You can close this window and try again.</p>
                    </body></html>
                `)
            }
        }
    )
}
