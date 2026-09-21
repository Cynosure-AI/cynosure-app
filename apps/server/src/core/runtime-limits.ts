/**
 * Canonical runtime policy shared by the server and web client.
 *
 * The server imports this module directly for enforcement. The web build points
 * its @shared/runtime-limits alias at this same source file, so there is no
 * duplicate browser fallback or independently maintained contract.
 */
export const MAX_ANALYSIS_CHUNKS: number = 20

/** Document chunking policy. Change these constants to tune all new indexing. */
export const MEMORY_CHUNK_SIZE_TOKENS: number = 512
export const MEMORY_CHUNK_OVERLAP_TOKENS: number = 64

export const RERANKER_LIMITS: Readonly<{
  minCandidateCount: number
  maxCandidateCount: number
  defaultCandidateCount: number
}> = {
  minCandidateCount: 3,
  maxCandidateCount: 100,
  defaultCandidateCount: 50,
}

export const ATTACHMENT_TEXT_LIMITS: Readonly<{
  minInlineTextLimit: number
  maxInlineTextLimit: number
  defaultInlineTextLimit: number
}> = {
  minInlineTextLimit: 2_000,
  maxInlineTextLimit: 500_000,
  defaultInlineTextLimit: 24_000,
}

export const MAX_CHUNK_READ: number = 20

/** Manual selections at or below this size are sent directly to the model. */
export const DIRECT_TOOL_SELECTION_LIMIT: number = 50

export const GRAPH_LIMITS: Readonly<{
  maxNodes: number
  defaultNodes: number
  maxSuggestions: number
  defaultSuggestions: number
  maxSeedNodes: number
  maxFolders: number
}> = {
  maxNodes: 5000,
  defaultNodes: 80,
  maxSuggestions: 20,
  defaultSuggestions: 8,
  maxSeedNodes: 50,
  maxFolders: 100,
}

export interface RuntimeLimits {
  readonly analysisChunkLimit: number
  readonly reranker: typeof RERANKER_LIMITS
  readonly attachments: typeof ATTACHMENT_TEXT_LIMITS
  readonly chunkReadLimit: number
  readonly graph: typeof GRAPH_LIMITS
}

export const RUNTIME_LIMITS: RuntimeLimits = {
  analysisChunkLimit: MAX_ANALYSIS_CHUNKS,
  reranker: RERANKER_LIMITS,
  attachments: ATTACHMENT_TEXT_LIMITS,
  chunkReadLimit: MAX_CHUNK_READ,
  graph: GRAPH_LIMITS,
}

// Backwards-compatible API name for GET /api/memory/limits.
export const MEMORY_LIMITS = RUNTIME_LIMITS
