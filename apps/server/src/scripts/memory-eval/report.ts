import { isNoAnswerCase, signTestP } from './score.js'
import type { CaseScore, EvalRun } from './types.js'

export interface ConditionSummary {
  n: number
  hit1: number | null
  hit5: number | null
  hit10: number | null
  mrr: number | null
  ndcg: number | null
  selected: number | null
  /** Judge: full or partial support (synthetic cases with a reference answer). */
  supported: number | null
  noAnswerN: number
  noAnswerInjected: number | null
  noAnswerMisleading: number | null
  fallbackRate: number
  medianMs: number
}

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const isNoAnswer = (score: CaseScore) => isNoAnswerCase(score)

export function summarize(scores: CaseScore[]): ConditionSummary {
  const ok = scores.filter((score) => !score.error)
  const positive = ok.filter((score) => !isNoAnswer(score))
  const judged = positive.filter((score) => score.support)
  const negative = ok.filter(isNoAnswer)
  const ranks = positive.map((score) => score.firstGoldRank)
  const ms = ok.map((score) => score.ms).sort((a, b) => a - b)
  return {
    n: positive.length,
    hit1: mean(ranks.map((rank) => rank === 1 ? 1 : 0)),
    hit5: mean(ranks.map((rank) => rank > 0 && rank <= 5 ? 1 : 0)),
    hit10: mean(ranks.map((rank) => rank > 0 && rank <= 10 ? 1 : 0)),
    mrr: mean(ranks.map((rank) => rank > 0 ? 1 / rank : 0)),
    ndcg: mean(positive.map((score) => score.ndcg)),
    selected: mean(positive.map((score) => score.selectedAll ? 1 : 0)),
    supported: mean(judged.map((score) => score.support === 'none' ? 0 : 1)),
    noAnswerN: negative.length,
    noAnswerInjected: mean(negative.map((score) => score.injected ? 1 : 0)),
    noAnswerMisleading: mean(negative.map((score) => score.misleading ? 1 : 0)),
    fallbackRate: mean(ok.map((score) => score.fallback ? 1 : 0)) ?? 0,
    medianMs: ms[Math.floor(ms.length / 2)] ?? 0,
  }
}

/** A case "succeeds" when the judge saw support, else (real cases) when gold was selected. */
export function caseSucceeded(score: CaseScore): boolean {
  if (isNoAnswer(score)) return !score.misleading
  return score.support ? score.support !== 'none' : score.selectedAll
}

const pct = (value: number | null) => value === null ? '    -' : `${(value * 100).toFixed(1).padStart(5)}`
const num = (value: number | null, digits = 3) => value === null ? '    -' : value.toFixed(digits)

function summaryTable(rows: Array<[string, ConditionSummary]>): string {
  const header = 'condition         n  hit@1  hit@5 hit@10    MRR   nDCG  selected  supported | noAns n  injected  misleading | fallback  median ms'
  const lines = rows.map(([name, s]) => [
    name.padEnd(14), String(s.n).padStart(4), ` ${pct(s.hit1)}  ${pct(s.hit5)}  ${pct(s.hit10)}  ${num(s.mrr)}  ${num(s.ndcg)}     ${pct(s.selected)}      ${pct(s.supported)}`,
    ` |  ${String(s.noAnswerN).padStart(6)}     ${pct(s.noAnswerInjected)}       ${pct(s.noAnswerMisleading)}`,
    ` |    ${pct(s.fallbackRate)}  ${String(s.medianMs).padStart(9)}`,
  ].join(''))
  return [header, ...lines].join('\n')
}

