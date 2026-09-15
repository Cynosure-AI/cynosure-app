import { describe, expect, test } from 'vitest'
import { estimateChunkCountFromFileSize, MemoryParser } from './parser.js'

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

describe('canonical source ranges', () => {
  test('every retrieval chunk retains an exact range after boundaries shift', async () => {
    const parser = new MemoryParser({ chunkSize: 128, chunkOverlap: 24 })
    const original = `# Profile\n\n${'Vue and Electron development. '.repeat(120)}`
    const shifted = `# New preface\n\nUnrelated information.\n\n${original}`
    const originalChunks = await parser.prepareChunks(original, 'profile.md')
    const shiftedChunks = await parser.prepareChunks(shifted, 'profile.md')

    expect(originalChunks.length).toBeGreaterThan(1)
    expect(shiftedChunks.length).toBeGreaterThan(1)
    for (const chunk of shiftedChunks) {
      expect(shifted.slice(chunk.sourceStart, chunk.sourceEnd)).toBe(chunk.text)
    }
    expect(shiftedChunks.some((chunk, index) => chunk.sourceStart !== originalChunks[index]?.sourceStart)).toBe(true)
  })
})
