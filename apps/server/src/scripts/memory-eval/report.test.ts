import { describe, expect, it } from 'vitest'
import { summarize, thresholdSweep } from './report.js'
import type { CaseScore } from './types.js'

const score = (overrides: Partial<CaseScore>): CaseScore => ({
  caseId: 'c', condition: 'rr', type: 'single', ms: 10, firstGoldRank: 1, retrievedAll: true, selectedAll: true,
  ndcg: 1, injected: true, selectedCount: 1, fallback: false, correctiveRetry: false, scoreType: 'reranker', ...overrides,
})

describe('thresholdSweep', () => {
  it('trades kept gold evidence against no-answer injections', () => {
    const sweep = thresholdSweep([
      score({ caseId: 'a', goldSelectedScore: 0.9, topSelectedScore: 0.9 }),
      score({ caseId: 'b', goldSelectedScore: 0.45, topSelectedScore: 0.45 }),
      score({ caseId: 'n', type: 'noanswer', topSelectedScore: 0.35 }),
    ])!
    const row = (floor: string) => sweep.split('\n').find((line) => line.trim().startsWith(floor))!
    expect(row('0.00')).toContain('2/2')
    expect(row('0.00')).toContain('(1/1)')
    expect(row('0.40')).toContain('2/2')
    expect(row('0.40')).toContain('(0/1)')
    expect(row('0.50')).toContain('1/2')
  })

  it('is skipped without reranker scores', () => {
    expect(thresholdSweep([score({ scoreType: 'dense' })])).toBeUndefined()
  })
})

describe('summarize', () => {
  it('separates answerable and no-answer cases', () => {
    const summary = summarize([
      score({ firstGoldRank: 1, support: 'full' }),
      score({ firstGoldRank: 0, support: 'none' }),
      score({ type: 'noanswer', injected: true, misleading: false }),
    ])
    expect(summary.n).toBe(2)
    expect(summary.hit1).toBe(0.5)
    expect(summary.supported).toBe(0.5)
    expect(summary.noAnswerN).toBe(1)
    expect(summary.noAnswerInjected).toBe(1)
  })
})
