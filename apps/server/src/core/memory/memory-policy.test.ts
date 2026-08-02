import assert from 'node:assert/strict'
import test from 'node:test'
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

test('rejects separator-only and markup-only chunks', () => {
  assert.equal(isRetrievableChunk('---'), false)
  assert.equal(isRetrievableChunk('##'), false)
  assert.equal(isRetrievableChunk('***\n---'), false)
  assert.equal(isRetrievableChunk('## Retrieval\nHybrid search finds documents.'), true)
})

test('only applies a configured threshold to reranker scores', () => {
  assert.equal(passesRetrievalThreshold(result({ score: 0, scoreType: 'fusion' }), 0.3), true)
  assert.equal(passesRetrievalThreshold(result({ rerankerScore: 0.29, scoreType: 'reranker' }), 0.3), false)
  assert.equal(passesRetrievalThreshold(result({ rerankerScore: 0.31, scoreType: 'reranker' }), 0.3), true)
})

test('explicit memory scopes fail closed on missing IDs', () => {
  assert.equal(hasExactMemorySpaceScope(['a', 'b'], [{ id: 'a' }, { id: 'b' }]), true)
  assert.equal(hasExactMemorySpaceScope(['a', 'missing'], [{ id: 'a' }]), false)
})

test('entity extraction covers an entire long document at safe boundaries', () => {
  const content = Array.from({ length: 120 }, (_, index) => `## Section ${index}\nFact ${index} relates to project ${index}.`).join('\n\n')
  const chunks = splitEntityExtractionContent(content, 500)
  assert.ok(chunks.length > 1)
  assert.equal(chunks.join('').replace(/\s/g, ''), content.replace(/\s/g, ''))
  assert.ok(chunks.every((chunk) => chunk.length <= 500))
})

test('derives stable retrieval context from document structure', () => {
  const text = '# Memory Architecture\n\n## Retrieval\nHybrid retrieval combines semantic and lexical search.'
  assert.equal(inferDocumentTitle(text, 'fallback.md'), 'Memory Architecture')
  assert.equal(inferSectionPath(text, 'Memory Architecture'), 'Retrieval')
  assert.equal(inferDocumentTitle('No heading here', 'project_notes.md'), 'project notes')
})
