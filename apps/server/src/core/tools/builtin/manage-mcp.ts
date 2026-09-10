import { getDb } from '../../../db/database.js'
import type { ToolDefinition, ToolResult } from '../../gateway/providers/base.provider.js'
import { getToolRegistry, type ToolNamespace } from '../tool-registry.js'
import { createMcpServerId } from '../../../routes/mcp/server-id.js'
import { getMcpManager, McpManager, type McpServerConfig } from '../mcp/mcp-manager.js'

export const MANAGE_MCP_TOOL_NAME = 'manage_mcp'

type McpServerRow = {
  id: string
  name: string
  original_name?: string | null
  custom_name?: string | null
  command: string
  args_json: string
  env_json: string
  enabled: number
  description?: string | null
  created_at?: number
}

type ManageMcpArgs = {
  action?: 'upsert' | 'list' | 'remove'
  serverId?: string
  name?: string
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string | null>
  replaceEnv?: boolean
  enabled?: boolean
  description?: string
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function displayName(row: McpServerRow): string {
  return text(row.custom_name) || text(row.original_name) || row.name
}

function publicServer(row: McpServerRow): Record<string, unknown> {
  const manager = getMcpManager()
  return {
    serverId: row.id,
    name: displayName(row),
    command: row.command,
    args: redactArgs(JSON.parse(row.args_json) as string[]),
    envKeys: Object.keys(JSON.parse(row.env_json) as Record<string, string>),
    enabled: row.enabled === 1,
    connected: manager.isConnected(row.id),
    toolCount: manager.getTools(row.id).length,
    description: row.description || '',
    pendingAuthUrl: manager.getPendingAuths()[row.id] || undefined,
  }
}

function redactArgs(args: string[]): string[] {
  let redactNext = false
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false
      return '[redacted]'
    }
    if (/^--(?:token|access-token|api-key|password|secret)$/i.test(arg)) {
      redactNext = true
      return arg
    }
    if (/^--(?:token|access-token|api-key|password|secret)=/i.test(arg)) {
      return `${arg.slice(0, arg.indexOf('=') + 1)}[redacted]`
    }
    if (/^--header=authorization:/i.test(arg)) return '--header=Authorization: [redacted]'
    return arg
  })
}

function findServer(args: ManageMcpArgs): McpServerRow | undefined {
  const db = getDb()
  const serverId = text(args.serverId)
  if (serverId) {
    return db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId) as McpServerRow | undefined
  }

  const name = text(args.name)
  if (!name) return undefined
  return db.prepare(
    `SELECT * FROM mcp_servers
     WHERE lower(id) = lower(?) OR lower(name) = lower(?)
        OR lower(COALESCE(original_name, '')) = lower(?)
        OR lower(COALESCE(custom_name, '')) = lower(?)
     ORDER BY created_at LIMIT 1`,
  ).get(name, name, name, name) as McpServerRow | undefined
}

function namespaceFor(row: McpServerRow): ToolNamespace {
  const serverInfo = getMcpManager().getServerInfo(row.id)
  return {
    id: `mcp:${row.id}`,
    label: displayName(row) || serverInfo?.title || row.id,
    description: text(row.description) || serverInfo?.description,
  }
}

async function applyConnection(row: McpServerRow, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted()
  const manager = getMcpManager()
  const registry = getToolRegistry()
  registry.unregisterByNamespace(`mcp:${row.id}`)

  if (row.enabled !== 1) {
    await manager.disconnect(row.id)
    return publicServer(row)
  }

  const config: McpServerConfig = {
    id: row.id,
    name: displayName(row),
    command: row.command,
    args: JSON.parse(row.args_json) as string[],
    env: JSON.parse(row.env_json) as Record<string, string>,
    enabled: true,
  }
  try {
    const tools = await manager.connect(config)
    if (signal?.aborted) {
      await manager.disconnect(row.id)
      signal.throwIfAborted()
    }
    for (const tool of tools) registry.register(tool, namespaceFor(row))
    return { ...publicServer(row), connected: true, toolCount: tools.length }
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    return {
      ...publicServer(row),
      connected: false,
      error: (error as Error).message,
      pendingAuthUrl: manager.getPendingAuths()[row.id] || undefined,
    }
  }
}

function result(payload: Record<string, unknown>, success = true): ToolResult {
  return { success, output: JSON.stringify(payload, null, 2) }
}

