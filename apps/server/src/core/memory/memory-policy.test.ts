import { describe, expect, test } from 'vitest'
import { inferDocumentTitle, inferSectionPath, isRetrievableChunk, passesRetrievalThreshold } from './parser.js'
import { hasExactMemorySpaceScope } from './memory-aggregator.js'
import { splitEntityExtractionContent } from './entity-graph.js'
import type { SearchResult } from './rag.js'

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

  test('only applies a configured threshold to reranker scores', () => {
    expect(passesRetrievalThreshold(result({ score: 0, scoreType: 'fusion' }), 0.3)).toBe(true)
    expect(passesRetrievalThreshold(result({ rerankerScore: 0.29, scoreType: 'reranker' }), 0.3)).toBe(false)
    expect(passesRetrievalThreshold(result({ rerankerScore: 0.31, scoreType: 'reranker' }), 0.3)).toBe(true)
  })

  test('explicit memory scopes fail closed on missing IDs', () => {
    expect(hasExactMemorySpaceScope(['a', 'b'], [{ id: 'a' }, { id: 'b' }])).toBe(true)
    expect(hasExactMemorySpaceScope(['a', 'missing'], [{ id: 'a' }])).toBe(false)
  })

  test('entity extraction covers an entire long document at safe boundaries', () => {
    const content = Array.from({ length: 120 }, (_, index) => `## Section ${index}\nFact ${index} relates to project ${index}.`).join('\n\n')
    const chunks = splitEntityExtractionContent(content, 500)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('').replace(/\s/g, '')).toBe(content.replace(/\s/g, ''))
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true)
  })

  test('derives stable retrieval context from document structure', () => {
    const text = '# Memory Architecture\n\n## Retrieval\nHybrid retrieval combines semantic and lexical search.'
    expect(inferDocumentTitle(text, 'fallback.md')).toBe('Memory Architecture')
    expect(inferSectionPath(text, 'Memory Architecture')).toBe('Retrieval')
    expect(inferDocumentTitle('No heading here', 'project_notes.md')).toBe('project notes')
  })
})
