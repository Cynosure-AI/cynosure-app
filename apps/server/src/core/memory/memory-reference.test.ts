import { describe, expect, test } from 'vitest'
import {
  createStableMemoryDocumentRef,
  formatLegacyMemoryDocumentRef,
  memoryDocumentRefMatchesContentHash,
  parseMemoryDocumentRef,
} from './memory-reference.js'

describe('model-facing memory references', () => {
  test('formats a readable reference that is stable across content updates', () => {
    const first = createStableMemoryDocumentRef('Project Notes.md', '0123456789abcdef', 1_700_000_000_000)
    const second = createStableMemoryDocumentRef('Project Notes.md', '0123456789abcdef', 1_700_000_000_000)
    expect(first).toBe(second)
    expect(first).toMatch(/^project-notes#[a-z0-9]{6}$/)
  })

  test('parses stable refs and legacy state refs', () => {
    expect(parseMemoryDocumentRef('Project-Notes#A1B2C3')).toEqual({
      kind: 'stable',
      value: 'project-notes#a1b2c3',
    })
    const parsed = parseMemoryDocumentRef(formatLegacyMemoryDocumentRef(
      '0123456789abcdef',
      'abcdef0123456789',
    ))
    expect(parsed).toEqual({
      kind: 'legacy',
      documentIdPrefix: '0123456789ab',
      contentHashPrefix: 'abcdef012345',
    })
    expect(memoryDocumentRefMatchesContentHash(parsed!, 'abcdef0123456789')).toBe(true)
    expect(memoryDocumentRefMatchesContentHash(parsed!, 'abcdef0123466789')).toBe(false)
    expect(memoryDocumentRefMatchesContentHash(parseMemoryDocumentRef('project-notes#a1b2c3')!, 'anything')).toBe(true)
    expect(parseMemoryDocumentRef('d:0123456789ab')).toBeUndefined()
    expect(parseMemoryDocumentRef('m:short.short')).toBeUndefined()
  })
})
