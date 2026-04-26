import type { FastifyInstance } from 'fastify'
import { getDb } from '../../db/database.js'
import { getMcpManager, McpManager, type McpServerConfig } from '../../core/tools/mcp/mcp-manager.js'
import { getToolRegistry, type ToolNamespace } from '../../core/tools/tool-registry.js'
import { nanoid } from 'nanoid'
import { readFileSync } from 'fs'
import { registerMcpTools, findMcpIcon, findEnvHints, type McpEnvHint } from './utils.js'
import { renderOAuthCallbackPage } from './oauth-callback-page.js'

type McpServerRow = {
    id: string
    name: string
    original_name?: string | null
    custom_name?: string | null
    command: string
    args_json: string
    env_json: string
    enabled: number
    icon_url?: string | null
    origin?: string | null
    description?: string
    env_hints_json?: string | null
    created_at?: number
    updated_at?: number
}

function trimToNull(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

function deriveOriginalName(input: { originalName?: unknown; original_name?: unknown; name?: unknown; command?: unknown; args?: unknown }): string {
    const explicit = trimToNull(input.originalName) || trimToNull(input.original_name) || trimToNull(input.name)
    if (explicit) return explicit

    if (Array.isArray(input.args)) {
        const packageArg = [...input.args].reverse().find((arg) =>
            typeof arg === 'string'
            && !arg.startsWith('-')
            && (arg.startsWith('@') || !arg.includes('/'))
            && arg !== 'run'
            && arg !== 'mcp-remote'
        )
        if (packageArg) return packageArg
    }

    return trimToNull(input.command) || 'MCP Server'
}

function effectiveName(row: Pick<McpServerRow, 'name'> & { original_name?: string | null; custom_name?: string | null }): string {
    return row.custom_name?.trim() || row.original_name?.trim() || row.name
}

function syncOriginalNameFromServerInfo(serverId: string, fallbackName: string): string {
    const manager = getMcpManager()
    const serverInfo = manager.getServerInfo(serverId)
    const originalName = trimToNull(serverInfo?.title) || fallbackName
    const db = getDb()
    db.prepare('UPDATE mcp_servers SET original_name = ?, name = COALESCE(NULLIF(custom_name, \'\'), ?), updated_at = ? WHERE id = ?')
        .run(originalName, originalName, Date.now(), serverId)
    return originalName
}

function buildMcpNamespace(serverId: string, name: string, manager: McpManager = getMcpManager()): ToolNamespace {
    const serverInfo = manager.getServerInfo(serverId)
    const row = getDb().prepare('SELECT description FROM mcp_servers WHERE id = ?').get(serverId) as { description: string } | undefined
    const description = row?.description?.trim() || serverInfo?.description
    return {
        id: `mcp:${serverId}`,
        label: name || serverInfo?.title || serverId,
        description,
    }
}

/** Set up the auth-complete callback so background OAuth completions auto-register tools. */
function setupAuthCompleteCallback(): void {
    const manager = getMcpManager()
    const registry = getToolRegistry()

    manager.setOnAuthComplete((serverId, tools, config) => {
        const row = getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId) as McpServerRow | undefined
        const originalName = syncOriginalNameFromServerInfo(serverId, row?.original_name || config.name)
        const ns = buildMcpNamespace(serverId, row?.custom_name?.trim() || originalName, manager)
        registerMcpTools(tools, ns, registry)
    })
}

