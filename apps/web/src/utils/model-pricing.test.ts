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

describe('extended model pricing', () => {
  test('shows the generated-image price ahead of input and variant SKUs', () => {
    expect(compactPricingTag({
      id: 'x-ai/grok-imagine-image-2.0',
      outputModalities: ['image'],
      pricing: {
        image: 0.04,
        skus: { input_image_per_image: 0.01, output_image_low_1k_per_image: 0.04 },
      },
    })).toBe('$0.04/img')
  })

  test('formats explicit audio-duration SKUs without treating them as tokens', () => {
    expect(compactPricingTag({
      id: 'openai/whisper-large-v3',
      outputModalities: ['transcription'],
      pricing: { prompt: 0, completion: 0, skus: { per_audio_minute: 0.0015 } },
    })).toBe('$0.0015/min')
  })

  test('shows context pricing tiers', () => {
    expect(pricingTooltipLines({
      id: 'tiered-model',
      pricing: {
        prompt: 0.000001,
        completion: 0.000002,
        tiers: [{ minPromptTokens: 200_000, prompt: 0.000002, completion: 0.000004 }],
      },
    })).toContain('≥ 200K input tokens: $2.00 / $4.00 per 1M tokens')
  })
})