export async function manageMcp(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
  const args = input && typeof input === 'object' ? input as ManageMcpArgs : {}
  const action = args.action || 'upsert'
  const db = getDb()

  if (!['upsert', 'list', 'remove'].includes(action)) {
    return result({ error: `Unknown action "${String(action)}".` }, false)
  }

  if (action === 'list') {
    const rows = db.prepare('SELECT * FROM mcp_servers ORDER BY created_at').all() as McpServerRow[]
    return result({ servers: rows.map(publicServer) })
  }

  const existing = findServer(args)
  if (action === 'upsert' && text(args.serverId) && !existing) {
    return result({ error: `No MCP server matches serverId "${text(args.serverId)}". Use action=list to inspect installed servers, or omit serverId to install a new one.` }, false)
  }
  if (action !== 'upsert' && !existing) {
    return result({ error: 'No matching MCP server. Provide its serverId (preferred) or exact name. Use action=list to inspect installed servers.' }, false)
  }

  if (action === 'remove') {
    const row = existing!
    const remoteUrl = McpManager.extractRemoteUrl(JSON.parse(row.args_json) as string[])
    getToolRegistry().unregisterByNamespace(`mcp:${row.id}`)
    await getMcpManager().disconnect(row.id)
    if (remoteUrl) McpManager.clearMcpRemoteAuth(remoteUrl)
    db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(row.id)
    return result({ action: 'removed', serverId: row.id, name: displayName(row) })
  }

  const requestedName = text(args.name)
  const requestedUrl = text(args.url)
  if (requestedUrl && args.args !== undefined) {
    return result({ error: 'Provide either url or args, not both. url creates the complete remote argument list.' }, false)
  }
  if (requestedUrl && !/^https?:\/\//i.test(requestedUrl)) {
    return result({ error: 'url must start with http:// or https://.' }, false)
  }

  if (!existing && !text(args.command) && !requestedUrl) {
    return result({ error: 'A new MCP server requires command for stdio, or url for Streamable HTTP.' }, false)
  }

  const now = Date.now()
  const id = existing?.id || createMcpServerId(requestedName || requestedUrl || text(args.command) || 'MCP Server')
  const originalName = text(existing?.original_name) || requestedName || requestedUrl || text(args.command) || 'MCP Server'
  const customName = requestedName || text(existing?.custom_name)
  const name = customName || originalName
  const command = requestedUrl ? 'remote' : (text(args.command) || existing?.command || '')
  const storedArgs = existing ? JSON.parse(existing.args_json) as string[] : []
  const commandArgs = args.args ?? (requestedUrl ? ['--url', requestedUrl] : storedArgs)
  const storedEnv = existing ? JSON.parse(existing.env_json) as Record<string, string> : {}
  const env = args.replaceEnv ? {} as Record<string, string> : { ...storedEnv }
  for (const [key, value] of Object.entries(args.env || {})) {
    if (value === null) delete env[key]
    else env[key] = value
  }
  const enabled = args.enabled ?? (existing ? existing.enabled === 1 : true)
  const description = args.description !== undefined ? args.description.trim() : (existing?.description || '')

  if (existing) {
    db.prepare(
      `UPDATE mcp_servers SET name = ?, custom_name = ?, command = ?, args_json = ?, env_json = ?,
       enabled = ?, description = ?, updated_at = ? WHERE id = ?`,
    ).run(name, customName || null, command, JSON.stringify(commandArgs), JSON.stringify(env), enabled ? 1 : 0, description, now, id)
  } else {
    db.prepare(
      `INSERT INTO mcp_servers
       (id, name, original_name, custom_name, command, args_json, env_json, enabled, origin, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, originalName, customName || null, command, JSON.stringify(commandArgs), JSON.stringify(env), enabled ? 1 : 0, 'ai-install', description, now, now)
  }

  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow
  const connection = await applyConnection(row, signal)
  return result({ action: existing ? 'updated' : 'installed', ...connection }, !('error' in connection))
}

export function makeManageMcpTool(): ToolDefinition {
  return {
    name: MANAGE_MCP_TOOL_NAME,
    execution: { readOnly: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description: 'Install and manage MCP servers. Defaults to an idempotent upsert: use the returned serverId for follow-up corrections. Supports stdio command/args or a Streamable HTTP url, environment-variable patches, enable/disable, listing, and removal. Explicit reconnects and OAuth reauthorization must be performed manually in MCP settings. Never invent credentials; ask the user for missing secrets.',
    timeout: 70_000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['upsert', 'list', 'remove'], description: 'Operation to perform. Defaults to upsert.' },
        serverId: { type: 'string', description: 'Stable id returned by this tool. Required for unambiguous updates and removal.' },
        name: { type: 'string', description: 'Display name. On upsert without serverId, an exact installed-name match is updated.' },
        command: { type: 'string', description: 'Executable for a stdio MCP server, such as npx, uvx, node, or python.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Complete replacement argument list for the command.' },
        url: { type: 'string', description: 'Streamable HTTP MCP URL. Shorthand for command="remote" and args=["--url", url].' },
        env: {
          type: 'object',
          additionalProperties: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          description: 'Environment patch. String values set keys; null removes keys. Existing keys are preserved unless replaceEnv is true.',
        },
        replaceEnv: { type: 'boolean', description: 'Clear existing environment keys before applying env. Defaults to false.' },
        enabled: { type: 'boolean', description: 'Enable/connect or disable/disconnect the server.' },
        description: { type: 'string', description: 'Human-readable capability description.' },
      },
    },
    execute: manageMcp,
  }
}