/** Load saved MCP servers from DB and connect enabled ones */
export async function loadSavedMcpServers(): Promise<void> {
    setupAuthCompleteCallback()

    const db = getDb()
    const rows = db.prepare('SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY created_at').all() as McpServerRow[]

    const manager = getMcpManager()
    const registry = getToolRegistry()

    const configs: McpServerConfig[] = rows.map((row) => ({
        id: row.id,
        name: effectiveName(row),
        command: row.command,
        args: JSON.parse(row.args_json),
        env: JSON.parse(row.env_json),
        enabled: true
    }))

    await Promise.allSettled(
        configs.map(async (config) => {
            try {
                const tools = await manager.connect(config)
                const originalName = syncOriginalNameFromServerInfo(config.id, config.name)
                config.name = rows.find((row) => row.id === config.id)?.custom_name?.trim() || originalName
                const ns = buildMcpNamespace(config.id, config.name, manager)
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
        const rows = db.prepare('SELECT * FROM mcp_servers ORDER BY created_at').all() as McpServerRow[]

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
                name: effectiveName(row),
                originalName: row.original_name || row.name,
                customName: row.custom_name || null,
                command: row.command,
                args: JSON.parse(row.args_json) as string[],
                env: JSON.parse(row.env_json) as Record<string, string>,
                enabled: row.enabled === 1,
                icon_url: iconUrl,
                origin: row.origin,
                description: row.description || '',
                connected: manager.isConnected(row.id),
                toolCount: manager.getTools(row.id).length,
                pendingAuthUrl: pendingAuths[row.id] || null,
                envHints: liveHints || storedHints,
                serverInfo: srvInfo,
            }
        })
    })

    // GET /api/mcp/servers/:id/tools — list tools for a specific connected MCP server
    app.get<{ Params: { id: string } }>('/servers/:id/tools', async (req, reply) => {
        const { id } = req.params
        const db = getDb()
        const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined

        if (!row) {
            return reply.status(404).send({ error: 'Server not found' })
        }

        const manager = getMcpManager()
        if (!manager.isConnected(id)) {
            return reply.status(409).send({ error: 'Server is not connected' })
        }

        const tools = manager.getTools(id)
        return tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            serverId: row.id,
            serverName: effectiveName(row),
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
            name?: string
            originalName?: string
            customName?: string | null
            command: string
            args?: string[]
            env?: Record<string, string>
            enabled?: boolean
            icon_url?: string
            origin?: string
            description?: string
            env_hints?: McpEnvHint[]
        }
    }>('/servers', async (req, reply) => {
        const { name, originalName, customName, command, args, env, enabled, icon_url, origin, description, env_hints } = req.body

        if (!command) {
            return reply.status(400).send({ error: 'command is required' })
        }

        const db = getDb()
        const id = nanoid()
        const now = Date.now()
        const isEnabled = enabled !== false
        const envHintsJson = env_hints?.length ? JSON.stringify(env_hints) : null
        const original = deriveOriginalName({ originalName, name, command, args })
        const custom = customName !== undefined ? trimToNull(customName) : null
        const displayName = custom || original

        db.prepare(
            `INSERT INTO mcp_servers (id, name, original_name, custom_name, command, args_json, env_json, enabled, icon_url, origin, description, env_hints_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, displayName, original, custom, command, JSON.stringify(args || []), JSON.stringify(env || {}), isEnabled ? 1 : 0, icon_url || null, origin || null, description?.trim() || '', envHintsJson, now, now)

        const config: McpServerConfig = {
            id,
            name: displayName,
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
                const syncedOriginal = syncOriginalNameFromServerInfo(id, original)
                const ns = buildMcpNamespace(id, custom || syncedOriginal, manager)
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
        const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined

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
                name: effectiveName(row),
                command: row.command,
                args: JSON.parse(row.args_json),
                env: JSON.parse(row.env_json),
                enabled: true
            }
            try {
                const tools = await manager.connect(config)
                const originalName = syncOriginalNameFromServerInfo(id, row.original_name || config.name)
                const ns = buildMcpNamespace(id, row.custom_name?.trim() || originalName, manager)
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
        Body: { name?: string; originalName?: string; customName?: string | null; command?: string; args?: string[]; env?: Record<string, string>; description?: string }
    }>('/servers/:id', async (req, reply) => {
        const { id } = req.params
        const { name, originalName, customName, command, args, env, description } = req.body

        const db = getDb()
        const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined

        if (!row) {
            return reply.status(404).send({ error: 'Server not found' })
        }

        const updatedOriginalName = trimToNull(originalName) || row.original_name || row.name
        const updatedCustomName = customName !== undefined
            ? trimToNull(customName)
            : (name !== undefined ? trimToNull(name) : (row.custom_name || null))
        const updatedName = updatedCustomName || updatedOriginalName
        const updatedCommand = command ?? row.command
        const updatedArgs = args ?? JSON.parse(row.args_json)
        const updatedEnv = env ?? JSON.parse(row.env_json)
        const updatedDescription = description !== undefined ? description.trim() : (row.description || '')

        db.prepare(
            'UPDATE mcp_servers SET name = ?, original_name = ?, custom_name = ?, command = ?, args_json = ?, env_json = ?, description = ?, updated_at = ? WHERE id = ?'
        ).run(updatedName, updatedOriginalName, updatedCustomName, updatedCommand, JSON.stringify(updatedArgs), JSON.stringify(updatedEnv), updatedDescription, Date.now(), id)

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
                const syncedOriginal = syncOriginalNameFromServerInfo(id, updatedOriginalName)
                const ns = buildMcpNamespace(id, updatedCustomName || syncedOriginal, manager)
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
        const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined

        if (!row) {
            return reply.status(404).send({ error: 'Server not found' })
        }

        const manager = getMcpManager()
        const registry = getToolRegistry()

        registry.unregisterByNamespace(`mcp:${id}`)

        const config: McpServerConfig = {
            id: row.id,
            name: effectiveName(row),
            command: row.command,
            args: JSON.parse(row.args_json),
            env: JSON.parse(row.env_json),
            enabled: row.enabled === 1
        }

        try {
            const tools = await manager.connect(config)
            const originalName = syncOriginalNameFromServerInfo(id, row.original_name || config.name)
            const ns = buildMcpNamespace(id, row.custom_name?.trim() || originalName, manager)
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
        const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined

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
            name: effectiveName(row),
            command: row.command,
            args,
            env: JSON.parse(row.env_json),
            enabled: row.enabled === 1
        }

        try {
            const tools = await manager.connect(config)
            const originalName = syncOriginalNameFromServerInfo(id, row.original_name || config.name)
            const ns = buildMcpNamespace(id, row.custom_name?.trim() || originalName, manager)
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
                return reply.type('text/html').send(renderOAuthCallbackPage({
                    title: 'Authorization Failed',
                    message: 'Cynosure could not complete authorization for this MCP server.',
                    detail: `Error: ${oauthError}`,
                    variant: 'error',
                }))
            }

            if (!code) {
                return reply.status(400).type('text/html').send(renderOAuthCallbackPage({
                    title: 'Missing Authorization Code',
                    message: 'No authorization code was provided in the callback.',
                    variant: 'warning',
                }))
            }

            const manager = getMcpManager()
            const registry = getToolRegistry()

            try {
                const tools = await manager.finishHttpAuth(serverId, code)
                // Tools were auto-registered via the auth-complete callback,
                // but register explicitly in case the callback wasn't set up
                const db = getDb()
                const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId) as McpServerRow | undefined
                if (row) {
                    const originalName = syncOriginalNameFromServerInfo(serverId, row.original_name || effectiveName(row))
                    const ns = buildMcpNamespace(serverId, row.custom_name?.trim() || originalName, manager)
                    registerMcpTools(tools, ns, registry)
                }

                return reply.type('text/html').send(renderOAuthCallbackPage({
                    title: 'Authorization Complete',
                    message: `${tools.length} tool(s) connected successfully. You can return to Cynosure.`,
                    variant: 'success',
                    autoClose: true,
                }))
            } catch (err) {
                return reply.status(500).type('text/html').send(renderOAuthCallbackPage({
                    title: 'Connection Failed',
                    message: 'Cynosure received the callback, but could not connect the MCP server.',
                    detail: (err as Error).message || 'Unknown error',
                    variant: 'error',
                }))
            }
        }
    )
}
