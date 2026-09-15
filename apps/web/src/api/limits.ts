import { ref } from 'vue'
import { api } from './client'
import type { RuntimeLimits } from './types'

/**
 * Server-authoritative cross-boundary limits.
 *
 * The server owns every bound that is enforced server-side (see
 * `apps/server/src/core/runtime-limits.ts`). The client fetches them once and
 * renders the served values, so a server-side change can never leave the UI
 * offering an action the server will reject — which is exactly what happened
 * when `MAX_ANALYSIS_CHUNKS` and `MAX_DEEP_RESEARCH_CHUNKS` were maintained as
 * two independent literals.
 *
 * The fallback below only covers the window before the first fetch resolves.
 * It mirrors the server defaults and must never become the value the UI relies
 * on: prefer `limits.value` and check `limitsLoaded` when the distinction
 * matters.
 */
const FALLBACK_LIMITS: RuntimeLimits = {
    analysisChunkLimit: 20,
    chunking: { minChunkSize: 64, maxChunkSize: 4096, defaultChunkSize: 512, defaultChunkOverlap: 64 },
    reranker: { minCandidateCount: 3, maxCandidateCount: 100, defaultCandidateCount: 50 },
    attachments: { minInlineTextLimit: 2_000, maxInlineTextLimit: 500_000, defaultInlineTextLimit: 24_000 },
    chunkReadLimit: 20,
    graph: {
        maxNodes: 5000,
        defaultNodes: 80,
        maxSuggestions: 20,
        defaultSuggestions: 8,
        maxSeedNodes: 50,
        maxCategories: 100,
    },
}

const limits = ref<RuntimeLimits>(FALLBACK_LIMITS)
const limitsLoaded = ref(false)
let inFlight: Promise<RuntimeLimits> | null = null

/** Fetch the limits once per page load and share the result everywhere. */
export function loadRuntimeLimits(): Promise<RuntimeLimits> {
    if (limitsLoaded.value) return Promise.resolve(limits.value)
    inFlight ??= Promise.resolve()
        .then(() => api.memory.getLimits())
        .then((served) => {
            limits.value = served
            limitsLoaded.value = true
            return served
        })
        .catch(() => {
            // Keep the fallback so the UI stays usable if the server is
            // unreachable or a partial API mock omits getLimits.
            console.error('Failed to load runtime limits; using fallback values.')
            return limits.value
        })
        .finally(() => {
            inFlight = null
        })
    return inFlight
}

/**
 * Reactive limits. Triggers a one-time load on first access so components can
 * use the values directly without awaiting.
 */
export function useRuntimeLimits() {
    void loadRuntimeLimits()
    return { limits, limitsLoaded }
}
