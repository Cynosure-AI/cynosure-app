import OpenAI from 'openai'
import { GoogleGenAI } from '@google/genai'

export interface EmbeddingAdapterResponse {
  vectors: number[][]
  model: string
  inputTokens?: number
}

export interface EmbeddingAdapter {
  embed(texts: string[], model: string, dimensions?: number, signal?: AbortSignal): Promise<EmbeddingAdapterResponse>
}

export interface EmbeddingConnection {
  kind: 'google' | 'openai-compatible'
  baseUrl?: string
  apiKey: string
  providerType?: string
}

export function createEmbeddingAdapter(connection: EmbeddingConnection): EmbeddingAdapter {
  if (connection.kind === 'google') {
    const client = new GoogleGenAI({ apiKey: connection.apiKey })
    return {
      async embed(texts, model, dimensions, signal) {
        signal?.throwIfAborted()
        const response = await client.models.embedContent({
          model, contents: texts,
          ...(dimensions ? { config: { outputDimensionality: dimensions } } : {}),
        })
        signal?.throwIfAborted()
        return { vectors: (response.embeddings || []).map((item) => item.values || []), model }
      },
    }
  }

  const defaultHeaders: Record<string, string> = {}
  if (connection.providerType === 'openrouter') {
    defaultHeaders['HTTP-Referer'] = 'https://cynosure-ai.github.io'
    defaultHeaders['X-OpenRouter-Title'] = 'Cynosure Embedder'
  } else if (connection.providerType === 'requesty') {
    defaultHeaders['HTTP-Referer'] = 'https://cynosure-ai.github.io'
    defaultHeaders['X-Title'] = 'Cynosure Embedder'
  }
  const client = new OpenAI({ baseURL: connection.baseUrl, apiKey: connection.apiKey, defaultHeaders })
  return {
    async embed(texts, model, dimensions, signal) {
      const response = await client.embeddings.create(
        { model, input: texts, ...(dimensions ? { dimensions } : {}) }, { signal },
      )
      return {
        vectors: response.data.map((item) => item.embedding),
        model: response.model || model,
        inputTokens: response.usage?.prompt_tokens ?? response.usage?.total_tokens,
      }
    },
  }
}
