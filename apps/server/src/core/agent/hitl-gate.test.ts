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
  beforeEach(() => {
    approvalRows.clear()
    sessionRows.clear()
  })

  test('full access runs every tool in that conversation without asking', async () => {
    const gate = new HITLGate()
    const toolCalls = [{ id: 'call-1', type: 'function' as const, function: { name: 'shell', arguments: '{}' } }]

    expect(gate.getPermissionMode('conv-1')).toBe('auto')
    gate.setPermissionMode('conv-1', 'full')

    expect(gate.getPermissionMode('conv-1')).toBe('full')
    expect(gate.getPermissionMode('conv-2')).toBe('auto')
    await expect(gate.requestApproval('task-1', toolCalls, undefined, 'conv-1')).resolves.toEqual({ approved: true })
  })

  test('switching back to auto keeps tool-specific session approvals', () => {
    const gate = new HITLGate()
    gate.addSessionApproval('conv-1', ['shell'])
    gate.setPermissionMode('conv-1', 'full')

    gate.setPermissionMode('conv-1', 'auto')

    expect(gate.getPermissionMode('conv-1')).toBe('auto')
    expect(new HITLGate().getPermissionMode('conv-1')).toBe('auto')
    expect(sessionRows.has('conv-1:shell')).toBe(true)
  })
})
