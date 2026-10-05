import type { MemoryRetrievalOptions } from '../../core/memory/retrieval-options.js'

export type EvalCaseType = 'single' | 'paraphrase' | 'crosslang' | 'multi' | 'overview' | 'aggregation' | 'temporal' | 'disambiguation' | 'noanswer' | 'real' | 'real-noanswer'

/** Evidence that answers a case. Matched by quote (survives re-chunking); the
 * file narrows short quotes that could occur in several documents. */
export interface EvalGold {
  file: string
  quote?: string
}

export interface EvalCase {
  id: string
  type: EvalCaseType
  /** Variants generated from the same fact share a group. */
  group: string
  query: string
  recentMessages?: Array<{ role: 'user' | 'assistant'; content: string }>
  answer?: string
  /** Doc/quote evidence; empty for no-answer cases. */
  gold: EvalGold[]
  /** 'all' = every gold item is needed (multi-hop); 'any' = one suffices. */
  goldMode: 'any' | 'all'
  folderIds?: string[]
  language?: string
  /** Folder the source chunk came from, for per-folder breakdowns. */
  folder?: string
  review?: { verdict: 'ok' | 'fix' | 'bad'; note?: string; at: number }
  createdAt: number
}

export interface EvalDataset {
  version: 1
  cases: EvalCase[]
}

export interface EvalCondition {
  name: string
  /** Reranker selection instead of LLM curation (uses the saved reranker config). */
  reranker: boolean
  /** Run the task-context planner first, as production does: query expansions,
   * key terms, and its decision that memory is not needed. */
  planner?: boolean
  /** Retrieval option overrides written into the snapshot (see retrieval-options.ts). */
  options?: Partial<MemoryRetrievalOptions>
}

export interface EvalChunk {
  file?: string
  folder?: string
  chunkIndex?: number
  text: string
  /** Pipeline match score in [0, 1] and its source (reranker, dense, ...). */
  score?: number
  scoreType?: string
}

export interface CaseRunResult {
  caseId: string
  condition: string
  ms: number
  /** Final candidate pool shown to curation, in rank order. */
  candidates: EvalChunk[]
  selected: EvalChunk[]
  selectionMethod?: string
  correctiveRetry: boolean
  injected: string
  error?: string
}

export interface CaseScore {
  caseId: string
  condition: string
  type: EvalCaseType
  folder?: string
  ms: number
  /** 1-based rank of the first gold candidate; 0 = not retrieved. */
  firstGoldRank: number
  retrievedAll: boolean
  selectedAll: boolean
  ndcg: number
  /** Judge: does the injected context support the reference answer? */
  support?: 'full' | 'partial' | 'none'
  /** No-answer cases: anything injected / injected context claims an answer. */
  injected: boolean
  misleading?: boolean
  selectedCount: number
  /** Highest score among selected chunks (what an absolute floor would test). */
  topSelectedScore?: number
  /** Score of the best selected chunk carrying gold evidence. */
  goldSelectedScore?: number
  scoreType?: string
  fallback: boolean
  correctiveRetry: boolean
  error?: string
}

export interface EvalRun {
  id: string
  label?: string
  /** 'personal' (live memory) or 'fixture' (committed corpus); missing = personal. */
  dataset?: string
  startedAt: number
  finishedAt: number
  gitCommit?: string
  curator: { providerId?: string; model?: string }
  judge: { providerId?: string; model?: string }
  conditions: EvalCondition[]
  datasetSize: number
  scores: CaseScore[]
  /** rerankUsd is estimated from request counts (rerank APIs bill per search). */
  cost: { curatorUsd: number; judgeUsd: number; rerankRequests?: number; rerankUsd?: number }
}
