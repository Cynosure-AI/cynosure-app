import { evaluateRetrievalCase } from '../../core/memory/retrieval-evaluation.js'
import type { CaseRunResult, CaseScore, EvalCase, EvalChunk, EvalGold } from './types.js'

/** Quotes shorter than this can occur in unrelated documents, so they also need a file match. */
const FILE_INDEPENDENT_QUOTE_LENGTH = 24

export function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/[*_`#>|]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Does this chunk carry the gold evidence? Doc-level gold (no quote) matches by file. */
export function chunkMatchesGold(chunk: EvalChunk, gold: EvalGold): boolean {
  const sameFile = !!chunk.file && chunk.file === gold.file
  if (!gold.quote) return sameFile
  const quote = normalizeText(gold.quote)
  if (!quote || !normalizeText(chunk.text).includes(quote)) return false
  return sameFile || quote.length >= FILE_INDEPENDENT_QUOTE_LENGTH
}

export function isNoAnswerCase(item: Pick<EvalCase, 'type'>): boolean {
  return item.type === 'noanswer' || item.type === 'real-noanswer'
}

/** Retrieval metrics from the candidate pool, before any judge call. */
export function scoreRetrieval(item: EvalCase, result: CaseRunResult): Pick<CaseScore, 'firstGoldRank' | 'retrievedAll' | 'selectedAll' | 'ndcg'> {
  if (isNoAnswerCase(item) || item.gold.length === 0) {
    return { firstGoldRank: 0, retrievedAll: false, selectedAll: false, ndcg: 0 }
  }
  const goldKeys = item.gold.map((_, index) => `gold:${index}`)
  // Map each candidate to the first gold item it satisfies so the shared
  // metric helper can treat evidence identity independent of chunk ids.
  // Several chunks of one gold document are one piece of evidence: only the
  // first occurrence counts as relevant, or nDCG exceeds its ideal.
  const seen = new Set<number>()
  const returned = result.candidates.map((chunk, index) => {
    const goldIndex = item.gold.findIndex((gold, goldIdx) => !seen.has(goldIdx) && chunkMatchesGold(chunk, gold))
    if (goldIndex < 0) return `other:${index}`
    seen.add(goldIndex)
    return goldKeys[goldIndex]
  })
  const metrics = evaluateRetrievalCase(returned, goldKeys, Math.max(1, returned.length))
  const firstGold = returned.findIndex((key) => key.startsWith('gold:'))
  const covered = (chunks: EvalChunk[]) => item.gold.map((gold) => chunks.some((chunk) => chunkMatchesGold(chunk, gold)))
  const need = (flags: boolean[]) => item.goldMode === 'all' ? flags.every(Boolean) : flags.some(Boolean)
  return {
    firstGoldRank: firstGold + 1,
    retrievedAll: need(covered(result.candidates)),
    selectedAll: need(covered(result.selected)),
    ndcg: metrics.ndcg,
  }
}

/** Scores an absolute relevance floor would act on (see the report's threshold sweep). */
export function selectionScores(item: EvalCase, result: CaseRunResult): Pick<CaseScore, 'topSelectedScore' | 'goldSelectedScore' | 'scoreType'> {
  const scored = result.selected.filter((chunk) => Number.isFinite(chunk.score))
  if (!scored.length) return {}
  const gold = scored.filter((chunk) => item.gold.some((entry) => chunkMatchesGold(chunk, entry)))
  return {
    topSelectedScore: Math.max(...scored.map((chunk) => chunk.score!)),
    goldSelectedScore: gold.length ? Math.max(...gold.map((chunk) => chunk.score!)) : undefined,
    scoreType: scored[0].scoreType,
  }
}

/** Exact two-sided sign test on paired wins/losses. */
export function signTestP(wins: number, losses: number): number {
  const n = wins + losses
  if (n === 0) return 1
  const k = Math.min(wins, losses)
  let tail = 0
  for (let i = 0; i <= k; i++) tail += binomial(n, i)
  return Math.min(1, (2 * tail) / 2 ** n)
}

function binomial(n: number, k: number): number {
  let result = 1
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i
  return result
}

export const JUDGE_SUPPORT_PROMPT = [
  'You grade a memory retrieval system. Given a question, the reference answer, and the CONTEXT injected for the assistant,',
  'decide whether the context alone lets an assistant give the reference answer.',
  'Return JSON {"verdict": "full"|"partial"|"none"}. full = every fact of the reference answer is stated in the context;',
  'partial = some needed facts are present; none = not present. Ignore extra irrelevant context.',
].join(' ')

export const JUDGE_NO_ANSWER_PROMPT = [
  'You grade a memory retrieval system. The question has NO answer in the user\'s notes.',
  'Given the CONTEXT that was injected, decide whether the context states a direct answer to the question',
  '(which would invite the assistant to answer from wrong evidence). Return JSON {"answers": true|false}.',
].join(' ')
