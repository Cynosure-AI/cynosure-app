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

  test('ignores unregistered composite keys', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('schedule_create'), {
      id: 'builtin:scheduling',
      label: 'Built-In: Scheduling',
    })

    expect(registry.hasKey('builtin::schedule_create')).toBe(false)
    expect(registry.resolveForExecution(['builtin::schedule_create'])).toEqual([])
  })
})

describe('ToolRegistry provider-safe names', () => {
  test('rewrites characters providers reject and keeps the original tool callable', async () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('wp.posts/list items'), { id: 'mcp:wp', label: 'WordPress' })
    const [resolved] = registry.resolveForExecution(['mcp:wp::wp.posts/list items'])
    expect(resolved.name).toBe('wp_posts_list_items')
    expect(resolved.originalName).toBe('wp.posts/list items')
    expect(await resolved.execute({})).toEqual({ success: true, output: 'ok' })
  })

  test('truncates long names to 64 characters', () => {
    const registry = new ToolRegistry()
    const long = `tool_${'x'.repeat(100)}`
    registry.register(makeTool(long), { id: 'mcp:a', label: 'A' })
    const [resolved] = registry.resolveForExecution([`mcp:a::${long}`])
    expect(resolved.name).toHaveLength(64)
    expect(resolved.name).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  test('keeps names distinct when they collapse to the same safe name', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('a.b'), { id: 'mcp:a', label: 'A' })
    registry.register(makeTool('a_b'), { id: 'mcp:a', label: 'A' })
    const names = registry.resolveForExecution(['mcp:a::a.b', 'mcp:a::a_b']).map(tool => tool.name)
    expect(new Set(names).size).toBe(2)
  })
})
