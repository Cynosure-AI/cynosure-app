export declare const MAX_ANALYSIS_CHUNKS: number

export declare const CHUNKING_LIMITS: Readonly<{
  minChunkSize: number
  maxChunkSize: number
  defaultChunkSize: number
  defaultChunkOverlap: number
}>

export declare const RERANKER_LIMITS: Readonly<{
  minCandidateCount: number
  maxCandidateCount: number
  defaultCandidateCount: number
}>

export declare const ATTACHMENT_TEXT_LIMITS: Readonly<{
  minInlineTextLimit: number
  maxInlineTextLimit: number
  defaultInlineTextLimit: number
}>

export declare const MAX_CHUNK_READ: number

export declare const GRAPH_LIMITS: Readonly<{
  maxNodes: number
  defaultNodes: number
  maxSuggestions: number
  defaultSuggestions: number
  maxSeedNodes: number
  maxCategories: number
}>

export declare const RUNTIME_LIMITS: Readonly<{
  analysisChunkLimit: number
  chunking: typeof CHUNKING_LIMITS
  reranker: typeof RERANKER_LIMITS
  attachments: typeof ATTACHMENT_TEXT_LIMITS
  chunkReadLimit: number
  graph: typeof GRAPH_LIMITS
}>

export declare const MEMORY_LIMITS: typeof RUNTIME_LIMITS
export type RuntimeLimits = typeof RUNTIME_LIMITS
