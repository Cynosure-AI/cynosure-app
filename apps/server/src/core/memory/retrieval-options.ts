import { getDb } from '../../db/database.js'

/**
 * Tunable parts of automatic memory retrieval. The defaults are what ships;
 * `memory:eval` writes {@link OVERRIDE_SETTING} into its data-dir snapshots to
 * compare variants, so every default here is backed by a measured run.
 */
export interface MemoryRetrievalOptions {
    /** Prefix queries with a retrieval instruction for instruction-tuned embedding models. */
    queryInstructions: boolean
    /** Show curation each candidate's document title, section and last change. */
    curatorDocumentContext: boolean
    /** Fused candidates the LLM curator sees. */
    curationPool: number
}

// memory:eval 2026-10-02 (personal memory, LLM curation, planner on; vs. all off and pool 12):
// pool 20 +12/-4, query instructions +9/-6 and fewer no-answer injections,
// document context +6/-3. Planner keywords were neutral and injected more on
// no-answer questions, so they were removed. A document-title channel hurt
// first-place hits on both datasets and was removed.
export const DEFAULT_MEMORY_RETRIEVAL_OPTIONS: Readonly<MemoryRetrievalOptions> = {
    queryInstructions: true,
    curatorDocumentContext: true,
    curationPool: 20,
}

/** Settings key for evaluation overrides; absent in normal installs. */
export const OVERRIDE_SETTING = 'memoryRetrievalOverrides'

export function getMemoryRetrievalOptions(): MemoryRetrievalOptions {
    try {
        const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?').get(OVERRIDE_SETTING) as { value_json: string } | undefined
        if (!row) return { ...DEFAULT_MEMORY_RETRIEVAL_OPTIONS }
        return { ...DEFAULT_MEMORY_RETRIEVAL_OPTIONS, ...(JSON.parse(row.value_json) as Partial<MemoryRetrievalOptions>) }
    } catch {
        return { ...DEFAULT_MEMORY_RETRIEVAL_OPTIONS }
    }
}
