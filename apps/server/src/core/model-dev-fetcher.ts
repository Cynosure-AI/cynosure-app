/**
 * Pricing cache – fetches model pricing from models.dev and provides lookups.
 * Costs in the API are $ per 1 M tokens.
 */

export interface ModelCost {
    input: number   // $ per 1M input tokens
    output: number  // $ per 1M output tokens
    cacheRead?: number
    cacheWrite?: number
    reasoning?: number
    inputAudio?: number
    outputAudio?: number
    tiers?: ModelCostTier[]
}

export interface ModelCostTier {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
    minInputTokens?: number
}

export interface ModelMetadata {
    cost?: ModelCost
    contextLength?: number
    inputModalities?: string[]
    outputModalities?: string[]
    supportsToolCalls?: boolean
}

interface ModelsDevProvider {
    id: string
    models: Record<string, {
        cost?: {
            input?: number
            output?: number
            cache_read?: number
            cache_write?: number
            reasoning?: number
            input_audio?: number
            output_audio?: number
            tiers?: Array<{
                input?: number
                output?: number
                cache_read?: number
                cache_write?: number
                tier?: { type?: string; size?: number }
            }>
        }
        limit?: { context?: number }
        modalities?: { input?: string[]; output?: string[] }
        tool_call?: boolean
    }>
}

type ModelsDevData = Record<string, ModelsDevProvider>

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const API_URL = 'https://models.dev/api.json'

/**
 * Mapping our internal provider types / IDs → models.dev provider keys.
 * Users may name their providers arbitrarily, so we normalise common patterns.
 */
const PROVIDER_ALIASES: Record<string, string> = {
    gemini: 'google',
    'google-genai': 'google',
    grok: 'xai',
    'x-ai': 'xai',
    deepseek: 'deepseek',
}

// ── Cache state ─────────────────────────────────────────────────────────────

/** Normalized metadata indexes shared by selectors, model info and usage metering. */
let exactLookup: Map<string, ModelMetadata> = new Map()
let modelOnlyLookup: Map<string, ModelMetadata> = new Map()

let lastFetchedAt = 0
let fetchPromise: Promise<void> | null = null

// ── Public API ──────────────────────────────────────────────────────────────

export async function ensurePricingLoaded(): Promise<void> {
    if (Date.now() - lastFetchedAt < CACHE_TTL_MS && exactLookup.size > 0) return
    if (fetchPromise) return fetchPromise // coalesce concurrent calls
    fetchPromise = fetchPricing()
    await fetchPromise
    fetchPromise = null
}

export function getModelCost(provider: string, model: string): ModelCost | null {
    return getModelMetadata(provider, model)?.cost ?? null
}

export function getModelOutputModalities(provider: string, model: string): string[] | null {
    return getModelMetadata(provider, model)?.outputModalities ?? null
}

export function getModelMetadata(provider: string, model: string): ModelMetadata | null {
    const normProvider = normaliseProvider(provider)

    // Prefer provider-specific data. Pricing can differ across hosts even when
    // they expose the same model id.
    const exact = exactLookup.get(`${normProvider}/${model}`)
    if (exact) return exact

    // OpenRouter-style IDs embed the upstream provider in the model id.
    const slashIdx = model.indexOf('/')
    if (slashIdx > 0) {
        const embeddedProvider = normaliseProvider(model.slice(0, slashIdx))
        const embeddedModel = model.slice(slashIdx + 1)
        const nested = exactLookup.get(`${embeddedProvider}/${embeddedModel}`)
        if (nested) return nested
        const nestedFallback = modelOnlyLookup.get(embeddedModel)
        if (nestedFallback) return nestedFallback
    }

    // Never attach a hosted provider's price to a locally-served model that
    // happens to share its id.
    if (normProvider === 'ollama' || normProvider === 'lmstudio' || normProvider === 'unsloth') return null

    const fallback = modelOnlyLookup.get(model)
    if (fallback) return fallback

    return null
}

export function modelSupportsOutputModality(provider: string, model: string, modality: string): boolean | null {
    const modalities = getModelOutputModalities(provider, model)
    if (!modalities) return null
    const wanted = modality.toLowerCase()
    return modalities.some((item) => item.toLowerCase() === wanted)
}

// ── Internals ───────────────────────────────────────────────────────────────

function normaliseProvider(raw: string): string {
    const lower = raw.toLowerCase().trim()
    return PROVIDER_ALIASES[lower] ?? lower
}

