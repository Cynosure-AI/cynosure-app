import { beforeEach, expect, test, vi } from 'vitest'
import { MemoryParser, type MemoryRetrievalStatusDetails } from './parser.js'

const mocks = vi.hoisted(() => ({
  embedQuery: vi.fn(), search: vi.fn(), lexicalSearch: vi.fn(),
  rerank: vi.fn(), rerankerEnabled: true,
}))
vi.mock('./embedding.js', () => ({ getEmbeddingService: () => ({ embedQuery: mocks.embedQuery }) }))
vi.mock('./rag.js', () => ({ getRAGStore: () => ({ search: mocks.search, lexicalSearch: mocks.lexicalSearch }) }))
vi.mock('./reranker.js', () => ({
  getMemoryReranker: () => ({
    getConfig: () => ({ enabled: mocks.rerankerEnabled, model: 'reranker-model', curationModel: '' }),
    getCandidateCount: (topK: number) => topK,
    rerank: mocks.rerank,
  }),
}))

const hit = (id: string, denseScore: number) => ({
  id, text: `${id}: the deployment uses the blue environment and a manual approval step.`,
  source: 'memory', sourceFile: `${id}.md`, score: denseScore, denseScore, scoreType: 'dense' as const,
})

beforeEach(() => {
  mocks.rerankerEnabled = true
  mocks.embedQuery.mockReset().mockResolvedValue({ vector: [1, 0], profileFingerprint: 'test' })
  mocks.search.mockReset().mockResolvedValue([hit('a', 0.42), hit('b', 0.4)])
  mocks.lexicalSearch.mockReset().mockResolvedValue([])
  mocks.rerank.mockReset()
})

async function retrieveWithStatus(): Promise<MemoryRetrievalStatusDetails[]> {
  const statuses: MemoryRetrievalStatusDetails[] = []
  await new MemoryParser().retrieve('memories', 'how do we deploy?', 5, undefined, (stage, details) => {
    if (stage === 'reranking' && details) statuses.push(details)
  })
  return statuses
}

test('reports a thrown rerank failure instead of hiding it behind hybrid order', async () => {
  mocks.rerank.mockRejectedValue(new Error('OpenRouter rerank failed: 502 Bad Gateway'))

  const statuses = await retrieveWithStatus()

  expect(statuses.at(-1)).toMatchObject({ rerankError: 'OpenRouter rerank failed: 502 Bad Gateway' })
})

test('reports a rerank that silently returned no relevance scores', async () => {
  mocks.rerank.mockImplementation(async (_query: string, results: unknown[]) => results)

  const statuses = await retrieveWithStatus()

  expect(statuses.at(-1)?.rerankError).toMatch(/no relevance scores/)
})

test('reports no error when the reranker scored the results', async () => {
  mocks.rerank.mockImplementation(async (_query: string, results: Array<Record<string, unknown>>) => (
    results.map((result) => ({ ...result, rerankerScore: 0.8, scoreType: 'reranker' }))
  ))

  const statuses = await retrieveWithStatus()

  expect(statuses.at(-1)).not.toHaveProperty('rerankError')
})
