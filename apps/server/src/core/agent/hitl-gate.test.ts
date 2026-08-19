import { beforeEach, describe, expect, test, vi } from 'vitest'

const { approvalRows } = vi.hoisted(() => ({
  approvalRows: new Map<string, number>(),
}))

vi.mock('../../db/database.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (toolName: string) => approvalRows.has(toolName)
        ? { auto_approve: approvalRows.get(toolName) }
        : undefined,
      run: (toolName: string) => {
        if (sql.startsWith('DELETE FROM tool_approvals')) approvalRows.delete(toolName)
      },
    }),
    transaction: (callback: () => void) => callback,
  }),
}))

import { HITLGate } from './hitl-gate.js'

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
})
