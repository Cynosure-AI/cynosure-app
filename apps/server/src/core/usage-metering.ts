import { randomUUID } from 'crypto'
import { getDb } from '../db/database.js'

export type AuxiliaryUsageKind = 'embedding' | 'reranker' | 'knowledge-extraction'

export interface AuxiliaryModelUsageInput {
  kind: AuxiliaryUsageKind
  provider: string
  model: string
  inputTokens?: number
  outputTokens?: number
  requestCount?: number
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

export function estimateTextsTokens(texts: string[]): number {
  return texts.reduce((sum, text) => sum + estimateTextTokens(text), 0)
}

export function recordAuxiliaryModelUsage(input: AuxiliaryModelUsageInput): void {
  try {
    getDb().prepare(`
      INSERT INTO auxiliary_model_usage (
        id, kind, provider, model, input_tokens, output_tokens, request_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.kind,
      input.provider || '',
      input.model || '',
      Math.max(0, Math.round(input.inputTokens ?? 0)),
      Math.max(0, Math.round(input.outputTokens ?? 0)),
      Math.max(1, Math.round(input.requestCount ?? 1)),
      Date.now(),
    )
  } catch (err) {
    console.warn('[usage] Failed to record auxiliary model usage:', err instanceof Error ? err.message : err)
  }
}
