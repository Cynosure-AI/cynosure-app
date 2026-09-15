import { getDb } from '../../db/database.js'
import { getGateway } from '../gateway/gateway.js'
import { estimateTextTokens, estimateTextsTokens, recordAuxiliaryModelUsage } from '../usage-metering.js'
import { RERANKER_LIMITS } from '@cynosure/runtime-config'
import type { SearchResult } from './rag.js'

export interface MemoryRerankerConfig {
  enabled: boolean
  providerId?: string
  model: string
  candidateCount: number
}

interface OpenRouterRerankResponse {
  results?: Array<{
    index?: number
    relevance_score?: number
  }>
}

const SETTINGS_KEY = 'memoryReranker'
const DEFAULT_CONFIG: MemoryRerankerConfig = {
  enabled: false,
  model: '',
  candidateCount: RERANKER_LIMITS.defaultCandidateCount
}

function normalizeConfig(config: Partial<MemoryRerankerConfig> | undefined): MemoryRerankerConfig {
  const candidateCount = Number.isFinite(config?.candidateCount)
    ? Math.round(config!.candidateCount as number)
    : DEFAULT_CONFIG.candidateCount
  return {
    enabled: !!config?.enabled,
    providerId: config?.providerId?.trim() || undefined,
    model: config?.model?.trim() || '',
    candidateCount: Math.min(RERANKER_LIMITS.maxCandidateCount, Math.max(RERANKER_LIMITS.minCandidateCount, candidateCount))
  }
}

export class MemoryReranker {
  getConfig(): MemoryRerankerConfig {
    try {
      const db = getDb()
      const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value_json: string } | undefined
      if (!row) return { ...DEFAULT_CONFIG }
      return normalizeConfig(JSON.parse(row.value_json) as Partial<MemoryRerankerConfig>)
    } catch {
      return { ...DEFAULT_CONFIG }
    }
  }

  saveConfig(config: Partial<MemoryRerankerConfig>): MemoryRerankerConfig {
    const normalized = normalizeConfig(config)
    const db = getDb()
    db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(SETTINGS_KEY, JSON.stringify(normalized))
    return normalized
  }

  getCandidateCount(topK: number): number {
    const config = this.getConfig()
    return config.enabled ? Math.max(topK, config.candidateCount) : topK
  }

  async rerank(query: string, results: SearchResult[], topK: number): Promise<SearchResult[]> {
    const config = this.getConfig()
    if (!config.enabled || results.length <= 1) return results.slice(0, topK)
    if (!config.model) return results.slice(0, topK)

    const provider = this.resolveOpenRouterProvider(config.providerId)
    if (!provider) return results.slice(0, topK)
    const documents = results.map(formatRerankerDocument)

    const baseUrl = provider.config.baseUrl.replace(/\/+$/, '')
    const res = await fetch(`${baseUrl}/rerank`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.config.apiKey || ''}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/andreasjhagen/Cynosure',
        'X-OpenRouter-Title': 'Cynosure'
      },
      body: JSON.stringify({
        model: config.model,
        query,
        documents,
        top_n: Math.min(topK, results.length)
      })
    })

    if (!res.ok) {
      throw new Error(`OpenRouter rerank failed: ${res.status} ${res.statusText}`)
    }

    const data = await res.json() as OpenRouterRerankResponse
    recordAuxiliaryModelUsage({
      kind: 'reranker',
      provider: provider.config.type,
      model: config.model,
      inputTokens: estimateTextTokens(query) + estimateTextsTokens(documents),
    })

    const reranked = (data.results || [])
      .map((item) => {
        if (item.index == null) return null
        const result = results[item.index]
        if (!result) return null
        const rerankerScore = typeof item.relevance_score === 'number' ? item.relevance_score : undefined
        return {
          ...result,
          score: rerankerScore ?? result.score,
          scoreType: rerankerScore !== undefined ? 'reranker' as const : result.scoreType,
          ...(rerankerScore !== undefined ? { rerankerScore } : {}),
        }
      })
      .filter((item): item is SearchResult => item != null)

    return reranked.length > 0 ? reranked : results.slice(0, topK)
  }

  private resolveOpenRouterProvider(providerId: string | undefined) {
    const gateway = getGateway()
    if (providerId) {
      const provider = gateway.getProvider(providerId)
      return provider?.config.type === 'openrouter' ? provider : undefined
    }

    try {
      const active = gateway.getLastUsedProvider()
      if (active.config.type === 'openrouter') return active
    } catch {
      // Fall through to any registered OpenRouter provider.
    }

    for (const provider of gateway.getAllProviders().values()) {
      if (provider.config.type === 'openrouter') return provider
    }
    return undefined
  }
}

function formatRerankerDocument(result: SearchResult): string {
  return [
    result.documentTitle ? `Document: ${result.documentTitle}` : '',
    result.sectionPath && result.sectionPath !== result.documentTitle ? `Section: ${result.sectionPath}` : '',
    result.text,
  ].filter(Boolean).join('\n')
}

let rerankerInstance: MemoryReranker | null = null

export function getMemoryReranker(): MemoryReranker {
  if (!rerankerInstance) {
    rerankerInstance = new MemoryReranker()
  }
  return rerankerInstance
}
