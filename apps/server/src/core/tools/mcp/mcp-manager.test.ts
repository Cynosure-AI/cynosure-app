import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, test } from 'vitest'
import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import { McpManager, type McpServerConfig } from './mcp-manager.js'

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
})
