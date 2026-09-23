import { createHash } from 'node:crypto'
import { getEventBus } from '../telemetry/event-bus.js'
import { getGateway } from '../gateway/gateway.js'
import { getDb } from '../../db/database.js'
import { estimateTextsTokens, recordAuxiliaryModelUsage } from '../usage-metering.js'
import { createEmbeddingAdapter, type EmbeddingAdapter, type EmbeddingConnection } from './embedding-adapters.js'

export interface EmbeddingConfig {
  providerId?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  dimensions?: number
}

export interface EmbeddingProfile {
  readonly providerId: string
  readonly providerType: string
  readonly endpoint: string
  readonly model: string
  readonly dimensions: number
  readonly fingerprint: string
}

export interface EmbeddingResult {
  vector: number[]
  model: string
  dimensions: number
  profileFingerprint: string
}

const DEFAULT_MODEL = 'text-embedding-3-small'
const DEFAULT_DIMENSIONS = 1536

function resolveConnection(config: EmbeddingConfig): { connection: EmbeddingConnection; providerId: string; providerType: string; endpoint: string } {
  if (config.providerId && (config.baseUrl || config.apiKey)) {
    throw new Error('Choose either a registered embedding provider or a direct embedding connection')
  }
  if (config.baseUrl || config.apiKey) {
    return {
      connection: { kind: 'openai-compatible', baseUrl: config.baseUrl || 'https://api.openai.com/v1', apiKey: config.apiKey || 'no-key' },
      providerId: 'direct', providerType: 'openai-compatible',
      endpoint: config.baseUrl || 'https://api.openai.com/v1',
    }
  }
  if (!config.providerId) throw new Error('Configure an embedding provider before indexing or searching memory')
  const provider = getGateway().getProvider(config.providerId)
  if (!provider) throw new Error(`Embedding provider "${config.providerId}" was not found`)
  const providerType = provider.config.type
  return {
    connection: {
      kind: providerType === 'google' ? 'google' : 'openai-compatible',
      baseUrl: provider.config.baseUrl,
      apiKey: provider.config.apiKey || 'no-key',
      providerType,
    },
    providerId: config.providerId,
    providerType,
    endpoint: provider.config.baseUrl || (providerType === 'google' ? 'google-generative-language' : 'https://api.openai.com/v1'),
  }
}

function fingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export class EmbeddingService {
  readonly profile: EmbeddingProfile
  private readonly adapter: EmbeddingAdapter
  private readonly config: Readonly<EmbeddingConfig>

  constructor(config: EmbeddingConfig, adapter?: EmbeddingAdapter) {
    const model = config.model?.trim() || DEFAULT_MODEL
    const dimensions = config.dimensions ?? DEFAULT_DIMENSIONS
    if (!Number.isSafeInteger(dimensions) || dimensions < 1) throw new Error('Embedding dimensions must be a positive integer')
    const resolved = resolveConnection(config)
    const credentialIdentity = fingerprint([resolved.connection.apiKey])
    this.profile = Object.freeze({
      providerId: resolved.providerId,
      providerType: resolved.providerType,
      endpoint: resolved.endpoint,
      model,
      dimensions,
      fingerprint: fingerprint([1, resolved.providerId, resolved.providerType, resolved.endpoint, model, dimensions, credentialIdentity]),
    })
    this.config = Object.freeze({ ...config, model, dimensions })
    this.adapter = adapter ?? createEmbeddingAdapter(resolved.connection)
  }

  getConfig(): EmbeddingConfig {
    return { providerId: this.config.providerId, baseUrl: this.config.baseUrl,
      model: this.profile.model, dimensions: this.profile.dimensions }
  }

  getModelName(): string { return this.profile.model }
  getDimensions(): number { return this.profile.dimensions }

  async embed(text: string, signal?: AbortSignal): Promise<EmbeddingResult> {
    return (await this.embedBatch([text], signal))[0]
  }

  async embedBatch(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult[]> {
    if (!texts.length) return []
    signal?.throwIfAborted()
    const response = await this.adapter.embed(texts, this.profile.model, this.profile.dimensions, signal)
    signal?.throwIfAborted()
    if (response.vectors.length !== texts.length) {
      throw new Error(`Embedding response returned ${response.vectors.length} vectors for ${texts.length} inputs`)
    }
    if (response.model.toLowerCase() !== this.profile.model.toLowerCase()) {
      throw new Error(`Embedding provider returned model "${response.model}" for profile model "${this.profile.model}"`)
    }
    const results = response.vectors.map((vector) => {
      if (vector.length !== this.profile.dimensions || vector.some((value) => !Number.isFinite(value))) {
        throw new Error(`Embedding response is incompatible with profile ${this.profile.fingerprint}: expected ${this.profile.dimensions} finite values`)
      }
      return { vector, model: response.model, dimensions: vector.length, profileFingerprint: this.profile.fingerprint }
    })
    recordAuxiliaryModelUsage({ kind: 'embedding', provider: this.profile.providerId,
      model: response.model, inputTokens: response.inputTokens ?? estimateTextsTokens(texts) })
    return results
  }
}

/** Probe through the same provider adapter used for real requests. */
export async function probeEmbeddingDimensions(config: EmbeddingConfig, signal?: AbortSignal): Promise<number> {
  const { connection } = resolveConnection(config)
  const response = await createEmbeddingAdapter(connection).embed(['test'], config.model?.trim() || DEFAULT_MODEL, undefined, signal)
  const vector = response.vectors[0]
  if (!vector?.length) throw new Error('Embedding response did not include vector values')
  return vector.length
}

let activeService: EmbeddingService | null = null
let unavailableReason: string | null = null

export function getEmbeddingService(): EmbeddingService {
  if (!activeService) throw new Error(unavailableReason || 'Configure an embedding provider before indexing or searching memory')
  return activeService
}

export function getEmbeddingConfig(): EmbeddingConfig {
  if (activeService) return activeService.getConfig()
  const saved = getStoredEmbeddingConfig()
  return { providerId: saved.providerId, baseUrl: saved.baseUrl,
    model: saved.model || DEFAULT_MODEL, dimensions: saved.dimensions || DEFAULT_DIMENSIONS }
}

export function getStoredEmbeddingConfig(): EmbeddingConfig {
  const row = getDb().prepare("SELECT value_json FROM settings WHERE key = 'embedding'").get() as { value_json: string } | undefined
  return row ? JSON.parse(row.value_json) as EmbeddingConfig : {}
}

export function setEmbeddingService(config: EmbeddingConfig, persist = true): EmbeddingService {
  const next = new EmbeddingService(config)
  if (persist) getDb().prepare("INSERT INTO settings (key, value_json) VALUES ('embedding', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(JSON.stringify(config))
  activeService = next
  unavailableReason = null
  getEventBus().emit('embedding:configured')
  return next
}

export function loadEmbeddingServiceFromDb(): void {
  const config = getStoredEmbeddingConfig()
  try {
    activeService = config.providerId || config.baseUrl || config.apiKey ? new EmbeddingService(config) : null
    unavailableReason = null
  } catch (error) {
    activeService = null
    unavailableReason = error instanceof Error ? error.message : String(error)
    console.warn('[Embedding] Saved configuration is unavailable:', unavailableReason)
  }
  getEventBus().emit('embedding:configured')
}
