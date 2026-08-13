import { describe, expect, test } from 'vitest'
import {
  formatMemoryDocumentRef,
  memoryDocumentRefMatchesContentHash,
  parseMemoryDocumentRef,
} from './memory-reference.js'

describe('model-facing memory references', () => {
  test('formats one opaque document-state reference', () => {
    expect(formatMemoryDocumentRef(
      '0123456789abcdef0123456789abcdef',
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    )).toBe('m:0123456789ab.abcdef012345')
  })

  test('parses only the bounded opaque syntax', () => {
    const parsed = parseMemoryDocumentRef('m:0123456789AB.ABCDEF012345')
    expect(parsed).toEqual({
      documentIdPrefix: '0123456789ab',
      contentHashPrefix: 'abcdef012345',
    })
    expect(memoryDocumentRefMatchesContentHash(parsed!, 'abcdef0123456789')).toBe(true)
    expect(memoryDocumentRefMatchesContentHash(parsed!, 'abcdef0123466789')).toBe(false)
    expect(parseMemoryDocumentRef('d:0123456789ab')).toBeUndefined()
    expect(parseMemoryDocumentRef('m:short.short')).toBeUndefined()
  })
})
