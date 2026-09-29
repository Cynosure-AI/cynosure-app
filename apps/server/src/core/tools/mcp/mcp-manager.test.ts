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
})
