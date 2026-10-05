import { getDb } from '../../db/database.js'
import { getEmbeddingService } from './embedding.js'
import { getActivePermanentMemoryTableName } from './memory-index-manifest.js'
import { getRAGStore } from './rag.js'

const DONE_SETTING = 'memoryLegacyAnalysisRemoved'
/** LanceDB table of the removed knowledge graph. */
const LEGACY_KNOWLEDGE_TABLE = 'memory_knowledge_v2'

/**
 * One-time cleanup after the knowledge graph and deep analysis were removed:
 * drop the graph's vector table and restore plain chunk search text in the
 * memory index. Re-embedding needs a configured embedding provider, so the
 * cleanup retries on a later start until it can complete.
 */
export async function removeLegacyMemoryAnalysis(signal?: AbortSignal): Promise<void> {
    const db = getDb()
    if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(DONE_SETTING)) return
    const rag = getRAGStore()
    await rag.deleteTable(LEGACY_KNOWLEDGE_TABLE)
    try {
        getEmbeddingService()
    } catch {
        return
    }
    const result = await rag.removeLegacyAnalysis(getActivePermanentMemoryTableName(), signal)
    db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)')
        .run(DONE_SETTING, JSON.stringify({ ...result, completedAt: Date.now() }))
    if (result.projectionsRemoved || result.chunksRestored) {
        console.info(`[memory] Removed ${result.projectionsRemoved} analysis projection rows and restored ${result.chunksRestored} chunks to plain search text`)
    }
}
