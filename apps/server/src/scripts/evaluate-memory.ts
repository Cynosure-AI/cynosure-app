import { readFileSync } from 'node:fs'

interface EvaluationCase {
  query: string
  relevantSourceFiles?: string[]
  expectNoAnswer?: boolean
  spaceId?: string
}

interface SearchResult {
  sourceFile?: string
  rerankerScore?: number
}

const datasetPath = process.argv[2]
const baseUrl = (process.argv[3] || 'http://127.0.0.1:3099').replace(/\/+$/, '')
const topK = Math.min(100, Math.max(1, Number(process.argv[4] || 20)))

if (!datasetPath) {
  console.error('Usage: pnpm --filter cynosure-server memory:evaluate <dataset.json> [baseUrl] [topK]')
  process.exit(2)
}

const cases = JSON.parse(readFileSync(datasetPath, 'utf8')) as EvaluationCase[]
if (!Array.isArray(cases) || cases.length === 0) throw new Error('Evaluation dataset must be a non-empty JSON array')

let reciprocalRankTotal = 0
let recallTotal = 0
let positiveCases = 0
let negativeCases = 0
let falsePositiveNegatives = 0
const failures: Array<{ query: string; expected: string[]; returned: string[] }> = []

for (const item of cases) {
  if (!item.query?.trim()) throw new Error('Every evaluation case requires a non-empty query')
  const response = await fetch(`${baseUrl}/api/memory/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: item.query, topK, spaceId: item.spaceId }),
  })
  if (!response.ok) throw new Error(`Search failed (${response.status}) for query: ${item.query}`)
  const results = await response.json() as SearchResult[]
  const returned = results.map((result) => result.sourceFile || '').filter(Boolean)

  if (item.expectNoAnswer) {
    negativeCases++
    if (results.length > 0) falsePositiveNegatives++
    continue
  }

  const expected = Array.from(new Set(item.relevantSourceFiles || []))
  if (expected.length === 0) throw new Error(`Positive case has no relevantSourceFiles: ${item.query}`)
  positiveCases++
  const found = expected.filter((source) => returned.includes(source))
  recallTotal += found.length / expected.length
  const firstRelevantRank = returned.findIndex((source) => expected.includes(source))
  if (firstRelevantRank >= 0) reciprocalRankTotal += 1 / (firstRelevantRank + 1)
  if (found.length !== expected.length) failures.push({ query: item.query, expected, returned })
}

console.log(JSON.stringify({
  cases: cases.length,
  topK,
  positiveCases,
  recallAtK: positiveCases ? recallTotal / positiveCases : null,
  meanReciprocalRank: positiveCases ? reciprocalRankTotal / positiveCases : null,
  negativeCases,
  noAnswerFalsePositiveRate: negativeCases ? falsePositiveNegatives / negativeCases : null,
  failures,
}, null, 2))
