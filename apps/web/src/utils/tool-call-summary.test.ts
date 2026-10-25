import { describe, expect, test } from 'vitest'
import { toolCallSummary } from './tool-call-summary'

const args = (value: Record<string, unknown>) => JSON.stringify(value)

describe('toolCallSummary', () => {
  test('uses the shell explanation and falls back to the command', () => {
    expect(toolCallSummary('shell_execute', args({ command: 'curl https://vol.at', explanation: 'Fetch the vol.at homepage' }))?.text).toBe('Fetch the vol.at homepage')
    expect(toolCallSummary('shell_execute', args({ command: 'ls -la' }))?.text).toBe('ls -la')
  })

  test('shows file names and keeps the full path for the tooltip', () => {
    expect(toolCallSummary('file_write', args({ path: '/home/me/notes/todo.md', content: 'x' }))).toEqual({ text: 'todo.md', title: '/home/me/notes/todo.md' })
    expect(toolCallSummary('file_read', args({ paths: ['/a/one.ts', '/a/two.ts'] }))?.text).toBe('one.ts +1')
    expect(toolCallSummary('file_move', args({ source: '/a/old.txt', destination: '/b/new.txt' }))?.text).toBe('old.txt → new.txt')
  })

  test('names memory documents without their reference id', () => {
    expect(toolCallSummary('memory_patch', args({ fileRef: 'user-profile#4k8z2q', edits: [] }))?.text).toBe('user-profile')
    expect(toolCallSummary('memory_create', args({ title: 'Travel plans', content: 'x' }))?.text).toBe('Travel plans')
  })

  test('describes when a schedule runs', () => {
    expect(toolCallSummary('schedule_create', args({ name: 'Digest', prompt: 'x', schedule: '30 9 * * *' }))?.text).toBe('Digest · Daily at 09:30')
    expect(toolCallSummary('schedule_create', args({ name: 'Ping', prompt: 'x', runInMinutes: 15 }))?.text).toBe('Ping · in 15 min')
  })

  test('returns nothing for unknown tools and incomplete arguments', () => {
    expect(toolCallSummary('some_mcp_tool', args({ path: '/a/b' }))).toBeNull()
    expect(toolCallSummary('file_read', '{"path": "/a/b')).toBeNull()
  })
})
