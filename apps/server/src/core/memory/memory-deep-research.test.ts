import { describe, expect, test } from 'vitest'
import { buildDeepResearchSegments } from './memory-deep-research.js'
import type { PreparedMemoryChunk } from './parser.js'

function chunk(text: string, chunkIndex: number): PreparedMemoryChunk {
  return { text, chunkIndex, searchText: text, documentTitle: 'Quarterly report',
    sectionPath: 'Section metadata', contentHash: `hash-${chunkIndex}` }
}

describe('bounded analysis context', () => {
  const chunks = ['First.', 'Second.', 'Third.', 'Fourth.', 'Fifth.'].map(chunk)

  test('uses title and immediate neighbors from the full chunk list for a resumed target', () => {
    const [segment] = buildDeepResearchSegments(chunks, [chunks[2]])
    expect(segment.chunkIndexes).toEqual([2])
    expect(segment.content).toBe([
      'Document: Quarterly report',
      '<previous_chunk_context>', 'Second.', '</previous_chunk_context>',
      '<source_chunk index="2">', 'Third.', '</source_chunk>',
      '<next_chunk_context>', 'Fourth.', '</next_chunk_context>',
    ].join('\n'))
    expect(segment.content).not.toContain('First.')
    expect(segment.content).not.toContain('Fifth.')
    expect(segment.content).not.toContain('Section metadata')
  })

  test('omits missing neighbors at document boundaries', () => {
    const segments = buildDeepResearchSegments(chunks)
    expect(segments[0].content).not.toContain('<previous_chunk_context>')
    expect(segments[0].content).toContain('<next_chunk_context>\nSecond.')
    expect(segments[4].content).toContain('<previous_chunk_context>\nFourth.')
    expect(segments[4].content).not.toContain('<next_chunk_context>')
  })

  test('a single-chunk document includes only its title and target', () => {
    expect(buildDeepResearchSegments([chunks[0]])[0].content).toBe(
      'Document: Quarterly report\n<source_chunk index="0">\nFirst.\n</source_chunk>',
    )
  })
})
