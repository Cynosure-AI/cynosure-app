/**
 * Canonical cross-boundary limits.
 *
 * Every value here is enforced by the server, rendered by the client, or both.
 * The web client reads them from `GET /api/memory/limits` (plus the per-file
 * `analysisLimit` field on memory file rows) instead of keeping its own copies,
 * so the two sides cannot drift apart.
 *
 * When adding a bound that both sides care about, define it here first and have
 * the client render the served value — never introduce a parallel literal.
 */

/**
 * Maximum number of canonical chunks a single memory document may contain for
 * Deep Research / analysis to be offered. Documents above this limit are
 * reported as `too_large` and rejected with HTTP 422 rather than silently
 * analysed in part.
 */
export const MAX_ANALYSIS_CHUNKS = 20

/** Bounds and defaults for the markdown-aware RAG chunk splitter. */
export const CHUNKING_LIMITS = {
    minChunkSize: 64,
    maxChunkSize: 4096,
    defaultChunkSize: 512,
    defaultChunkOverlap: 64,
} as const

/** Bounds and defaults for the optional external (OpenRouter) reranker. */
export const RERANKER_LIMITS = {
    minCandidateCount: 3,
    maxCandidateCount: 100,
    defaultCandidateCount: 50,
} as const

/** Bounds and default for how much attachment text is inlined into context. */
export const ATTACHMENT_TEXT_LIMITS = {
    minInlineTextLimit: 2_000,
    maxInlineTextLimit: 500_000,
    defaultInlineTextLimit: 24_000,
} as const

/**
 * Maximum number of chunks returned by a single ranged read. Shared by the
 * memory `memory_retrieve_chunks` tool and the conversation attachment
 * `attachment_read` tool so both surfaces cap identically.
 */
export const MAX_CHUNK_READ = 20

/** Bounds and defaults for knowledge-graph queries. */
export const GRAPH_LIMITS = {
    maxNodes: 5000,
    defaultNodes: 80,
    maxSuggestions: 20,
    defaultSuggestions: 8,
    maxSeedNodes: 50,
    maxCategories: 100,
} as const

/**
 * Single payload shape served by `GET /api/memory/limits`. Keep the browser
 * `RuntimeLimits` interface in `apps/web/src/api/limits.ts` in step with this.
 */
export const MEMORY_LIMITS = {
    analysisChunkLimit: MAX_ANALYSIS_CHUNKS,
    chunking: CHUNKING_LIMITS,
    reranker: RERANKER_LIMITS,
    attachments: ATTACHMENT_TEXT_LIMITS,
    chunkReadLimit: MAX_CHUNK_READ,
    graph: GRAPH_LIMITS,
} as const

export type MemoryLimits = typeof MEMORY_LIMITS
