import { describe, expect, test } from 'vitest'
import { estimateChunkCountFromFileSize } from './parser.js'

describe('estimateChunkCountFromFileSize', () => {
  const config = { chunkSize: 512, chunkOverlap: 64 }

  test('returns zero for an empty file', () => {
    expect(estimateChunkCountFromFileSize(0, config)).toBe(0)
  })

  test('returns one when the file fits in one estimated chunk', () => {
    expect(estimateChunkCountFromFileSize(2_048, config)).toBe(1)
  })

  test('accounts for overlap when estimating additional chunks', () => {
    expect(estimateChunkCountFromFileSize(6_900, config)).toBe(4)
  })

  test('uses the configured chunk size and overlap', () => {
    expect(estimateChunkCountFromFileSize(6_900, { chunkSize: 256, chunkOverlap: 128 })).toBe(13)
  })
})
