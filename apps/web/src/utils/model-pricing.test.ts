import { describe, expect, test } from 'vitest'
import { compactPricingTag, pricingTooltipLines } from './model-pricing'

describe('reranker model pricing', () => {
  test('formats per-search pricing', () => {
    const model = {
      id: 'cohere/rerank-4-fast',
      outputModalities: ['rerank'],
      pricing: {
        prompt: 0,
        completion: 0,
        skus: { per_search: 0.002 },
      },
    }

    expect(compactPricingTag(model)).toBe('$0.002 / search')
    expect(pricingTooltipLines(model)).toContain('Per Search: $0.002 / search')
  })

  test('formats reranker input-token pricing', () => {
    const model = {
      id: 'voyageai/rerank-2.5',
      outputModalities: ['rerank'],
      pricing: {
        prompt: 0,
        completion: 0,
        skus: { input_tokens: 0.00000005 },
      },
    }

    expect(compactPricingTag(model)).toBe('$0.05/M input tokens')
  })

  test('labels an all-zero reranker price as free', () => {
    expect(compactPricingTag({
      id: 'nvidia/free-reranker',
      outputModalities: ['rerank'],
      pricing: { prompt: 0, completion: 0, skus: { input_tokens: 0 } },
    })).toBe('Free')
  })
})
