import { broadcast } from '../../../ws.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { ToolListChangedNotificationSchema, type Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import type { ToolDefinition, ToolResult } from '../../gateway/providers/base.provider.js'
import { McpOAuthProvider } from './oauth-provider.js'
import { normalizeMcpToolResult } from './mcp-result.js'
import { describeMcpConnectionError, toMcpConnectionError } from './connection-error.js'
import { existsSync, readdirSync, unlinkSync, rmSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { homedir } from 'os'

/** Rewrite absolute file paths in tool text output to API-served URLs */
function rewriteFilePathsInText(text: string): string {
    // Match absolute paths to common generated/readable artifact files.
    return text.replace(
        /(?:^|\s|\()((?:\/[^\s"'<>)]|%20)+\.(?:png|jpe?g|gif|webp|bmp|svg|mp4|webm|ogg|mp3|wav|flac|pdf|docx?|odt|rtf|txt|md))\b/gi,
        (match, path) => match.replace(path, `/api/files?path=${encodeURIComponent(path)}`)
    )
}

export interface McpServerConfig {
    id: string
    name: string
    command: string
    args: string[]
    env?: Record<string, string>
    enabled: boolean
}

type RemoteTransport = StreamableHTTPClientTransport | SSEClientTransport

interface McpConnection {
    client: Client
    transport: StdioClientTransport | RemoteTransport
    /** Config with the display name resolved from the server's metadata. */
    config: McpServerConfig
    /** Config exactly as stored, used to reconnect after an unexpected close. */
    sourceConfig: McpServerConfig
    tools: ToolDefinition[]
    slug: string
    serverInfo?: { title?: string; description?: string; websiteUrl?: string; icons?: Array<{ src: string; mimeType?: string }> }
    /** Whether this connection uses a remote transport (vs stdio). */
    isHttp?: boolean
    /** OAuth provider for remote connections (needed for re-auth). */
    oauthProvider?: McpOAuthProvider
}

interface PendingAuthConnection {
    client: Client
    transport: StdioClientTransport
    config: McpServerConfig
    connectPromise: Promise<void>
}

/** Pending remote OAuth flow — the client is waiting for an authorization callback. */
interface PendingHttpAuth {
    client: Client
    provider: McpOAuthProvider
    config: McpServerConfig
    remote: ParsedRemoteConfig
    expiry: NodeJS.Timeout
}

/**
 * Callback invoked whenever the tools a server exposes change outside an API
 * request: background OAuth completion, `tools/list_changed`, an unexpected
 * disconnect (`tools` is null) or a successful automatic reconnect.
 */
export type ToolsChangedCallback = (serverId: string, tools: ToolDefinition[] | null, config: McpServerConfig) => void

/** How long to keep the child process alive while waiting for OAuth (5 minutes). */
const AUTH_WAIT_TIMEOUT_MS = 5 * 60 * 1000
/** How long a remote OAuth flow may stay pending before it is discarded (15 minutes). */
const HTTP_AUTH_WAIT_TIMEOUT_MS = 15 * 60 * 1000
/** How long to wait for a standard MCP server to connect before timing out (60 seconds) */
const STANDARD_TIMEOUT_MS = 60 * 1000
/** Automatic reconnect after an unexpected close: 1s, 2s, 4s, 8s, 16s. */
const RECONNECT_MAX_ATTEMPTS = 5
const RECONNECT_BASE_DELAY_MS = 1000
/**
 * Tool calls time out after MCP_TOOL_TIMEOUT ms without a response or progress
 * notification, and never run longer than MCP_TOOL_MAX_TIMEOUT ms in total.
 */
const TOOL_IDLE_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT) || 60 * 1000
const TOOL_MAX_TIMEOUT_MS = Math.max(Number(process.env.MCP_TOOL_MAX_TIMEOUT) || 10 * 60 * 1000, TOOL_IDLE_TIMEOUT_MS)
const REMOTE_COMMAND = 'remote'

export type RemoteTransportKind = 'streamable-http' | 'sse'

type ParsedRemoteConfig = {
    url: string
    headers: Record<string, string>
    transport: RemoteTransportKind
}

/**
 * Expand `${VAR}` and `${VAR:-default}` references (same syntax as Claude Code's
 * .mcp.json). Unresolved references are left intact so the failure is visible.
 */
export function expandEnvRefs(value: string, env?: Record<string, string | undefined>): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name: string, fallback?: string) =>
        env?.[name] ?? process.env[name] ?? fallback ?? match)
}

export class McpManager {
    private connections = new Map<string, McpConnection>()
    private pendingAuths = new Map<string, string>()
    private pendingAuthConnections = new Map<string, PendingAuthConnection>()
    private pendingHttpAuths = new Map<string, PendingHttpAuth>()
    private reconnectTimers = new Map<string, NodeJS.Timeout>()
    /** Bumped on every explicit disconnect so in-flight automatic reconnects can tell they are stale. */
    private lifecycleGeneration = new Map<string, number>()
    private onToolsChangedCallback?: ToolsChangedCallback
    /** Base URL of the Cynosure server (e.g. http://127.0.0.1:3099). Set before connecting HTTP servers. */
    private serverBaseUrl = ''

    /** Register a callback that fires when a server's tools change in the background. */
    setOnToolsChanged(cb: ToolsChangedCallback): void {
        this.onToolsChangedCallback = cb
    }

    /** Set the base URL so HTTP connections can construct OAuth callback URLs. */
    setServerBaseUrl(url: string): void {
        this.serverBaseUrl = url
    }

    /** Sanitise a server name into a valid function-name segment */
    private sanitiseName(name: string): string {
        return name
            .toLowerCase()
            .replace(/^mcp[-_\s]+/i, '')  // Strip leading "mcp-" / "mcp_" prefix to avoid mcp_mcp_ doubling
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '')
            || 'server'
    }

    async connect(config: McpServerConfig): Promise<ToolDefinition[]> {
        // Tear down any existing connection for this server
        await this.teardown(config.id)

        // Use a remote transport for remote servers (manual remote, registry remotes, mcp-remote, Smithery)
        const remote = this.parseRemoteConfig(config)
        if (remote && this.serverBaseUrl) {
            try {
                return await this.connectHttp(config, remote)
            } catch (err) {
                // Auth-related errors should not fallback to stdio
                if (err instanceof UnauthorizedError ||
                    (err as Error).message?.includes('Authorization required')) {
                    throw err
                }
                // Non-auth error — fall back to stdio transport for wrapper commands only.
                if (config.command === REMOTE_COMMAND) throw err
                console.warn(`HTTP transport failed for "${config.name}", falling back to stdio:`, describeMcpConnectionError(err))
            }
        }

        return this.connectStdio(config)
    }

    private createRemoteTransport(remote: ParsedRemoteConfig, provider: McpOAuthProvider): RemoteTransport {
        const options = {
            authProvider: provider,
            requestInit: Object.keys(remote.headers).length ? { headers: remote.headers } : undefined,
        }
        return remote.transport === 'sse'
            ? new SSEClientTransport(new URL(remote.url), options)
            : new StreamableHTTPClientTransport(new URL(remote.url), options)
    }

    /** Connect using a remote transport (Streamable HTTP or legacy SSE) with OAuth support. */
    private async connectHttp(config: McpServerConfig, remote: ParsedRemoteConfig): Promise<ToolDefinition[]> {
        const callbackUrl = `${this.serverBaseUrl}/api/mcp/oauth/callback/${encodeURIComponent(config.id)}`
        let authUrl: string | null = null

        // Tokens are stored per server, so two entries for the same URL can use different accounts.
        const provider = new McpOAuthProvider(remote.url, callbackUrl, (url) => {
            authUrl = url
            this.pendingAuths.set(config.id, url)
            broadcast('mcp-auth-needed', {
                serverId: config.id,
                serverName: config.name,
                authUrl: url
            })
        }, McpOAuthProvider.serverStorageKey(config.id, remote.url))

        const client = new Client({ name: 'cynosure', version: '1.0.0' })
        const transport = this.createRemoteTransport(remote, provider)

        try {
            await client.connect(transport)
        } catch (err) {
            if (err instanceof UnauthorizedError || authUrl) {
                // OAuth is required — store pending auth and wait for callback
                console.warn(`MCP server "${config.name}" requires OAuth authorization (${remote.transport} transport).`)
                const expiry = setTimeout(() => { void this.expirePendingHttpAuth(config.id, client) }, HTTP_AUTH_WAIT_TIMEOUT_MS)
                expiry.unref?.()
                this.pendingHttpAuths.set(config.id, { client, provider, config, remote, expiry })
                throw new Error('Authorization required — use the Authorize button to connect.')
            }
            try { await transport.close() } catch { /* ignore */ }
            throw toMcpConnectionError(err)
        }

        return this.publishConnection(config, client, transport, { isHttp: true, oauthProvider: provider })
    }

    /** Drop a remote OAuth flow the user never completed. */
    private async expirePendingHttpAuth(serverId: string, client: Client): Promise<void> {
        const pending = this.pendingHttpAuths.get(serverId)
        if (!pending || pending.client !== client) return
        this.pendingHttpAuths.delete(serverId)
        this.pendingAuths.delete(serverId)
        try { await client.close() } catch { /* never connected */ }
        broadcast('mcp-server-status', { serverId, connected: false })
    }

    /**
     * Complete a remote OAuth flow after the user authorized in the browser.
     * Called from the OAuth callback route with the authorization code.
     */
    async finishHttpAuth(serverId: string, code: string, state?: string): Promise<ToolDefinition[]> {
        const pending = this.pendingHttpAuths.get(serverId)
        if (!pending) throw new Error('No pending HTTP auth for this server')
        if (!pending.provider.validateState(state)) throw new Error('Invalid OAuth state')

        // Create a fresh transport with the same provider (which holds the code verifier)
        const transport = this.createRemoteTransport(pending.remote, pending.provider)

        // Exchange the authorization code for tokens
        await transport.finishAuth(code)
        // Now connect — the provider has valid tokens
        try {
            await pending.client.connect(transport)
        } catch (err) {
            throw toMcpConnectionError(err)
        }

        clearTimeout(pending.expiry)
        this.pendingHttpAuths.delete(serverId)
        this.pendingAuths.delete(serverId)

        const tools = await this.publishConnection(pending.config, pending.client, transport, { isHttp: true, oauthProvider: pending.provider })
        const displayConfig = this.connections.get(serverId)?.config ?? pending.config

        this.onToolsChangedCallback?.(serverId, tools, displayConfig)
        broadcast('mcp-auth-complete', { serverId, serverName: displayConfig.name, toolCount: tools.length })

        return tools
    }

    /** Whether a server has a pending HTTP OAuth flow. */
    hasPendingHttpAuth(serverId: string): boolean {
        return this.pendingHttpAuths.has(serverId)
    }

    /** Connect using stdio transport (child process). */
    private async connectStdio(config: McpServerConfig): Promise<ToolDefinition[]> {
        // Spawn the MCP process from the user home directory so npm/npx doesn't
        // inherit workspace-level .npmrc, pnpm config, or package.json settings
        // that can interfere with on-demand package installation.
        const spawnCwd = homedir()

        const env = this.resolveEnv(config.env)
        const transport = new StdioClientTransport({
            command: expandEnvRefs(config.command, env),
            args: config.args.map(arg => expandEnvRefs(arg, env)),
            env: { ...process.env, ...env } as Record<string, string>,
            stderr: 'pipe',
            cwd: spawnCwd,
        })

        // Reject the connect race immediately when auth is detected in stderr,
        // so the API call returns fast instead of blocking for the full 30s.
        let authReject: ((err: Error) => void) | undefined
        const authNotice = new Promise<never>((_, reject) => { authReject = reject })

        let stderrBuffer = ''
        if (transport.stderr) {
            transport.stderr.on('data', (d: unknown) => {
                const str = String(d)
                process.stderr.write(str) // Keep printing it to the server console

                stderrBuffer += str
                // Keep buffer manageable
                if (stderrBuffer.length > 5000) stderrBuffer = stderrBuffer.slice(-5000)

                const authMatch = stderrBuffer.match(
                    /(?:Please authorize this client by visiting:|authorize[:\s]+|auth(?:orization)?\s+(?:required|needed)[:\s]*)\s*(https?:\/\/[^\s]+)/i
                )
                if (authMatch) {
                    this.pendingAuths.set(config.id, authMatch[1])
                    broadcast('mcp-auth-needed', {
                        serverId: config.id,
                        serverName: config.name,
                        authUrl: authMatch[1]
                    })
                    // clear buffer so we don't re-trigger for the exact same match forever
                    stderrBuffer = ''
                    // Signal the connect race to fail immediately
                    if (authReject) authReject(new Error('Authorization required'))
                }
            })
        }

        const client = new Client({
            name: 'cynosure',
            version: '1.0.0'
        })

        // Race between: successful connect, auth detection (instant), or 60s timeout.
        // When auth is detected via stderr, authNotice rejects immediately so the
        // API call returns fast while the child process stays alive in the background.
        const connectPromise = client.connect(transport)
        try {
            await Promise.race([
                connectPromise,
                authNotice,
                new Promise((_, reject) => setTimeout(() => reject(new Error('MCP connection timeout')), STANDARD_TIMEOUT_MS))
            ])
        } catch (e) {
            if (this.pendingAuths.has(config.id)) {
                // Keep the child process alive — it's running an HTTP server
                // to receive the OAuth callback from the user's browser.
                console.warn(`MCP server "${config.name}" requires authorization. Keeping process alive for OAuth callback.`)
                this.pendingAuthConnections.set(config.id, { client, transport, config, connectPromise })
                this.awaitPendingAuth(config.id)
                throw new Error('Authorization required — use the Authorize button to connect.')
            }
            console.error(`Failed to connect to MCP server ${config.name}:`, e)
            try { await transport.close() } catch { }
            const stderrHint = stderrBuffer.trim()
                ? ` Process output: ${stderrBuffer.trim().slice(0, 500)}`
                : ''
            const base = e instanceof Error ? e : new Error(String(e))
            throw new Error(`${base.message}${stderrHint}`)
        }

        return this.publishConnection(config, client, transport)
    }

    /**
     * Discover tools on a freshly connected client, store the connection and
     * wire up list-changed notifications and unexpected-close handling.
     */
    private async publishConnection(
        config: McpServerConfig,
        client: Client,
        transport: StdioClientTransport | RemoteTransport,
        extras: Pick<McpConnection, 'isHttp' | 'oauthProvider'> = {},
    ): Promise<ToolDefinition[]> {
        // Capture server-declared metadata (title, description, websiteUrl)
        const ver = client.getServerVersion()
        const serverInfo = ver ? { title: ver.title, description: ver.description, websiteUrl: ver.websiteUrl, icons: ver.icons as Array<{ src: string; mimeType?: string }> | undefined } : undefined
        const displayConfig = { ...config, name: serverInfo?.title || config.name }
        const mcpTools = await this.listAllTools(client)
        const slug = this.sanitiseName(displayConfig.name)
        const tools = this.buildToolDefinitions(mcpTools, client, displayConfig)

        this.connections.set(config.id, { client, transport, config: displayConfig, sourceConfig: config, tools, slug, serverInfo, ...extras })

        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
            void this.refreshTools(config.id, client)
        })
        client.onclose = () => this.handleUnexpectedClose(config.id, client)
        return tools
    }

    /** Re-discover tools after the server sent `notifications/tools/list_changed`. */
    private async refreshTools(serverId: string, client: Client): Promise<void> {
        const conn = this.connections.get(serverId)
        if (!conn || conn.client !== client) return
        try {
            const mcpTools = await this.listAllTools(client, false)
            if (this.connections.get(serverId)?.client !== client) return
            conn.tools = this.buildToolDefinitions(mcpTools, client, conn.config)
            this.onToolsChangedCallback?.(serverId, conn.tools, conn.config)
            broadcast('mcp-server-status', { serverId, connected: true, toolCount: conn.tools.length })
        } catch (err) {
            console.warn(`Failed to refresh tools for MCP server "${conn.config.name}":`, describeMcpConnectionError(err))
        }
    }

    /** The process exited or the remote stream dropped without us asking for it. */
    private handleUnexpectedClose(serverId: string, client: Client): void {
        const conn = this.connections.get(serverId)
        // An intentional disconnect removes the connection before closing it.
        if (!conn || conn.client !== client) return
        this.connections.delete(serverId)
        console.warn(`MCP server "${conn.config.name}" disconnected unexpectedly — reconnecting.`)
        this.onToolsChangedCallback?.(serverId, null, conn.config)
        broadcast('mcp-server-status', { serverId, connected: false })
        this.scheduleReconnect(conn.sourceConfig, 0)
    }

    private scheduleReconnect(config: McpServerConfig, attempt: number): void {
        if (attempt >= RECONNECT_MAX_ATTEMPTS) {
            console.warn(`Giving up reconnecting MCP server "${config.name}" after ${attempt} attempts.`)
            return
        }
        const generation = this.lifecycleGeneration.get(config.id) ?? 0
        const timer = setTimeout(async () => {
            this.reconnectTimers.delete(config.id)
            if ((this.lifecycleGeneration.get(config.id) ?? 0) !== generation) return
            try {
                const tools = await this.connect(config)
                // The server was disabled or removed while we were reconnecting.
                if ((this.lifecycleGeneration.get(config.id) ?? 0) !== generation) {
                    await this.teardown(config.id)
                    return
                }
                this.onToolsChangedCallback?.(config.id, tools, this.connections.get(config.id)?.config ?? config)
                broadcast('mcp-server-status', { serverId: config.id, connected: true, toolCount: tools.length })
                console.log(`MCP server "${config.name}" reconnected (${tools.length} tools)`)
            } catch (err) {
                // Needs the user to authorize again; the UI shows the Authorize button.
                if (this.hasPendingAuthConnection(config.id)) {
                    broadcast('mcp-server-status', { serverId: config.id, connected: false })
                    return
                }
                console.warn(`Reconnect attempt ${attempt + 1} for MCP server "${config.name}" failed:`, describeMcpConnectionError(err))
                this.scheduleReconnect(config, attempt + 1)
            }
        }, RECONNECT_BASE_DELAY_MS * 2 ** attempt)
        timer.unref?.()
        this.reconnectTimers.set(config.id, timer)
    }

    /**
     * Fetch the complete catalogue before publishing a connection to consumers.
     * During initial discovery a failure closes the client so it does not leak.
     */
    private async listAllTools(client: Client, closeOnError = true): Promise<McpTool[]> {
        const tools = new Map<string, McpTool>()
        const seenCursors = new Set<string>()
        let cursor: string | undefined
        try {
            do {
                const page = cursor === undefined
                    ? await client.listTools()
                    : await client.listTools({ cursor })
                for (const tool of page.tools) tools.set(tool.name, tool)
                cursor = page.nextCursor
                if (cursor !== undefined) {
                    if (seenCursors.has(cursor)) throw new Error('MCP tool pagination returned a repeated cursor')
                    seenCursors.add(cursor)
                }
            } while (cursor !== undefined)
        } catch (error) {
            // Discovery failed before the connection was stored; do not leak it.
            if (closeOnError) {
                try { await client.close() } catch { /* preserve the discovery error */ }
            }
            throw error
        }
        return [...tools.values()]
    }

    /** Build ToolDefinition wrappers from raw MCP tool descriptors. */
    private buildToolDefinitions(
        mcpTools: McpTool[],
        client: Client,
        _config: McpServerConfig
    ): ToolDefinition[] {
        return mcpTools.map((t) => ({
            name: t.name,
            title: t.title || t.annotations?.title,
            description: t.description || t.title || t.annotations?.title || t.name,
            parameters: (t.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
            outputSchema: t.outputSchema as Record<string, unknown> | undefined,
            icons: t.icons,
            providerMetadata: t._meta,
            // The SDK enforces the idle/total limits below; keep the executor's
            // hard timeout just above them so the MCP error message wins.
            timeout: TOOL_MAX_TIMEOUT_MS + 5000,
            annotations: t.annotations,
            // Preserve the MCP annotation's tri-state. Missing means unknown,
            // not explicitly mutating; routing and HITL handle those cases
            // differently.
            ...(t.annotations?.readOnlyHint === undefined
                ? {}
                : { execution: { readOnly: t.annotations.readOnlyHint === true } }),
            execute: async (params: unknown, signal?: AbortSignal): Promise<ToolResult> => {
                try {
                    const result = await client.callTool({
                        name: t.name,
                        arguments: (params as Record<string, unknown>) || {}
                    }, undefined, {
                        signal,
                        timeout: TOOL_IDLE_TIMEOUT_MS,
                        maxTotalTimeout: TOOL_MAX_TIMEOUT_MS,
                        // Long-running tools keep the call alive by sending progress.
                        // Supplying onprogress makes the SDK request progress updates.
                        resetTimeoutOnProgress: true,
                        onprogress: () => { /* only used to extend the timeout */ },
                    })
                    const normalized = normalizeMcpToolResult(result)

                    // Rewrite local file paths in tool text output to API URLs
                    // so the LLM sees usable HTTP URLs instead of filesystem paths
                    const rewrittenOutput = rewriteFilePathsInText(normalized.output)

                    return {
                        success: !result.isError,
                        output: rewrittenOutput,
                        error: result.isError ? rewrittenOutput : undefined,
                        content: normalized.content,
                        structuredContent: normalized.structuredContent,
                        providerMetadata: normalized.providerMetadata,
                        images: normalized.imageDataUrls,
                        imageDataUrls: normalized.imageDataUrls,
                        audioDataUrls: normalized.audioDataUrls,
                    }
                } catch (err) {
                    return {
                        success: false,
                        output: '',
                        error: describeMcpConnectionError(err)
                    }
                }
            }
        }))
    }

    /** Explicitly disconnect a server (disable/remove); also stops automatic reconnects. */
    async disconnect(serverId: string): Promise<void> {
        this.lifecycleGeneration.set(serverId, (this.lifecycleGeneration.get(serverId) ?? 0) + 1)
        await this.teardown(serverId)
    }

    /** Close the connection and any pending auth state without affecting reconnect bookkeeping. */
    private async teardown(serverId: string): Promise<void> {
        const timer = this.reconnectTimers.get(serverId)
        if (timer) {
            clearTimeout(timer)
            this.reconnectTimers.delete(serverId)
        }

        // Cancel any pending OAuth connection first (stdio or HTTP)
        await this.cancelPendingAuth(serverId)
        const pendingHttp = this.pendingHttpAuths.get(serverId)
        if (pendingHttp) {
            clearTimeout(pendingHttp.expiry)
            this.pendingHttpAuths.delete(serverId)
            try { await pendingHttp.client.close() } catch { /* never connected */ }
        }
        this.pendingAuths.delete(serverId)

        const conn = this.connections.get(serverId)
        if (!conn) return

        // Remove first so the client's onclose handler treats this as intentional.
        this.connections.delete(serverId)
        try {
            await conn.client.close()
        } catch {
            // Ignore close errors
        }
    }

    async disconnectAll(): Promise<void> {
        const ids = new Set([
            ...this.connections.keys(),
            ...this.pendingAuthConnections.keys(),
            ...this.pendingHttpAuths.keys(),
            ...this.reconnectTimers.keys(),
        ])
        for (const id of ids) {
            await this.disconnect(id)
        }
    }

    getTools(serverId: string): ToolDefinition[] {
        return this.connections.get(serverId)?.tools || []
    }

    getSlug(serverId: string): string {
        return this.connections.get(serverId)?.slug || 'server'
    }

    getAllTools(): ToolDefinition[] {
        const allTools: ToolDefinition[] = []
        for (const conn of this.connections.values()) {
            allTools.push(...conn.tools)
        }
        return allTools
    }

    isConnected(serverId: string): boolean {
        return this.connections.has(serverId)
    }

    getServerInfo(serverId: string): { title?: string; description?: string; websiteUrl?: string; icons?: Array<{ src: string; mimeType?: string }> } | undefined {
        return this.connections.get(serverId)?.serverInfo
    }

    getConnectedIds(): string[] {
        return Array.from(this.connections.keys())
    }

    getPendingAuths(): Record<string, string> {
        return Object.fromEntries(this.pendingAuths)
    }

    /** Whether a server has an active pending OAuth flow (stdio or HTTP). */
    hasPendingAuthConnection(serverId: string): boolean {
        return this.pendingAuthConnections.has(serverId) || this.pendingHttpAuths.has(serverId)
    }

    /**
     * Wait in the background for a pending OAuth flow to complete.
     * When the user finishes authorizing in their browser, the child process
     * receives the callback, exchanges the code for tokens, and the MCP stdio
     * connection succeeds. This method awaits that with a generous timeout.
     */
    private async awaitPendingAuth(serverId: string): Promise<void> {
        const pending = this.pendingAuthConnections.get(serverId)
        if (!pending) return

        try {
            await Promise.race([
                pending.connectPromise,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('OAuth authorization timed out')), AUTH_WAIT_TIMEOUT_MS)
                )
            ])

            // OAuth completed and connection succeeded — finalize
            this.pendingAuthConnections.delete(serverId)
            this.pendingAuths.delete(serverId)

            const tools = await this.publishConnection(pending.config, pending.client, pending.transport)
            const displayConfig = this.connections.get(serverId)?.config ?? pending.config

            console.log(`MCP server "${displayConfig.name}" connected after OAuth (${tools.length} tools)`)

            this.onToolsChangedCallback?.(serverId, tools, displayConfig)

            broadcast('mcp-auth-complete', {
                serverId,
                serverName: displayConfig.name,
                toolCount: tools.length
            })

        } catch (err) {
            console.warn(`OAuth wait for MCP server "${pending.config.name}" failed:`, (err as Error).message)
            this.pendingAuthConnections.delete(serverId)
            try { await pending.transport.close() } catch { }
        }
    }

    /** Kill a pending auth connection's child process. */
    private async cancelPendingAuth(serverId: string): Promise<void> {
        const pending = this.pendingAuthConnections.get(serverId)
        if (!pending) return
        try { await pending.transport.close() } catch { }
        this.pendingAuthConnections.delete(serverId)
        this.pendingAuths.delete(serverId)
    }

    /**
     * Extract the remote server URL from MCP args (e.g. `['mcp-remote', 'https://...']`
     * or `['@smithery/cli@latest', 'run', '<identifier>']`).
     */
    static extractRemoteUrl(args: string[]): string | null {
        const explicitUrl = McpManager.getArgValue(args, '--url')
        if (explicitUrl?.startsWith('http')) return explicitUrl

        // mcp-remote pattern: npx -y mcp-remote https://server.url
        const remoteIdx = args.indexOf('mcp-remote')
        if (remoteIdx >= 0 && remoteIdx + 1 < args.length) {
            const url = args[remoteIdx + 1]
            if (url.startsWith('http')) return url
        }
        // Check for any https:// URL in args
        for (const a of args) {
            if (/^https?:\/\//.test(a)) return a
        }
        // Smithery CLI pattern: @smithery/cli run <identifier>
        // The CLI internally connects to https://<identifier>.run.tools
        const runIdx = args.indexOf('run')
        if (runIdx >= 0 && args.some(a => a.includes('@smithery/cli'))) {
            const identifier = args[runIdx + 1]
            if (identifier && !identifier.startsWith('-')) {
                return `https://${identifier}.run.tools`
            }
        }
        return null
    }

    /** Whether a config describes a remote server rather than a local command. */
    static isRemoteConfig(config: Pick<McpServerConfig, 'command' | 'args'>): boolean {
        return config.command === REMOTE_COMMAND
            || config.args.includes('mcp-remote')
            || config.args.some(a => a.includes('@smithery/cli'))
    }

    /**
     * Only explicit remote configs are connected over HTTP: `command: "remote"`
     * or the known wrappers (mcp-remote, Smithery). A local server that merely
     * takes a URL argument (e.g. `--api-base https://...`) stays on stdio.
     */
    private parseRemoteConfig(config: McpServerConfig): ParsedRemoteConfig | null {
        if (!McpManager.isRemoteConfig(config)) return null
        const rawUrl = McpManager.extractRemoteUrl(config.args)
        if (!rawUrl) return null
        const env = this.resolveEnv(config.env)
        const lookup = (name: string) => env[name] || process.env[name] || ''

        const headers: Record<string, string> = {}
        const addHeader = (header: string) => {
            const sepIdx = header.indexOf(':')
            if (sepIdx <= 0) return
            const key = header.slice(0, sepIdx).trim()
            const value = expandEnvRefs(header.slice(sepIdx + 1).trim(), env)
            if (key && value) headers[key] = value
        }
        config.args.forEach((arg, idx) => {
            if (arg.startsWith('--header=')) addHeader(arg.slice('--header='.length))
            // mcp-remote style: `--header "Name: value"`
            else if (arg === '--header' && idx + 1 < config.args.length) addHeader(config.args[idx + 1])

            if (arg.startsWith('--header-env=')) {
                const header = arg.slice('--header-env='.length)
                const sepIdx = header.indexOf('=')
                if (sepIdx > 0) {
                    const key = header.slice(0, sepIdx).trim()
                    const value = lookup(header.slice(sepIdx + 1).trim())
                    if (key && value) headers[key] = value
                }
            }
        })

        const bearerEnv = McpManager.getArgValue(config.args, '--bearer-token-env')
        const bearerToken = bearerEnv ? lookup(bearerEnv) : ''
        if (bearerToken && !headers.Authorization) {
            headers.Authorization = `Bearer ${bearerToken}`
        }

        // `--transport sse` (ours) or mcp-remote's `sse-only` / `sse-first`.
        const transportArg = McpManager.getArgValue(config.args, '--transport') || ''
        const transport: RemoteTransportKind = transportArg.startsWith('sse') ? 'sse' : 'streamable-http'

        return { url: expandEnvRefs(rawUrl, env), headers, transport }
    }

    /** Server env with `${VAR}` references in its values expanded against the process env. */
    private resolveEnv(env?: Record<string, string>): Record<string, string> {
        const resolved: Record<string, string> = {}
        for (const [key, value] of Object.entries(env || {})) {
            resolved[key] = expandEnvRefs(value)
        }
        return resolved
    }

    private static getArgValue(args: string[], name: string): string | null {
        const eqPrefix = `${name}=`
        const eqArg = args.find(arg => arg.startsWith(eqPrefix))
        if (eqArg) return eqArg.slice(eqPrefix.length)

        const idx = args.indexOf(name)
        if (idx >= 0 && idx + 1 < args.length) return args[idx + 1]
        return null
    }

    /**
     * Clear cached OAuth tokens for a remote server.
     * Clears mcp-remote tokens (~/.mcp-auth/) and direct OAuth tokens
     * (<appDataDir>/mcp-oauth/), both the per-server and the legacy per-URL store.
     * Returns the number of items deleted.
     */
    static clearMcpRemoteAuth(remoteUrl: string, serverId?: string): number {
        const hash = createHash('md5').update(remoteUrl).digest('hex')
        let deleted = 0

        // Clear mcp-remote cache (~/.mcp-auth/mcp-remote-{version}/<hash>*)
        const authDir = join(homedir(), '.mcp-auth')
        if (existsSync(authDir)) {
            try {
                for (const sub of readdirSync(authDir)) {
                    const subDir = join(authDir, sub)
                    try {
                        for (const file of readdirSync(subDir)) {
                            if (file.startsWith(hash)) {
                                unlinkSync(join(subDir, file))
                                deleted++
                            }
                        }
                    } catch { /* not a directory or permission error */ }
                }
            } catch { /* auth dir unreadable */ }
        }

        // Clear direct OAuth provider caches (<appDataDir>/mcp-oauth/<hash>/)
        const oauthDirs = [McpOAuthProvider.storageDirFor(remoteUrl)]
        if (serverId) oauthDirs.push(McpOAuthProvider.storageDirFor(McpOAuthProvider.serverStorageKey(serverId, remoteUrl)))
        for (const oauthDir of oauthDirs) {
            if (!existsSync(oauthDir)) continue
            try {
                rmSync(oauthDir, { recursive: true, force: true })
                deleted++
            } catch { /* ignore */ }
        }

        return deleted
    }
}

let instance: McpManager | null = null

export function getMcpManager(): McpManager {
    if (!instance) {
        instance = new McpManager()
    }
    return instance
}
