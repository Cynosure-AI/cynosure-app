import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { McpOAuthProvider } from './oauth-provider.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import { McpManager, type McpServerConfig } from './mcp-manager.js'

describe('McpManager paginated discovery', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-mcp-pagination-'))
    vi.stubEnv('CYNOSURE_DATA_DIR', directory)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  function descriptor(name: string): McpTool {
    return { name, description: name, inputSchema: { type: 'object', properties: {} } }
  }

  function listAllTools(client: Pick<Client, 'listTools'>): Promise<McpTool[]> {
    const manager = new McpManager()
    return (manager as unknown as { listAllTools(client: Pick<Client, 'listTools' | 'close'>): Promise<McpTool[]> })
      .listAllTools({ ...client, close: vi.fn().mockResolvedValue(undefined) })
  }

  test.each(['stdio', 'http'])('publishes tools from every page on %s connection', async (transport) => {
    vi.useFakeTimers()
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue()
    vi.spyOn(Client.prototype, 'getServerVersion').mockReturnValue({ name: 'test', version: '1' })
    const list = vi.spyOn(Client.prototype, 'listTools')
      .mockResolvedValueOnce({ tools: [descriptor('first')], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ tools: [descriptor('second')], nextCursor: 'page-3' })
      .mockResolvedValueOnce({ tools: [descriptor('third')] })
    const manager = new McpManager()
    manager.setServerBaseUrl('http://localhost:3099')
    const tools = await manager.connect({ id: 'server', name: 'Test', command: transport === 'http' ? 'remote' : 'test', args: transport === 'http' ? ['https://example.test/mcp'] : [], enabled: true })
    expect(list.mock.calls).toEqual([[], [{ cursor: 'page-2' }], [{ cursor: 'page-3' }]])
    expect(tools.map(tool => tool.name)).toEqual(['first', 'second', 'third'])
    expect(manager.getTools('server')).toEqual(tools)
    expect(manager.getAllTools()).toEqual(tools)
  })

  test('completes remote OAuth with validated state and original connection headers', async () => {
    let provider: McpOAuthProvider | undefined
    const connect = vi.spyOn(Client.prototype, 'connect')
      .mockImplementationOnce(async (transport) => {
        provider = (transport as unknown as { _authProvider: McpOAuthProvider })._authProvider
        provider.redirectToAuthorization(new URL(`https://auth.example.test/authorize?state=${provider.state()}`))
        throw new UnauthorizedError()
      })
      .mockResolvedValueOnce()
    const exchange = vi.spyOn(StreamableHTTPClientTransport.prototype, 'finishAuth').mockResolvedValue()
    vi.spyOn(Client.prototype, 'getServerVersion').mockReturnValue({ name: 'test', version: '1' })
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [descriptor('authorized_tool')] })
    const manager = new McpManager()
    manager.setServerBaseUrl('http://localhost:3099')
    const registered = vi.fn()
    manager.setOnToolsChanged(registered)
    await expect(manager.connect({ id: 'oauth', name: 'OAuth', command: 'remote',
      args: ['--url', 'https://example.test/mcp', '--header=X-Tenant: team'], enabled: true,
    })).rejects.toThrow('Authorization required')
    expect(manager.getPendingAuths().oauth).toContain('https://auth.example.test/authorize')
    await expect(manager.finishHttpAuth('oauth', 'code', 'wrong-state')).rejects.toThrow('Invalid OAuth state')
    expect(exchange).not.toHaveBeenCalled()
    const tools = await manager.finishHttpAuth('oauth', 'code', provider!.state())
    expect(exchange).toHaveBeenCalledWith('code')
    const resumed = connect.mock.calls[1][0] as unknown as { _requestInit: { headers: Record<string, string> } }
    expect(resumed._requestInit.headers).toEqual({ 'X-Tenant': 'team' })
    expect(tools.map(tool => tool.name)).toEqual(['authorized_tool'])
    expect(manager.isConnected('oauth')).toBe(true)
    expect(manager.hasPendingHttpAuth('oauth')).toBe(false)
    expect(manager.getPendingAuths()).toEqual({})
    expect(registered).toHaveBeenCalledWith('oauth', tools, expect.objectContaining({ id: 'oauth' }))
    await expect(manager.finishHttpAuth('oauth', 'code', provider!.state())).rejects.toThrow('No pending HTTP auth')
  })

  test('disabling a server cancels pending remote OAuth', async () => {
    vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async (transport) => {
      const provider = (transport as unknown as { _authProvider: McpOAuthProvider })._authProvider
      provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'))
      throw new UnauthorizedError()
    })
    const manager = new McpManager()
    manager.setServerBaseUrl('http://localhost:3099')
    await expect(manager.connect({ id: 'oauth', name: 'OAuth', command: 'remote',
      args: ['https://example.test/mcp'], enabled: true,
    })).rejects.toThrow('Authorization required')
    await manager.disconnect('oauth')
    expect(manager.hasPendingHttpAuth('oauth')).toBe(false)
    expect(manager.getPendingAuths()).toEqual({})
  })

  test('keeps single-page discovery unchanged', async () => {
    const listTools = vi.fn().mockResolvedValue({ tools: [descriptor('only')] })
    expect(await listAllTools({ listTools })).toEqual([descriptor('only')])
    expect(listTools).toHaveBeenCalledTimes(1)
  })

  test('continues through an empty page and preserves opaque cursors', async () => {
    const listTools = vi.fn()
      .mockResolvedValueOnce({ tools: [], nextCursor: 'opaque + /=' })
      .mockResolvedValueOnce({ tools: [descriptor('last')] })
    expect(await listAllTools({ listTools })).toEqual([descriptor('last')])
    expect(listTools).toHaveBeenLastCalledWith({ cursor: 'opaque + /=' })
  })

  test('deduplicates overlapping pages by tool name', async () => {
    const updated = { ...descriptor('shared'), description: 'Updated metadata' }
    const listTools = vi.fn()
      .mockResolvedValueOnce({ tools: [descriptor('shared')], nextCursor: 'next' })
      .mockResolvedValueOnce({ tools: [updated] })
    expect(await listAllTools({ listTools })).toEqual([updated])
  })

  test('rejects repeated cursors instead of looping forever', async () => {
    const listTools = vi.fn().mockResolvedValue({ tools: [], nextCursor: 'same' })
    await expect(listAllTools({ listTools })).rejects.toThrow('repeated cursor')
    expect(listTools).toHaveBeenCalledTimes(2)
  })

  test('a later-page failure does not publish a partial connection', async () => {
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue()
    const close = vi.spyOn(Client.prototype, 'close').mockResolvedValue()
    vi.spyOn(Client.prototype, 'getServerVersion').mockReturnValue({ name: 'test', version: '1' })
    vi.spyOn(Client.prototype, 'listTools')
      .mockResolvedValueOnce({ tools: [descriptor('first')], nextCursor: 'next' })
      .mockRejectedValueOnce(new Error('Second page unavailable'))
    const manager = new McpManager()
    manager.setServerBaseUrl('http://localhost:3099')
    await expect(manager.connect({ id: 'server', name: 'Test', command: 'remote', args: ['https://example.test/mcp'], enabled: true })).rejects.toThrow('Second page unavailable')
    expect(manager.isConnected('server')).toBe(false)
    expect(manager.getTools('server')).toEqual([])
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('McpManager tool metadata', () => {
  test('copies behavior hints and rich metadata into registered tool definitions', () => {
    const manager = new McpManager()
    const annotations = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }
    const descriptor: McpTool = {
      name: 'inspect_workspace',
      description: 'Inspect a workspace',
      title: 'Workspace inspector',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: { files: { type: 'array' } } },
      icons: [{ src: 'https://example.test/tool.png', mimeType: 'image/png' }],
      _meta: { vendor: 'test' },
      annotations,
    }
    const config: McpServerConfig = {
      id: 'server-id',
      name: 'Test server',
      command: 'test',
      args: [],
      enabled: true,
    }
    const buildToolDefinitions = (manager as unknown as {
      buildToolDefinitions: (tools: McpTool[], client: Client, config: McpServerConfig) => ToolDefinition[]
    }).buildToolDefinitions.bind(manager)

    const [tool] = buildToolDefinitions([descriptor], {} as Client, config)

    expect(tool.annotations).toEqual(annotations)
    expect(tool.execution).toEqual({ readOnly: true })
    expect(tool.title).toBe('Workspace inspector')
    expect(tool.outputSchema).toEqual(descriptor.outputSchema)
    expect(tool.icons).toEqual(descriptor.icons)
    expect(tool.providerMetadata).toEqual({ vendor: 'test' })
  })

  test('preserves a missing read-only hint as unknown', () => {
    const manager = new McpManager()
    const descriptor: McpTool = {
      name: 'tavily-search',
      description: 'Search the web with Tavily',
      inputSchema: { type: 'object', properties: {} },
    }
    const config: McpServerConfig = {
      id: 'tavily',
      name: 'Tavily MCP Server',
      command: 'test',
      args: [],
      enabled: true,
    }
    const buildToolDefinitions = (manager as unknown as {
      buildToolDefinitions: (tools: McpTool[], client: Client, config: McpServerConfig) => ToolDefinition[]
    }).buildToolDefinitions.bind(manager)

    const [tool] = buildToolDefinitions([descriptor], {} as Client, config)

    expect(tool.annotations).toBeUndefined()
    expect(tool.execution).toBeUndefined()
  })

  test('tool calls extend their timeout on progress', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'done' }] })
    const manager = new McpManager()
    const [tool] = (manager as unknown as {
      buildToolDefinitions: (tools: McpTool[], client: Client, config: McpServerConfig) => ToolDefinition[]
    }).buildToolDefinitions(
      [{ name: 'slow', inputSchema: { type: 'object', properties: {} } }],
      { callTool } as unknown as Client,
      { id: 's', name: 's', command: 'x', args: [], enabled: true },
    )
    await tool.execute({})
    const options = callTool.mock.calls[0][2]
    expect(options).toEqual(expect.objectContaining({ resetTimeoutOnProgress: true, onprogress: expect.any(Function) }))
    expect(tool.timeout).toBeGreaterThan(options.maxTotalTimeout)
  })
})

