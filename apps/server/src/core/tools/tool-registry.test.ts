import { describe, expect, test } from 'vitest'
import type { ToolDefinition } from '../gateway/providers/base.provider.js'
import { ToolRegistry } from './tool-registry.js'

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    parameters: { type: 'object', properties: {} },
    timeout: 1000,
    annotations: {
      title: 'Annotated tool',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    execute: async () => ({ success: true, output: 'ok' }),
  }
}

describe('ToolRegistry behavior annotations', () => {
  test('preserves annotations in listings and execution aliases', () => {
    const registry = new ToolRegistry()
    const first = makeTool('change_record')
    const second = makeTool('change_record')

    registry.register(first, { id: 'mcp:first', label: 'First' })
    registry.register(second, { id: 'mcp:second', label: 'Second' })

    expect(registry.listRegisteredTools()).toEqual([
      expect.objectContaining({
        key: 'mcp:first::change_record',
        executionName: 'first__change_record',
        annotations: first.annotations,
      }),
      expect.objectContaining({
        key: 'mcp:second::change_record',
        executionName: 'second__change_record',
        annotations: second.annotations,
      }),
    ])

    expect(registry.resolveForExecution([
      'mcp:first::change_record',
      'mcp:second::change_record',
    ])).toEqual([
      expect.objectContaining({ name: 'first__change_record', annotations: first.annotations }),
      expect.objectContaining({ name: 'second__change_record', annotations: second.annotations }),
    ])
  })
})
