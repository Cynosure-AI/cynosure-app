import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, test } from 'vitest'
import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import { McpManager, type McpServerConfig } from './mcp-manager.js'

describe('McpManager tool annotations', () => {
  test('copies all behavioral hints into registered tool definitions', () => {
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
      inputSchema: { type: 'object', properties: {} },
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
  })
})