export function renderReport(run: EvalRun, previous?: EvalRun): string {
  const names = run.conditions.map((condition) => condition.name)
  const byCondition = (name: string, filter: (score: CaseScore) => boolean = () => true) => run.scores.filter((score) => score.condition === name && filter(score))
  const out: string[] = []
  out.push(`# Memory eval ${run.id}${run.label ? ` — ${run.label}` : ''}`)
  out.push(`commit ${run.gitCommit || '?'} · ${run.datasetSize} cases · curator ${run.curator.model || 'default'} · judge ${run.judge.model || 'default'} · cost $${(run.cost.curatorUsd + run.cost.judgeUsd + (run.cost.rerankUsd || 0)).toFixed(3)}${run.cost.rerankRequests ? ` (incl. ${run.cost.rerankRequests} rerank requests ≈ $${(run.cost.rerankUsd || 0).toFixed(2)})` : ''}`)
  // Older runs carry retired knobs (graph, projections, summaries); print whatever a run recorded.
  out.push('Conditions: ' + run.conditions.map((c) => `${c.name} (${Object.entries(c).filter(([key]) => key !== 'name').map(([key, value]) => `${key}=${value === true ? 'on' : value === false ? 'off' : value}`).join(', ')})`).join('; '))

  out.push('\n## Overall\n```\n' + summaryTable(names.map((name) => [name, summarize(byCondition(name))])) + '\n```')
  const types = [...new Set(run.scores.map((score) => score.type))].filter((type) => !type.includes('noanswer'))
  for (const type of types) {
    out.push(`\n## type = ${type}\n\`\`\`\n` + summaryTable(names.map((name) => [name, summarize(byCondition(name, (score) => score.type === type))])) + '\n```')
  }

  // Paired comparison: same case, two conditions. Differences of a few cases
  // are within curator/judge noise; the sign test makes that explicit.
  const baseline = names[0]
  const paired: string[] = []
  for (const name of names.slice(1)) {
    const base = new Map(byCondition(baseline).filter((score) => !score.error).map((score) => [score.caseId, caseSucceeded(score)]))
    let wins = 0
    let losses = 0
    const won: string[] = []
    const lost: string[] = []
    for (const score of byCondition(name)) {
      if (score.error || !base.has(score.caseId)) continue
      const other = caseSucceeded(score)
      if (other && !base.get(score.caseId)) { wins++; won.push(score.caseId) }
      if (!other && base.get(score.caseId)) { losses++; lost.push(score.caseId) }
    }
    paired.push(`${name.padEnd(14)} vs ${baseline}: +${wins} / -${losses}  (sign test p=${signTestP(wins, losses).toFixed(3)})${won.length ? `  better: ${won.slice(0, 6).join(', ')}` : ''}${lost.length ? `  worse: ${lost.slice(0, 6).join(', ')}` : ''}`)
  }
  if (paired.length) out.push('\n## Paired vs baseline (case succeeded = supported / not misled)\n```\n' + paired.join('\n') + '\n```')

  if (previous) {
    const lines: string[] = []
    for (const name of names) {
      // Only cases present in both runs are comparable (datasets grow and get reviewed).
      const current = byCondition(name)
      const shared = new Set(current.map((score) => score.caseId))
      const before = previous.scores.filter((score) => score.condition === name && shared.has(score.caseId))
      if (!before.length) continue
      const beforeIds = new Set(before.map((score) => score.caseId))
      const a = summarize(before)
      const b = summarize(current.filter((score) => beforeIds.has(score.caseId)))
      const delta = (key: keyof ConditionSummary) => {
        const x = a[key] as number | null
        const y = b[key] as number | null
        return x === null || y === null ? '   -' : `${y - x >= 0 ? '+' : ''}${((y - x) * 100).toFixed(1)}`
      }
      const beforeOutcome = new Map(before.filter((score) => !score.error).map((score) => [score.caseId, caseSucceeded(score)]))
      let wins = 0
      let losses = 0
      for (const score of current) {
        if (score.error || !beforeOutcome.has(score.caseId)) continue
        if (caseSucceeded(score) && !beforeOutcome.get(score.caseId)) wins++
        if (!caseSucceeded(score) && beforeOutcome.get(score.caseId)) losses++
      }
      lines.push(`${name.padEnd(14)} hit@5 ${delta('hit5')}  MRR ${delta('mrr')}  selected ${delta('selected')}  supported ${delta('supported')}  noAns injected ${delta('noAnswerInjected')}  misleading ${delta('noAnswerMisleading')}  (points, ${beforeIds.size} shared cases; paired +${wins} / -${losses}, p=${signTestP(wins, losses).toFixed(3)})`)
    }
    if (lines.length) out.push(`\n## Change since ${previous.id}${previous.label ? ` (${previous.label})` : ''}\n\`\`\`\n${lines.join('\n')}\n\`\`\``)
  }

  for (const name of names) {
    const sweep = thresholdSweep(byCondition(name))
    if (sweep) out.push(`\n## Absolute score floor — ${name}\n\`\`\`\n${sweep}\n\`\`\``)
  }

  const errors = run.scores.filter((score) => score.error)
  if (errors.length) out.push(`\n${errors.length} case run(s) failed, e.g. ${errors[0].caseId}: ${errors[0].error}`)
  return out.join('\n')
}

const SWEEP_THRESHOLDS = [0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]

/**
 * Offline what-if for an absolute floor on reranker scores: drop selected
 * chunks scoring below t. Answerable cases keep their evidence while the gold
 * chunk clears t; no-answer cases stay clean when no chunk clears it. Graph
 * edges are not scored and are ignored here.
 */
export function thresholdSweep(scores: CaseScore[]): string | undefined {
  const ok = scores.filter((score) => !score.error)
  if (!ok.some((score) => score.scoreType === 'reranker')) return undefined
  const positive = ok.filter((score) => !isNoAnswer(score) && score.selectedAll)
  const negative = ok.filter(isNoAnswer)
  const lines = ['floor   gold kept  (of selected)   no-answer injected']
  for (const t of SWEEP_THRESHOLDS) {
    const kept = positive.filter((score) => (score.goldSelectedScore ?? 0) >= t).length
    const injected = negative.filter((score) => (score.topSelectedScore ?? -1) >= t).length
    lines.push(`${t.toFixed(2).padStart(5)}   ${pct(positive.length ? kept / positive.length : null)}%   ${String(kept).padStart(4)}/${positive.length}        ${pct(negative.length ? injected / negative.length : null)}%  (${injected}/${negative.length})`)
  }
  return lines.join('\n')
}
