import { broadcast } from '../../../ws.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolDefinition, ToolResult } from '../../gateway/providers/base.provider.js'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { getAppDataDir } from '../../data-dir.js'
import { nanoid } from 'nanoid'

/** Directory for MCP tool-generated images */
function getMcpImagesDir(): string {
    const dir = join(getAppDataDir(), 'mcp-images')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
}

/** Save base64 image data to a file and return the absolute path */
function saveMcpImage(base64Data: string, ext: string): string {
    const filename = `${nanoid()}.${ext}`
    const filepath = join(getMcpImagesDir(), filename)
    writeFileSync(filepath, Buffer.from(base64Data, 'base64'))
    return filepath
}

/** Rewrite absolute file paths in tool text output to API-served URLs */
function rewriteFilePathsInText(text: string): string {
    // Match absolute paths to common image/media files
    return text.replace(
        /(?:^|\s)(\/[^\s"'<>]+\.(?:png|jpe?g|gif|webp|bmp|svg|mp4|webm|ogg|mp3|wav|flac|pdf))\b/gi,
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

interface McpConnection {
    client: Client
    transport: StdioClientTransport
    config: McpServerConfig
    tools: ToolDefinition[]
    slug: string
    serverInfo?: { title?: string; description?: string; websiteUrl?: string }
}

interface PendingAuthConnection {
    client: Client
    transport: StdioClientTransport
    config: McpServerConfig
    connectPromise: Promise<void>
}

/** Callback invoked when a pending OAuth flow completes and an MCP server auto-connects. */
export type AuthCompleteCallback = (serverId: string, tools: ToolDefinition[], config: McpServerConfig) => void

/** How long to keep the child process alive while waiting for OAuth (5 minutes). */
const AUTH_WAIT_TIMEOUT_MS = 5 * 60 * 1000

class McpManager {
    private connections = new Map<string, McpConnection>()
    private pendingAuths = new Map<string, string>()
    private pendingAuthConnections = new Map<string, PendingAuthConnection>()
    private onAuthCompleteCallback?: AuthCompleteCallback

    /**
     * Register a callback that fires when a pending OAuth flow completes
     * and the MCP server successfully connects in the background.
     */
    setOnAuthComplete(cb: AuthCompleteCallback): void {
        this.onAuthCompleteCallback = cb
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
        // Disconnect any existing connection for this server
        await this.disconnect(config.id)
        // Clear any stale auth state from previous attempts
        this.pendingAuths.delete(config.id)

        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
            stderr: 'pipe'
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

                const authMatch = stderrBuffer.match(/Please authorize this client by visiting:\s*(https?:\/\/[^\s]+)/i)
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
            name: 'open-agent',
            version: '1.0.0'
        })

        // Race between: successful connect, auth detection (instant), or 30s timeout.
        // When auth is detected via stderr, authNotice rejects immediately so the
        // API call returns fast while the child process stays alive in the background.
        const connectPromise = client.connect(transport)
        try {
            await Promise.race([
                connectPromise,
                authNotice,
                new Promise((_, reject) => setTimeout(() => reject(new Error('MCP connection timeout')), 30000))
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
            throw e
        }

        const { tools: mcpTools } = await client.listTools()

        const slug = this.sanitiseName(config.name)
        const tools = this.buildToolDefinitions(mcpTools, client, config)

        // Capture server-declared metadata (title, description, websiteUrl)
        const ver = client.getServerVersion()
        const serverInfo = ver ? { title: ver.title, description: ver.description, websiteUrl: ver.websiteUrl } : undefined

        this.connections.set(config.id, { client, transport, config, tools, slug, serverInfo })
        return tools
    }

    /** Build ToolDefinition wrappers from raw MCP tool descriptors. */
    private buildToolDefinitions(
        mcpTools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
        client: Client,
        config: McpServerConfig
    ): ToolDefinition[] {
        return mcpTools.map((t) => ({
            name: t.name,
            description: `[MCP: ${config.name}] ${t.description || t.name}`,
            parameters: (t.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
            timeout: 60000,
            execute: async (params: unknown): Promise<ToolResult> => {
                try {
                    const result = await client.callTool({
                        name: t.name,
                        arguments: (params as Record<string, unknown>) || {}
                    })

                    const parts = result.content as Array<{
                        type: string
                        text?: string
                        data?: string
                        mimeType?: string
                    }>

                    const textOutput = parts
                        .filter((c) => c.type === 'text')
                        .map((c) => c.text || '')
                        .join('\n')

                    // Save base64 image content to managed mcp-images directory.
                    // This avoids passing huge data URLs through WebSocket/LLM context
                    // and gives us a durable copy we control (cleanup on conversation delete).
                    const imageUrls: string[] = []
                    const imageDataUrls: string[] = []
                    for (const c of parts) {
                        if (c.type === 'image' && c.data && c.mimeType) {
                            const ext = c.mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
                            const savedPath = saveMcpImage(c.data, ext)
                            imageUrls.push(`/api/files?path=${encodeURIComponent(savedPath)}`)
                            imageDataUrls.push(`data:${c.mimeType};base64,${c.data}`)
                        }
                    }

                    // Rewrite local file paths in tool text output to API URLs
                    // so the LLM sees usable HTTP URLs instead of filesystem paths
                    const rewrittenOutput = rewriteFilePathsInText(textOutput)

                    return {
                        success: !result.isError,
                        output: rewrittenOutput || (imageUrls.length ? `(${imageUrls.length} image(s) returned)` : '(no output)'),
                        error: result.isError ? rewrittenOutput : undefined,
                        images: imageUrls.length ? imageUrls : undefined,
                        imageDataUrls: imageDataUrls.length ? imageDataUrls : undefined
                    }
                } catch (err) {
                    return {
                        success: false,
                        output: '',
                        error: (err as Error).message
                    }
                }
            }
        }))
    }

    async disconnect(serverId: string): Promise<void> {
        // Cancel any pending OAuth connection first
        await this.cancelPendingAuth(serverId)

        const conn = this.connections.get(serverId)
        if (!conn) return

        try {
            await conn.client.close()
        } catch {
            // Ignore close errors
        }
        this.connections.delete(serverId)
    }

    async disconnectAll(): Promise<void> {
        for (const id of this.connections.keys()) {
            await this.disconnect(id)
        }
        // Also clean up any pending auth connections
        for (const id of this.pendingAuthConnections.keys()) {
            await this.cancelPendingAuth(id)
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

    getServerInfo(serverId: string): { title?: string; description?: string; websiteUrl?: string } | undefined {
        return this.connections.get(serverId)?.serverInfo
    }

    getConnectedIds(): string[] {
        return Array.from(this.connections.keys())
    }

    getPendingAuths(): Record<string, string> {
        return Object.fromEntries(this.pendingAuths)
    }

    /** Whether a server has an active pending OAuth flow with its process still alive. */
    hasPendingAuthConnection(serverId: string): boolean {
        return this.pendingAuthConnections.has(serverId)
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

            const { tools: mcpTools } = await pending.client.listTools()
            const slug = this.sanitiseName(pending.config.name)
            const tools = this.buildToolDefinitions(mcpTools, pending.client, pending.config)

            this.connections.set(pending.config.id, {
                client: pending.client,
                transport: pending.transport,
                config: pending.config,
                tools,
                slug,
                serverInfo: (() => {
                    const v = pending.client.getServerVersion()
                    return v ? { title: v.title, description: v.description, websiteUrl: v.websiteUrl } : undefined
                })()
            })

            console.log(`MCP server "${pending.config.name}" connected after OAuth (${tools.length} tools)`)

            broadcast('mcp-auth-complete', {
                serverId,
                serverName: pending.config.name,
                toolCount: tools.length
            })

            if (this.onAuthCompleteCallback) {
                this.onAuthCompleteCallback(serverId, tools, pending.config)
            }
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
}

let instance: McpManager | null = null

export function getMcpManager(): McpManager {
    if (!instance) {
        instance = new McpManager()
    }
    return instance
}
