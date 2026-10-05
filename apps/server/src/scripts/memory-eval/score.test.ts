import { describe, expect, it } from 'vitest'
import { chunkMatchesGold, scoreRetrieval, signTestP } from './score.js'
import type { CaseRunResult, EvalCase } from './types.js'

const chunk = (file: string, text: string) => ({ file, text })
const result = (candidates: CaseRunResult['candidates'], selected: CaseRunResult['selected'] = []): CaseRunResult => ({
  caseId: 'c', condition: 'full', ms: 1, candidates, selected, correctiveRetry: false, injected: '',
})
const item = (overrides: Partial<EvalCase>): EvalCase => ({
  id: 'c', type: 'single', group: 'c', query: 'q', gold: [], goldMode: 'any', createdAt: 0, ...overrides,
})

describe('chunkMatchesGold', () => {
  it('matches quotes across markdown formatting and whitespace changes', () => {
    expect(chunkMatchesGold(chunk('a.md', '- **Lieblingssnack:**  Gummibärchen'), { file: 'a.md', quote: 'Lieblingssnack: Gummibärchen' })).toBe(true)
  })

  it('requires the file for short quotes but not for long ones', () => {
    expect(chunkMatchesGold(chunk('b.md', 'Preis 40 €/h'), { file: 'a.md', quote: '40 €/h' })).toBe(false)
    const quote = 'Der Stundensatz für das Projekt liegt bei 40 €/h'
    expect(chunkMatchesGold(chunk('b.md', quote), { file: 'a.md', quote })).toBe(true)
  })

  it('treats quote-less gold as document-level', () => {
    expect(chunkMatchesGold(chunk('a.md', 'anything'), { file: 'a.md' })).toBe(true)
    expect(chunkMatchesGold(chunk('b.md', 'anything'), { file: 'a.md' })).toBe(false)
  })
})

describe('scoreRetrieval', () => {
  it('reports the rank of the first gold candidate', () => {
    const score = scoreRetrieval(item({ gold: [{ file: 'a.md', quote: 'fact' }] }), result([chunk('x.md', 'noise'), chunk('a.md', 'the fact')], [chunk('a.md', 'the fact')]))
    expect(score.firstGoldRank).toBe(2)
    expect(score.retrievedAll).toBe(true)
    expect(score.selectedAll).toBe(true)
  })

  it('needs every gold item for multi-hop cases', () => {
    const multi = item({ type: 'multi', goldMode: 'all', gold: [{ file: 'a.md', quote: 'one' }, { file: 'b.md', quote: 'two' }] })
    expect(scoreRetrieval(multi, result([chunk('a.md', 'one')])).retrievedAll).toBe(false)
    expect(scoreRetrieval(multi, result([chunk('a.md', 'one'), chunk('b.md', 'two')])).retrievedAll).toBe(true)
  })

  it('counts repeated chunks of one gold document once', () => {
    const real = item({ type: 'real', gold: [{ file: 'a.md' }] })
    const score = scoreRetrieval(real, result([chunk('a.md', 'x'), chunk('a.md', 'y'), chunk('a.md', 'z')]))
    expect(score.ndcg).toBe(1)
  })

  it('does not score retrieval for no-answer cases', () => {
    expect(scoreRetrieval(item({ type: 'noanswer' }), result([chunk('a.md', 'x')])).firstGoldRank).toBe(0)
  })
})

describe('signTestP', () => {
  it('is 1 without discordant pairs and small for one-sided outcomes', () => {
    expect(signTestP(0, 0)).toBe(1)
    expect(signTestP(3, 3)).toBe(1)
    expect(signTestP(10, 0)).toBeCloseTo(0.00195, 4)
  })
})