type ParsedRemote = { url: string; headers: Record<string, string>; transport: string } | null

describe('McpManager remote configuration', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  function parse(config: Pick<McpServerConfig, 'command' | 'args' | 'env'>): ParsedRemote {
    const manager = new McpManager() as unknown as { parseRemoteConfig(config: McpServerConfig): ParsedRemote }
    return manager.parseRemoteConfig({ id: 'x', name: 'x', enabled: true, ...config })
  }

  test('keeps local servers with URL arguments on stdio', () => {
    expect(parse({ command: 'npx', args: ['-y', 'some-server', '--api-base', 'https://api.example.test'] })).toBeNull()
  })

  test('reads transport and headers and expands ${VAR} references', () => {
    vi.stubEnv('WP_APP_PASSWORD', 'secret')
    expect(parse({
      command: 'remote',
      args: ['--transport', 'sse', '--url', 'https://${HOST:-site.test}/sse', '--header=Authorization: Basic ${WP_APP_PASSWORD}', '--header-env=X-Key=MY_KEY'],
      env: { MY_KEY: 'k' },
    })).toEqual({
      url: 'https://site.test/sse',
      transport: 'sse',
      headers: { Authorization: 'Basic secret', 'X-Key': 'k' },
    })
  })

  test('understands mcp-remote style headers', () => {
    expect(parse({ command: 'npx', args: ['mcp-remote', 'https://example.test/mcp', '--header', 'X-Tenant: team'] }))
      .toEqual({ url: 'https://example.test/mcp', transport: 'streamable-http', headers: { 'X-Tenant': 'team' } })
  })
})

