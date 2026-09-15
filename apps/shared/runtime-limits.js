/**
 * Canonical runtime policy shared by the server and web client.
 *
 * Keep all cross-boundary bounds and defaults here. The server remains the
 * enforcement boundary; the web client imports the same immutable values.
 */
export const MAX_ANALYSIS_CHUNKS = 20

export const CHUNKING_LIMITS = Object.freeze({
  minChunkSize: 64,
  maxChunkSize: 4096,
  defaultChunkSize: 512,
  defaultChunkOverlap: 64,
})

export const RERANKER_LIMITS = Object.freeze({
  minCandidateCount: 3,
  maxCandidateCount: 100,
  defaultCandidateCount: 50,
})

export const ATTACHMENT_TEXT_LIMITS = Object.freeze({
  minInlineTextLimit: 2_000,
  maxInlineTextLimit: 500_000,
  defaultInlineTextLimit: 24_000,
})

export const MAX_CHUNK_READ = 20

export const GRAPH_LIMITS = Object.freeze({
  maxNodes: 5000,
  defaultNodes: 80,
  maxSuggestions: 20,
  defaultSuggestions: 8,
  maxSeedNodes: 50,
  maxCategories: 100,
})

export const RUNTIME_LIMITS = Object.freeze({
  analysisChunkLimit: MAX_ANALYSIS_CHUNKS,
  chunking: CHUNKING_LIMITS,
  reranker: RERANKER_LIMITS,
  attachments: ATTACHMENT_TEXT_LIMITS,
  chunkReadLimit: MAX_CHUNK_READ,
  graph: GRAPH_LIMITS,
})

// Backwards-compatible API name for GET /api/memory/limits.
export const MEMORY_LIMITS = RUNTIME_LIMITS
