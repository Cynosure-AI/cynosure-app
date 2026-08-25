export interface RetrievalEvaluationCaseResult {
  positive: boolean
  hit: number
  recall: number
  precision: number
  reciprocalRank: number
  ndcg: number
  falsePositive: number
}

export interface RetrievalEvaluationSummary {
  positiveCases: number
  negativeCases: number
  hitRateAtK: number | null
  recallAtK: number | null
  precisionAtK: number | null
  meanReciprocalRank: number | null
  ndcgAtK: number | null
  noAnswerFalsePositiveRate: number | null
}

export function evaluateRetrievalCase(
  returned: string[],
  relevant: string[],
  topK: number,
  expectNoAnswer = false,
): RetrievalEvaluationCaseResult {
  const ranked = returned.slice(0, topK)
  if (expectNoAnswer) {
    return {
      positive: false,
      hit: 0,
      recall: 0,
      precision: 0,
      reciprocalRank: 0,
      ndcg: 0,
      falsePositive: ranked.length > 0 ? 1 : 0,
    }
  }

  const expected = new Set(relevant)
  const relevance: number[] = ranked.map((value) => expected.has(value) ? 1 : 0)
  const found = new Set(ranked.filter((value) => expected.has(value))).size
  const firstRelevant = relevance.indexOf(1)
  const dcg = relevance.reduce((total, value, index) => total + value / Math.log2(index + 2), 0)
  const idealCount = Math.min(expected.size, topK)
  const idealDcg = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((total, value) => total + value, 0)

  return {
    positive: true,
    hit: found > 0 ? 1 : 0,
    recall: expected.size ? found / expected.size : 0,
    precision: topK > 0 ? found / topK : 0,
    reciprocalRank: firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0,
    ndcg: idealDcg ? dcg / idealDcg : 0,
    falsePositive: 0,
  }
}

export function summarizeRetrievalEvaluation(results: RetrievalEvaluationCaseResult[]): RetrievalEvaluationSummary {
  const positives = results.filter((result) => result.positive)
  const negatives = results.filter((result) => !result.positive)
  const mean = (values: number[]): number | null => values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null

  return {
    positiveCases: positives.length,
    negativeCases: negatives.length,
    hitRateAtK: mean(positives.map((result) => result.hit)),
    recallAtK: mean(positives.map((result) => result.recall)),
    precisionAtK: mean(positives.map((result) => result.precision)),
    meanReciprocalRank: mean(positives.map((result) => result.reciprocalRank)),
    ndcgAtK: mean(positives.map((result) => result.ndcg)),
    noAnswerFalsePositiveRate: mean(negatives.map((result) => result.falsePositive)),
  }
}
