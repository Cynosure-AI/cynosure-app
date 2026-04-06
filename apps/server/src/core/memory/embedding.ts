import OpenAI from 'openai'
import { getGateway } from '../gateway/gateway.js'
import { getDb } from '../../db/database.js'

export interface EmbeddingConfig {
  providerId?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  dimensions?: number
}

export interface EmbeddingResult {
  vector: number[]
  model: string
  dimensions: number
}

export class EmbeddingProvider {
  private client: OpenAI | null = null
  private model: string = 'text-embedding-3-small'
  private dimensions: number = 1536
  private configured: boolean = false
  private providerId: string | null = null

  /**
   * Load saved embedding config from the database (called at startup).
   */
  loadFromDb(): void {
    try {
      const db = getDb()
      const row = db.prepare("SELECT value_json FROM settings WHERE key = 'embedding'").get() as { value_json: string } | undefined
      if (row) {
        const config = JSON.parse(row.value_json) as EmbeddingConfig
        this.configure(config, false)
      }
    } catch {
      // DB not ready or no config saved — proceed with defaults
    }
  }

  /**
   * Configure the embedding provider. Optionally persists to DB.
   */
  configure(opts?: EmbeddingConfig, persist: boolean = true): void {
    if (opts?.model) this.model = opts.model
    if (opts?.dimensions) this.dimensions = opts.dimensions
    if (opts?.providerId !== undefined) this.providerId = opts.providerId || null

    const baseURL = opts?.baseUrl
    const apiKey = opts?.apiKey

    if (baseURL || apiKey) {
      this.client = new OpenAI({
        baseURL: baseURL || 'https://api.openai.com/v1',
        apiKey: apiKey || ''
      })
      this.configured = true
    } else if (opts?.providerId) {
      // Use the registered provider's connection info
      const gateway = getGateway()
      const provider = gateway.getProvider(opts.providerId)
      if (provider) {
        this.client = new OpenAI({
          baseURL: provider.config.baseUrl,
          apiKey: provider.config.apiKey || 'no-key'
        })
        this.configured = true
      }
    }

    if (persist && opts) {
      try {
        const db = getDb()
        db.prepare(
          "INSERT OR REPLACE INTO settings (key, value_json) VALUES ('embedding', ?)"
        ).run(JSON.stringify(opts))
      } catch {
        // Best-effort persistence
      }
    }
  }

  /**
   * Returns the current configuration (without the API key value).
   */
  getConfig(): EmbeddingConfig {
    return {
      providerId: this.providerId || undefined,
      model: this.model,
      dimensions: this.dimensions
    }
  }

  private getClient(): OpenAI {
    if (this.client) return this.client

    // Fall back to active provider — works for OpenAI-compatible endpoints only
    const gateway = getGateway()
    const provider = gateway.getActiveProvider()
    if (provider.config.type !== 'openai' && provider.config.type !== 'lmstudio') {
      console.warn(
        `[Embedding] No embedding provider configured. Active LLM provider "${provider.config.type}" may not support OpenAI-compatible embeddings. ` +
        `Configure embedding separately via POST /api/memory/embeddings/configure.`
      )
    }
    return new OpenAI({
      baseURL: provider.config.baseUrl,
      apiKey: provider.config.apiKey || 'no-key'
    })
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const results = await this.embedBatch([text])
    return results[0]
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const client = this.getClient()

    const response = await client.embeddings.create({
      model: this.model,
      input: texts,
      dimensions: this.dimensions
    })

    return response.data.map((item) => ({
      vector: item.embedding,
      model: response.model,
      dimensions: item.embedding.length
    }))
  }

  getModelName(): string {
    return this.model
  }

  getDimensions(): number {
    return this.dimensions
  }
}

let embeddingInstance: EmbeddingProvider | null = null

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!embeddingInstance) {
    embeddingInstance = new EmbeddingProvider()
  }
  return embeddingInstance
}
