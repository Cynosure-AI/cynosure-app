import { readFileSync } from 'node:fs'
import { evaluateRetrievalCase, summarizeRetrievalEvaluation } from '../core/memory/retrieval-evaluation.js'

interface EvaluationCase {
  query: string
  relevantSourceFiles?: string[]
  relevantRelations?: Array<{ from: string; predicate: string; to: string }>
  expectNoAnswer?: boolean
  folderId?: string
  mode?: 'chunks' | 'aggregate' | 'knowledge'
}

interface SearchResult {
  sourceFile?: string
  rerankerScore?: number
}

interface RelationshipResult {
  fromName: string
  relation: string
  toName: string
  sourceId?: string
}

interface EvidenceResponse {
  permanent?: SearchResult[]
  sourceChunks?: SearchResult[]
  graph?: { edges?: RelationshipResult[] }
}

interface EvaluationThresholds {
  minHitRateAtK?: number
  minRecallAtK?: number
  minMeanReciprocalRank?: number
  minNdcgAtK?: number
  maxNoAnswerFalsePositiveRate?: number
}

interface EvaluationDataset {
  cases: EvaluationCase[]
  thresholds?: EvaluationThresholds
}

const datasetPath = process.argv[2]
const baseUrl = (process.argv[3] || 'http://127.0.0.1:3099').replace(/\/+$/, '')
const topK = Math.min(100, Math.max(1, Number(process.argv[4] || 20)))

if (!datasetPath) {
  console.error('Usage: pnpm --filter cynosure-server memory:evaluate <dataset.json> [baseUrl] [topK]')
  process.exit(2)
}

const parsedDataset = JSON.parse(readFileSync(datasetPath, 'utf8')) as EvaluationCase[] | EvaluationDataset
const cases = Array.isArray(parsedDataset) ? parsedDataset : parsedDataset.cases
const thresholds = Array.isArray(parsedDataset) ? undefined : parsedDataset.thresholds
if (!Array.isArray(cases) || cases.length === 0) throw new Error('Evaluation dataset must be a non-empty JSON array')

const caseMetrics: ReturnType<typeof evaluateRetrievalCase>[] = []
const latenciesMs: number[] = []
const failures: Array<{ query: string; expected: string[]; returned: string[] }> = []

for (const item of cases) {
  if (!item.query?.trim()) throw new Error('Every evaluation case requires a non-empty query')
  const startedAt = performance.now()
  const mode = item.mode || 'chunks'
  const endpoint = mode === 'chunks'
    ? '/api/memory/search'
    : mode === 'knowledge' ? '/api/memory/knowledge/search' : '/api/memory/aggregate'
  const body = mode === 'chunks'
    ? { query: item.query, topK, folderId: item.folderId }
    : mode === 'knowledge'
      ? { query: item.query, limit: topK, folderIds: item.folderId ? [item.folderId] : [] }
      : { query: item.query, opts: { permanentTopK: topK, includeGraph: true, folderIds: item.folderId ? [item.folderId] : undefined } }
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  latenciesMs.push(performance.now() - startedAt)
  if (!response.ok) throw new Error(`Search failed (${response.status}) for query: ${item.query}`)
  const payload = await response.json() as SearchResult[] | EvidenceResponse
  const chunks = Array.isArray(payload) ? payload : payload.permanent || payload.sourceChunks || []
  const edges = Array.isArray(payload) ? [] : payload.graph?.edges || []
  const returned = [
    ...chunks.map((result) => result.sourceFile || '').filter(Boolean),
    ...edges.map((edge) => `relation:${edge.fromName.toLowerCase()}|${edge.relation.toLowerCase()}|${edge.toName.toLowerCase()}`),
  ]

  if (item.expectNoAnswer) {
    caseMetrics.push(evaluateRetrievalCase(returned, [], topK, true))
    continue
  }

  const expected = Array.from(new Set([
    ...(item.relevantSourceFiles || []),
    ...(item.relevantRelations || []).map((edge) => `relation:${edge.from.toLowerCase()}|${edge.predicate.toLowerCase()}|${edge.to.toLowerCase()}`),
  ]))
  if (expected.length === 0) throw new Error(`Positive case has no relevantSourceFiles or relevantRelations: ${item.query}`)
  const found = expected.filter((source) => returned.includes(source))
  caseMetrics.push(evaluateRetrievalCase(returned, expected, topK))
  if (found.length !== expected.length) failures.push({ query: item.query, expected, returned })
}

const metrics = summarizeRetrievalEvaluation(caseMetrics)
const sortedLatencies = [...latenciesMs].sort((a, b) => a - b)
const p95Index = Math.max(0, Math.ceil(sortedLatencies.length * 0.95) - 1)
const failedThresholds = thresholds ? [
  thresholds.minHitRateAtK !== undefined && (metrics.hitRateAtK ?? 0) < thresholds.minHitRateAtK
    ? `hitRateAtK < ${thresholds.minHitRateAtK}` : '',
  thresholds.minRecallAtK !== undefined && (metrics.recallAtK ?? 0) < thresholds.minRecallAtK
    ? `recallAtK < ${thresholds.minRecallAtK}` : '',
  thresholds.minMeanReciprocalRank !== undefined && (metrics.meanReciprocalRank ?? 0) < thresholds.minMeanReciprocalRank
    ? `meanReciprocalRank < ${thresholds.minMeanReciprocalRank}` : '',
  thresholds.minNdcgAtK !== undefined && (metrics.ndcgAtK ?? 0) < thresholds.minNdcgAtK
    ? `ndcgAtK < ${thresholds.minNdcgAtK}` : '',
  thresholds.maxNoAnswerFalsePositiveRate !== undefined
    && (metrics.noAnswerFalsePositiveRate ?? 0) > thresholds.maxNoAnswerFalsePositiveRate
    ? `noAnswerFalsePositiveRate > ${thresholds.maxNoAnswerFalsePositiveRate}` : '',
].filter(Boolean) : []

console.log(JSON.stringify({
  cases: cases.length,
  topK,
  ...metrics,
  latencyMs: {
    average: latenciesMs.reduce((total, value) => total + value, 0) / latenciesMs.length,
    p95: sortedLatencies[p95Index],
  },
  thresholds: thresholds || null,
  failedThresholds,
  failures,
}, null, 2))

if (failedThresholds.length) process.exitCode = 1
