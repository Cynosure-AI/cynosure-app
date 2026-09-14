import { describe, expect, test } from 'vitest'
import {
  createStableMemoryDocumentRef,
  parseMemoryDocumentRef,
} from './memory-reference.js'

describe('model-facing memory references', () => {
  test('formats a readable reference that is stable across content updates', () => {
    const first = createStableMemoryDocumentRef('Project Notes.md', '0123456789abcdef', 1_700_000_000_000)
    const second = createStableMemoryDocumentRef('Project Notes.md', '0123456789abcdef', 1_700_000_000_000)
    expect(first).toBe(second)
    expect(first).toMatch(/^project-notes#[a-z0-9]{6}$/)
  })

  test('parses stable refs and rejects other formats', () => {
    expect(parseMemoryDocumentRef('Project-Notes#A1B2C3')).toBe('project-notes#a1b2c3')
    expect(parseMemoryDocumentRef('d:0123456789ab')).toBeUndefined()
    expect(parseMemoryDocumentRef('m:0123456789ab.abcdef012345')).toBeUndefined()
    expect(parseMemoryDocumentRef('m:short.short')).toBeUndefined()
  })
})
