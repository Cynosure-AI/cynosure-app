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
    models: Record<string, { cost?: { input?: number; output?: number } }>
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

    return null
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

    for (const [providerKey, provider] of Object.entries(data)) {
        if (!provider?.models || typeof provider.models !== 'object') continue

        for (const [modelId, modelInfo] of Object.entries(provider.models)) {
            const cost = modelInfo?.cost
            if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') continue
            if (cost.input === 0 && cost.output === 0) continue // skip free / unknown

            const entry: ModelCost = { input: cost.input, output: cost.output }
            newExact.set(`${providerKey}/${modelId}`, entry)

            // Keep first seen per model name (typically the canonical provider)
            if (!newModelOnly.has(modelId)) {
                newModelOnly.set(modelId, entry)
            }
        }
    }

    exactLookup = newExact
    modelOnlyLookup = newModelOnly
}
