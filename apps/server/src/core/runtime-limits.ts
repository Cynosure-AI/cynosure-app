/**
 * Canonical runtime policy shared by the server and web client.
 *
 * The server imports this module directly for enforcement. The web build points
 * its @shared/runtime-limits alias at this same source file, so there is no
 * duplicate browser fallback or independently maintained contract.
 */
export const MAX_ANALYSIS_CHUNKS = 20

export const CHUNKING_LIMITS = {
  minChunkSize: 64,
  maxChunkSize: 4096,
  defaultChunkSize: 512,
  defaultChunkOverlap: 64,
} as const

export const RERANKER_LIMITS = {
  minCandidateCount: 3,
  maxCandidateCount: 100,
  defaultCandidateCount: 50,
} as const

export const ATTACHMENT_TEXT_LIMITS = {
  minInlineTextLimit: 2_000,
  maxInlineTextLimit: 500_000,
  defaultInlineTextLimit: 24_000,
} as const

export const MAX_CHUNK_READ = 20

export const GRAPH_LIMITS = {
  maxNodes: 5000,
  defaultNodes: 80,
  maxSuggestions: 20,
  defaultSuggestions: 8,
  maxSeedNodes: 50,
  maxCategories: 100,
} as const

export const RUNTIME_LIMITS = {
  analysisChunkLimit: MAX_ANALYSIS_CHUNKS,
  chunking: CHUNKING_LIMITS,
  reranker: RERANKER_LIMITS,
  attachments: ATTACHMENT_TEXT_LIMITS,
  chunkReadLimit: MAX_CHUNK_READ,
  graph: GRAPH_LIMITS,
} as const

// Backwards-compatible API name for GET /api/memory/limits.
export const MEMORY_LIMITS = RUNTIME_LIMITS
export type RuntimeLimits = typeof RUNTIME_LIMITS
