import { describe, expect, test } from 'vitest'
import { evaluateRetrievalCase, summarizeRetrievalEvaluation } from './retrieval-evaluation.js'

describe('retrieval evaluation metrics', () => {
  test('computes rank-aware metrics for positive cases', () => {
    const result = evaluateRetrievalCase(['noise', 'caroline.md', 'other'], ['caroline.md'], 3)
    expect(result).toMatchObject({ positive: true, hit: 1, recall: 1, precision: 1 / 3, reciprocalRank: 0.5 })
    expect(result.ndcg).toBeCloseTo(1 / Math.log2(3))
  })

  test('reports false positives for unanswerable cases and aggregates both classes', () => {
    const summary = summarizeRetrievalEvaluation([
      evaluateRetrievalCase(['caroline.md'], ['caroline.md'], 1),
      evaluateRetrievalCase(['noise'], [], 1, true),
      evaluateRetrievalCase([], [], 1, true),
    ])
    expect(summary).toMatchObject({
      positiveCases: 1,
      negativeCases: 2,
      hitRateAtK: 1,
      recallAtK: 1,
      meanReciprocalRank: 1,
      noAnswerFalsePositiveRate: 0.5,
    })
  })
})