async function fetchPricing(): Promise<void> {
    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 15_000)

        const res = await fetch(API_URL, { signal: controller.signal })
        clearTimeout(timeout)

        if (!res.ok) {
            console.warn(`[pricing] Failed to fetch models.dev: ${res.status}`)
            return
        }

        const data = (await res.json()) as ModelsDevData
        buildLookups(data)
        lastFetchedAt = Date.now()
        console.log(`[pricing] Loaded pricing for ${exactLookup.size} provider/model combos`)
    } catch (err) {
        console.warn('[pricing] Error fetching models.dev pricing:', err instanceof Error ? err.message : err)
    }
}

function buildLookups(data: ModelsDevData): void {
    const newExact = new Map<string, ModelMetadata>()
    const newModelOnly = new Map<string, ModelMetadata>()
    const ambiguousModelIds = new Set<string>()

    for (const [providerKey, provider] of Object.entries(data)) {
        if (!provider?.models || typeof provider.models !== 'object') continue

        for (const [modelId, modelInfo] of Object.entries(provider.models)) {
            const metadata: ModelMetadata = {}
            const cost = modelInfo?.cost
            if (cost && typeof cost.input === 'number' && typeof cost.output === 'number') {
                const tiers = normalizeCostTiers(cost.tiers)
                metadata.cost = {
                    input: cost.input,
                    output: cost.output,
                    ...(numeric(cost.cache_read) != null ? { cacheRead: numeric(cost.cache_read) } : {}),
                    ...(numeric(cost.cache_write) != null ? { cacheWrite: numeric(cost.cache_write) } : {}),
                    ...(numeric(cost.reasoning) != null ? { reasoning: numeric(cost.reasoning) } : {}),
                    ...(numeric(cost.input_audio) != null ? { inputAudio: numeric(cost.input_audio) } : {}),
                    ...(numeric(cost.output_audio) != null ? { outputAudio: numeric(cost.output_audio) } : {}),
                    ...(tiers.length ? { tiers } : {}),
                }
            }

            const ctxLen = modelInfo?.limit?.context
            if (typeof ctxLen === 'number' && ctxLen > 0) {
                metadata.contextLength = ctxLen
            }

            metadata.inputModalities = normalizeModalities(modelInfo?.modalities?.input)
            metadata.outputModalities = normalizeModalities(modelInfo?.modalities?.output)
            if (typeof modelInfo?.tool_call === 'boolean') {
                metadata.supportsToolCalls = modelInfo.tool_call
            }

            if (!Object.keys(metadata).length) continue
            const normalizedProvider = normaliseProvider(providerKey)
            newExact.set(`${normalizedProvider}/${modelId}`, metadata)
            // A bare model id is only safe as a fallback when it occurs once in
            // the catalog. The same model can have materially different prices
            // and limits across hosts, so "first provider wins" is unsafe.
            if (ambiguousModelIds.has(modelId)) continue
            if (newModelOnly.has(modelId)) {
                newModelOnly.delete(modelId)
                ambiguousModelIds.add(modelId)
            } else {
                newModelOnly.set(modelId, metadata)
            }
        }
    }

    exactLookup = newExact
    modelOnlyLookup = newModelOnly
}

function normalizeCostTiers(raw: unknown): ModelCostTier[] {
    if (!Array.isArray(raw)) return []
    return raw.flatMap((item): ModelCostTier[] => {
        if (!item || typeof item !== 'object') return []
        const tier = item as {
            input?: unknown
            output?: unknown
            cache_read?: unknown
            cache_write?: unknown
            tier?: { type?: unknown; size?: unknown }
        }
        const input = numeric(tier.input)
        const output = numeric(tier.output)
        if (input == null || output == null) return []
        const minInputTokens = tier.tier?.type === 'context' ? numeric(tier.tier.size) : undefined
        return [{
            input,
            output,
            ...(numeric(tier.cache_read) != null ? { cacheRead: numeric(tier.cache_read) } : {}),
            ...(numeric(tier.cache_write) != null ? { cacheWrite: numeric(tier.cache_write) } : {}),
            ...(minInputTokens != null ? { minInputTokens } : {})
        }]
    }).sort((a, b) => (a.minInputTokens ?? 0) - (b.minInputTokens ?? 0))
}

function normalizeModalities(raw: unknown): string[] | undefined {
    if (!Array.isArray(raw)) return undefined
    const modalities = raw
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.toLowerCase())
    return modalities.length ? modalities : undefined
}

function numeric(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
