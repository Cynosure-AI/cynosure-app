import { describe, expect, test } from 'vitest'
import { fuseRetrievalChannels, inferDocumentTitle, inferSectionPath, isRetrievableChunk } from './parser.js'
import { hasExactMemoryFolderScope } from './memory-aggregator.js'
import type { SearchResult } from './rag.js'
import { chunkSearchText } from './chunk-search-text.js'

function result(overrides: Partial<SearchResult>): SearchResult {
  return {
    id: 'id',
    text: 'text',
    source: 'test',
    score: 0.1,
    scoreType: 'fusion',
    createdAt: 0,
    ...overrides,
  }
}

describe('memory retrieval policy', () => {
  test('rejects separator-only and markup-only chunks', () => {
    expect(isRetrievableChunk('---')).toBe(false)
    expect(isRetrievableChunk('##')).toBe(false)
    expect(isRetrievableChunk('***\n---')).toBe(false)
    expect(isRetrievableChunk('## Retrieval\nHybrid search finds documents.')).toBe(true)
  })

  test('explicit memory scopes fail closed on missing IDs', () => {
    expect(hasExactMemoryFolderScope(['a', 'b'], [{ id: 'a' }, { id: 'b' }])).toBe(true)
    expect(hasExactMemoryFolderScope(['a', 'missing'], [{ id: 'a' }])).toBe(false)
  })

  test('derives stable retrieval context from document structure', () => {
    const text = '# Memory Architecture\n\n## Retrieval\nHybrid retrieval combines semantic and lexical search.'
    expect(inferDocumentTitle(text, 'fallback.md')).toBe('Memory Architecture')
    expect(inferSectionPath(text, 'Memory Architecture')).toBe('Retrieval')
    expect(inferDocumentTitle('No heading here', 'project_notes.md')).toBe('project notes')
  })

  test('fuses independently budgeted dense and lexical candidates before reranking', () => {
    const denseOnly = result({ id: 'dense', scoreType: 'dense', denseScore: 0.91, createdAt: 3 })
    const bothDense = result({ id: 'both', scoreType: 'dense', denseScore: 0.84, createdAt: 2 })
    const bothLexical = result({ id: 'both', scoreType: 'lexical', lexicalScore: 7.5, createdAt: 2 })
    const exactName = result({ id: 'caroline', scoreType: 'lexical', lexicalScore: 9.2, createdAt: 1 })

    const fused = fuseRetrievalChannels([[denseOnly, bothDense], [exactName, bothLexical]], 3)

    expect(fused.map(({ id }) => id)).toEqual(['both', 'dense', 'caroline'])
    expect(fused[0]).toMatchObject({ scoreType: 'fusion', denseScore: 0.84, lexicalScore: 7.5 })
    expect(fused[2]?.lexicalScore).toBe(9.2)
  })

  test('gives every chunk its document title and section as search context', () => {
    expect(chunkSearchText({ text: 'Budget is 18.400 €.', documentTitle: 'Steirerwerk', sectionPath: 'Eckdaten' }))
      .toBe('Document: Steirerwerk\nSection: Eckdaten\nBudget is 18.400 €.')
    expect(chunkSearchText({ text: 'Intro', documentTitle: 'Atlas', sectionPath: 'Atlas' })).toBe('Document: Atlas\nIntro')
    expect(chunkSearchText({ text: 'Loose note' })).toBe('Loose note')
  })
})
