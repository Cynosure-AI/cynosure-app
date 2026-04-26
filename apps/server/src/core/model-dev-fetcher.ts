/**
 * Pricing cache – fetches model pricing from models.dev and provides lookups.
 * Costs in the API are $ per 1 M tokens.
 */

interface ModelCost {
    input: number   // $ per 1M input tokens
    output: number  // $ per 1M output tokens
}

interface ModelsDevProvider {
    id: string
    models: Record<string, {
        cost?: { input?: number; output?: number }
        limit?: { context?: number }
        modalities?: { input?: string[]; output?: string[] }
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

/** (provider, model) → cost  (provider normalised to models.dev key) */
let exactLookup: Map<string, ModelCost> = new Map()

/** model → cost  (first-seen cost for a model across all providers) */
let modelOnlyLookup: Map<string, ModelCost> = new Map()

/** (provider, model) → context length */
let contextExactLookup: Map<string, number> = new Map()

/** model → context length (first-seen across all providers) */
let contextModelOnlyLookup: Map<string, number> = new Map()

/** (provider, model) → output modalities */
let outputModalitiesExactLookup: Map<string, string[]> = new Map()

/** model → output modalities (first-seen across all providers) */
let outputModalitiesModelOnlyLookup: Map<string, string[]> = new Map()

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
    const normProvider = normaliseProvider(provider)

    // 1. Exact match: provider + model
    const exact = exactLookup.get(`${normProvider}/${model}`)
    if (exact) return exact

    // 2. Model-only fallback (cross-provider)
    const fallback = modelOnlyLookup.get(model)
    if (fallback) return fallback

    // 3. OpenRouter-style IDs: "anthropic/claude-3.5-sonnet" → try "anthropic" + "claude-3.5-sonnet"
    const slashIdx = model.indexOf('/')
    if (slashIdx > 0) {
        const embeddedProvider = normaliseProvider(model.slice(0, slashIdx))
        const embeddedModel = model.slice(slashIdx + 1)
        const nested = exactLookup.get(`${embeddedProvider}/${embeddedModel}`)
        if (nested) return nested
        const nestedFallback = modelOnlyLookup.get(embeddedModel)
        if (nestedFallback) return nestedFallback
    }

    return null
}

export function getModelContextLength(provider: string, model: string): number | null {
    const normProvider = normaliseProvider(provider)

    const exact = contextExactLookup.get(`${normProvider}/${model}`)
    if (exact) return exact

    const fallback = contextModelOnlyLookup.get(model)
    if (fallback) return fallback

    // OpenRouter-style IDs: "anthropic/claude-3.5-sonnet" → try "anthropic" + "claude-3.5-sonnet"
    const slashIdx = model.indexOf('/')
    if (slashIdx > 0) {
        const embeddedProvider = normaliseProvider(model.slice(0, slashIdx))
        const embeddedModel = model.slice(slashIdx + 1)
        const nested = contextExactLookup.get(`${embeddedProvider}/${embeddedModel}`)
        if (nested) return nested
        const nestedFallback = contextModelOnlyLookup.get(embeddedModel)
        if (nestedFallback) return nestedFallback
    }

    return null
}

export function getModelOutputModalities(provider: string, model: string): string[] | null {
    const normProvider = normaliseProvider(provider)

    const exact = outputModalitiesExactLookup.get(`${normProvider}/${model}`)
    if (exact) return exact

    const fallback = outputModalitiesModelOnlyLookup.get(model)
    if (fallback) return fallback

    // OpenRouter-style IDs: "openai/gpt-5-image" → try "openai" + "gpt-5-image"
    const slashIdx = model.indexOf('/')
    if (slashIdx > 0) {
        const embeddedProvider = normaliseProvider(model.slice(0, slashIdx))
        const embeddedModel = model.slice(slashIdx + 1)
        const nested = outputModalitiesExactLookup.get(`${embeddedProvider}/${embeddedModel}`)
        if (nested) return nested
        const nestedFallback = outputModalitiesModelOnlyLookup.get(embeddedModel)
        if (nestedFallback) return nestedFallback
    }

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
    const newExact = new Map<string, ModelCost>()
    const newModelOnly = new Map<string, ModelCost>()
    const newCtxExact = new Map<string, number>()
    const newCtxModelOnly = new Map<string, number>()
    const newOutputModalitiesExact = new Map<string, string[]>()
    const newOutputModalitiesModelOnly = new Map<string, string[]>()

    for (const [providerKey, provider] of Object.entries(data)) {
        if (!provider?.models || typeof provider.models !== 'object') continue

        for (const [modelId, modelInfo] of Object.entries(provider.models)) {
            // Cost lookup
            const cost = modelInfo?.cost
            if (cost && typeof cost.input === 'number' && typeof cost.output === 'number') {
                if (cost.input !== 0 || cost.output !== 0) {
                    const entry: ModelCost = { input: cost.input, output: cost.output }
                    newExact.set(`${providerKey}/${modelId}`, entry)
                    if (!newModelOnly.has(modelId)) {
                        newModelOnly.set(modelId, entry)
                    }
                }
            }

            // Context length lookup
            const ctxLen = modelInfo?.limit?.context
            if (typeof ctxLen === 'number' && ctxLen > 0) {
                newCtxExact.set(`${providerKey}/${modelId}`, ctxLen)
                if (!newCtxModelOnly.has(modelId)) {
                    newCtxModelOnly.set(modelId, ctxLen)
                }
            }

            // Output modality lookup
            const outputModalities = modelInfo?.modalities?.output
            if (Array.isArray(outputModalities)) {
                const modalities = outputModalities
                    .filter((item): item is string => typeof item === 'string')
                    .map((item) => item.toLowerCase())
                if (modalities.length) {
                    newOutputModalitiesExact.set(`${providerKey}/${modelId}`, modalities)
                    if (!newOutputModalitiesModelOnly.has(modelId)) {
                        newOutputModalitiesModelOnly.set(modelId, modalities)
                    }
                }
            }
        }
    }

    exactLookup = newExact
    modelOnlyLookup = newModelOnly
    contextExactLookup = newCtxExact
    contextModelOnlyLookup = newCtxModelOnly
    outputModalitiesExactLookup = newOutputModalitiesExact
    outputModalitiesModelOnlyLookup = newOutputModalitiesModelOnly
}
