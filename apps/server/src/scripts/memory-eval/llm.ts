import { getGateway } from '../../core/gateway/gateway.js'
import { ensurePricingLoaded, getModelCost } from '../../core/model-dev-fetcher.js'

export interface ModelRef {
  providerId?: string
  model?: string
}

export const usage = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 }

export async function costUsd(ref: ModelRef, inputTokens: number, outputTokens: number): Promise<number> {
  await ensurePricingLoaded().catch(() => undefined)
  const provider = ref.providerId ? getGateway().getProvider(ref.providerId) : getGateway().getLastUsedProvider()
  const cost = ref.model ? getModelCost(provider?.config.type || '', ref.model) : null
  return cost ? (inputTokens * cost.input + outputTokens * cost.output) / 1_000_000 : 0
}

/** One JSON-object completion. Retries transient failures and malformed JSON. */
export async function completeJson<T>(ref: ModelRef, system: string, user: string, opts: { temperature?: number; maxTokens?: number } = {}): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await getGateway().complete({
        model: ref.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: opts.temperature ?? 0,
        maxTokens: opts.maxTokens ?? 1_500,
        thinkingEnabled: false,
      }, ref.providerId)
      usage.calls++
      usage.inputTokens += response.usage.promptTokens
      usage.outputTokens += response.usage.completionTokens
      usage.usd += await costUsd(ref, response.usage.promptTokens, response.usage.completionTokens)
      const match = response.content.match(/\{[\s\S]*\}/)
      return JSON.parse(match ? match[0] : response.content) as T
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)))
    }
  }
  throw lastError
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  }))
  return results
}