describe('McpManager connection lifecycle', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-mcp-lifecycle-'))
    vi.stubEnv('CYNOSURE_DATA_DIR', directory)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  function descriptor(name: string): McpTool {
    return { name, description: name, inputSchema: { type: 'object', properties: {} } }
  }

  function clientOf(manager: McpManager): Client {
    return (manager as unknown as { connections: Map<string, { client: Client }> }).connections.get('srv')!.client
  }

  async function connect(manager: McpManager, args = ['https://example.test/mcp']): Promise<void> {
    vi.spyOn(Client.prototype, 'close').mockResolvedValue()
    vi.spyOn(Client.prototype, 'getServerVersion').mockReturnValue({ name: 'test', version: '1' })
    manager.setServerBaseUrl('http://localhost:3099')
    await manager.connect({ id: 'srv', name: 'Srv', command: 'remote', args, enabled: true })
  }

  test('uses the SSE transport when configured', async () => {
    const connectSpy = vi.spyOn(Client.prototype, 'connect').mockResolvedValue()
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] })
    const manager = new McpManager()
    await connect(manager, ['--transport', 'sse', '--url', 'https://example.test/sse'])
    expect(connectSpy.mock.calls[0][0]).toBeInstanceOf(SSEClientTransport)
    await manager.disconnectAll()
  })

  test('reconnects after an unexpected close and reports tool changes', async () => {
    vi.useFakeTimers()
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue()
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [descriptor('one')] })
    const manager = new McpManager()
    const changed = vi.fn()
    manager.setOnToolsChanged(changed)
    await connect(manager)

    clientOf(manager).onclose?.()
    expect(manager.isConnected('srv')).toBe(false)
    expect(changed).toHaveBeenLastCalledWith('srv', null, expect.anything())

    await vi.advanceTimersByTimeAsync(1000)
    expect(manager.isConnected('srv')).toBe(true)
    expect(changed).toHaveBeenLastCalledWith('srv', [expect.objectContaining({ name: 'one' })], expect.anything())
    await manager.disconnectAll()
  })

  test('an explicit disconnect does not trigger a reconnect', async () => {
    vi.useFakeTimers()
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue()
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] })
    const manager = new McpManager()
    const changed = vi.fn()
    manager.setOnToolsChanged(changed)
    await connect(manager)
    const client = clientOf(manager)
    await manager.disconnect('srv')
    client.onclose?.()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(manager.isConnected('srv')).toBe(false)
    expect(changed).not.toHaveBeenCalled()
  })

  test('refreshes tools on tools/list_changed', async () => {
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue()
    vi.spyOn(Client.prototype, 'listTools')
      .mockResolvedValueOnce({ tools: [descriptor('one')] })
      .mockResolvedValueOnce({ tools: [descriptor('one'), descriptor('two')] })
    const manager = new McpManager()
    const changed = vi.fn()
    manager.setOnToolsChanged(changed)
    await connect(manager)
    await (manager as unknown as { refreshTools(id: string, client: Client): Promise<void> }).refreshTools('srv', clientOf(manager))
    expect(manager.getTools('srv').map(tool => tool.name)).toEqual(['one', 'two'])
    expect(changed).toHaveBeenCalledWith('srv', expect.arrayContaining([expect.objectContaining({ name: 'two' })]), expect.anything())
    await manager.disconnectAll()
  })
})
