/** Options for automatic memory retrieval. */
export interface MemoryRetrievalOptions {
    /** Prefix queries with a retrieval instruction for instruction-tuned embedding models. */
    queryInstructions: boolean
    /** Show curation each candidate's document title, section and last change. */
    curatorDocumentContext: boolean
    /** Fused candidates the LLM curator sees. */
    curationPool: number
    /** Reranker relevance (0-1) a chunk needs to be injected without LLM curation. */
    minRerankerScore: number
}

export const DEFAULT_MEMORY_RETRIEVAL_OPTIONS: Readonly<MemoryRetrievalOptions> = {
    queryInstructions: true,
    curatorDocumentContext: true,
    curationPool: 20,
    minRerankerScore: 0.1,
}

export function getMemoryRetrievalOptions(): MemoryRetrievalOptions {
    return { ...DEFAULT_MEMORY_RETRIEVAL_OPTIONS }
}
