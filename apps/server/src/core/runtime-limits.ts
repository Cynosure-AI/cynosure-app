/**
 * Canonical runtime policy shared by the server and web client.
 *
 * The server imports this module directly for enforcement. The web build points
 * its @shared/runtime-limits alias at this same source file, so there is no
 * duplicate browser fallback or independently maintained contract.
 */
/** Document chunking policy. Change these constants to tune all new indexing. */
export const MEMORY_CHUNK_SIZE_TOKENS: number = 512
export const MEMORY_CHUNK_OVERLAP_TOKENS: number = 64

/** Hybrid-search candidates sent to the reranker when reranking is enabled. */
export const RERANKER_CANDIDATE_COUNT: number = 50

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

export interface RuntimeLimits {
  readonly attachments: typeof ATTACHMENT_TEXT_LIMITS
  readonly chunkReadLimit: number
}

export const RUNTIME_LIMITS: RuntimeLimits = {
  attachments: ATTACHMENT_TEXT_LIMITS,
  chunkReadLimit: MAX_CHUNK_READ,
}
