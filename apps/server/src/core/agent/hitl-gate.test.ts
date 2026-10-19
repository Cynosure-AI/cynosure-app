import { beforeEach, describe, expect, test, vi } from 'vitest'

const { approvalRows, sessionRows } = vi.hoisted(() => ({
  approvalRows: new Map<string, number>(),
  sessionRows: new Set<string>(), // `${conversationId}:${toolName}`
}))

vi.mock('../../db/database.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (toolName: string) => approvalRows.has(toolName)
        ? { auto_approve: approvalRows.get(toolName) }
        : undefined,
      all: (conversationId: string) => [...sessionRows]
        .filter((key) => key.startsWith(`${conversationId}:`))
        .map((key) => ({ tool_name: key.slice(conversationId.length + 1) })),
      run: (...args: unknown[]) => {
        if (sql.startsWith('DELETE FROM tool_approvals')) approvalRows.delete(args[0] as string)
        if (sql.includes('INTO session_tool_approvals')) sessionRows.add(`${args[0]}:${args[1]}`)
        if (sql.startsWith('DELETE FROM session_tool_approvals')) sessionRows.delete(`${args[0]}:${args[1]}`)
      },
    }),
    transaction: (callback: () => void) => callback,
  }),
}))

const { permissionModes } = vi.hoisted(() => ({
  permissionModes: new Map<string, 'read-only' | 'auto' | 'full'>(),
}))

vi.mock('../chat/permission-mode.js', () => ({
  getPermissionMode: (conversationId?: string) => (conversationId && permissionModes.get(conversationId)) || 'auto',
}))

import { HITLGate } from './hitl-gate.js'
import { getEventBus } from '../telemetry/event-bus.js'

describe('HITLGate annotation defaults', () => {
  beforeEach(() => approvalRows.clear())

  test('auto-approves a consistently declared read-only tool by default', () => {
    const gate = new HITLGate()

    expect(gate.isAutoApproved('mcp_read', { readOnlyHint: true })).toBe(true)
  })

  test('requires approval by default for writes and tools without hints', () => {
    const gate = new HITLGate()

    expect(gate.isAutoApproved('mcp_unknown')).toBe(false)
    expect(gate.isAutoApproved('mcp_write', { readOnlyHint: false, destructiveHint: false })).toBe(false)
    expect(gate.isAutoApproved('mcp_destructive', { readOnlyHint: false, destructiveHint: true })).toBe(false)
  })

  test('lets an explicit user choice override the annotation default', () => {
    const gate = new HITLGate()
    approvalRows.set('mcp_read', 0)
    approvalRows.set('mcp_write', 1)

    expect(gate.isAutoApproved('mcp_read', { readOnlyHint: true })).toBe(false)
    expect(gate.isAutoApproved('mcp_write', { readOnlyHint: false, destructiveHint: true })).toBe(true)
  })

  test('restores annotation defaults by removing explicit choices', () => {
    const gate = new HITLGate()
    approvalRows.set('mcp_read', 0)
    approvalRows.set('mcp_write', 1)

    gate.resetAutoApproveBulk(['mcp_read', 'mcp_write', 'mcp_read'])

    expect(gate.isAutoApproved('mcp_read', { readOnlyHint: true })).toBe(true)
    expect(gate.isAutoApproved('mcp_write', { readOnlyHint: false })).toBe(false)
  })

  test('includes behavior annotations in approval requests', async () => {
    const gate = new HITLGate()
    const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    const events: Array<Record<string, unknown>> = []
    const unsubscribe = getEventBus().on('hitl:request', (event) => {
      const request = event as Record<string, unknown> & { resolve: (result: { approved: boolean }) => void }
      events.push(request)
      request.resolve({ approved: true })
    })

    try {
      await gate.requestApproval('task', [{
        id: 'call',
        type: 'function',
        function: { name: 'remove_item', arguments: '{}' },
      }], undefined, undefined, [{
        name: 'remove_item',
        description: 'Remove an item',
        parameters: { type: 'object' },
        timeout: 1_000,
        annotations,
        execute: async () => ({ success: true, output: 'removed' }),
      }])
    } finally {
      unsubscribe()
    }

    expect(events[0].toolCalls).toEqual([expect.objectContaining({ annotations })])
  })
})

describe('HITLGate permission mode', () => {
  const call = (name: string) => ({ id: `call-${name}`, type: 'function' as const, function: { name, arguments: '{}' } })

  beforeEach(() => {
    approvalRows.clear()
    permissionModes.clear()
  })

  test('full access runs every tool in that conversation without asking', async () => {
    const gate = new HITLGate()
    permissionModes.set('conv-1', 'full')

    await expect(gate.requestApproval('task-1', [call('shell')], undefined, 'conv-1')).resolves.toEqual({ approved: true })
  })

  test('read only refuses tools that are not declared read-only, without asking', async () => {
    const gate = new HITLGate()
    permissionModes.set('conv-1', 'read-only')
    const tools = [
      { name: 'mcp_read', description: '', parameters: {}, timeout: 1_000, execute: async () => ({ success: true, output: '' }), annotations: { readOnlyHint: true } },
      { name: 'shell', description: '', parameters: {}, timeout: 1_000, execute: async () => ({ success: true, output: '' }), annotations: { readOnlyHint: false, destructiveHint: true } },
    ]

    await expect(gate.requestApproval('task-1', [call('mcp_read')], undefined, 'conv-1', tools)).resolves.toEqual({ approved: true })
    const result = await gate.requestApproval('task-2', [call('mcp_read'), call('shell')], undefined, 'conv-1', tools)
    expect(result.approved).toBe(false)
    expect(result.reason).toContain('blocked: shell')
  })

  test('read only still lets the agent keep the project brief and task board current', async () => {
    const gate = new HITLGate()
    permissionModes.set('conv-1', 'read-only')

    await expect(gate.requestApproval('task-1', [call('project_brief_update'), call('project_task_create')], undefined, 'conv-1'))
      .resolves.toEqual({ approved: true })
  })

  test('read only blocks memory creation without requesting approval', async () => {
    const gate = new HITLGate()
    permissionModes.set('conv-1', 'read-only')
    const request = vi.fn()
    const unsubscribe = getEventBus().on('hitl:request', request)

    try {
      await expect(gate.requestApproval('task-1', [call('memory_create')], undefined, 'conv-1'))
        .resolves.toEqual({ approved: false, denied: true, reason: expect.stringContaining('blocked: memory_create') })
      expect(request).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  test.each(['memory_create', 'memory_patch', 'memory_delete'])('read only blocks %s even with saved approval', async (name) => {
    const gate = new HITLGate()
    permissionModes.set('conv-1', 'read-only')
    approvalRows.set(name, 1)

    await expect(gate.requestApproval('task-1', [call(name)], undefined, 'conv-1'))
      .resolves.toEqual({ approved: false, denied: true, reason: expect.stringContaining(`blocked: ${name}`) })
  })
})
