import { getDb } from '../../db/database.js'
import { getEmbeddingProvider } from './embedding.js'
import { formatKnowledgeLiteral } from './memory-knowledge-format.js'
import { getRAGStore, type VectorDocument } from './rag.js'

export class MemoryKnowledgeProjectionStore {
  constructor(private readonly tableName: string) { }

  async indexRun(runId: string, signal?: AbortSignal): Promise<number> {
    const db = getDb()
    const run = db.prepare(`
      SELECT * FROM memory_knowledge_index_runs WHERE id = ? AND status = 'active'
    `).get(runId) as Record<string, unknown> | undefined
    if (!run) return 0

    try {
      const assertionRows = db.prepare(`
        SELECT DISTINCT a.id, a.object_value_json, p.canonical_name, p.aliases_json,
          se.canonical_name AS subject_name, se.description AS subject_description,
          oe.canonical_name AS object_name, oe.description AS object_description,
          COALESCE(c.evidence_text, ev.note) AS note, tu.text AS source_text,
          tu.document_title, tu.section_path
        FROM memory_knowledge_assertion_evidence ev
        JOIN memory_knowledge_assertions a ON a.id = ev.assertion_id
        JOIN memory_knowledge_predicates p ON p.id = a.predicate_id
        JOIN memory_knowledge_entities se ON se.id = a.subject_entity_id
        LEFT JOIN memory_knowledge_entities oe ON oe.id = a.object_entity_id
        JOIN memory_knowledge_text_units tu ON tu.id = ev.text_unit_id
        LEFT JOIN memory_knowledge_assertion_corrections c ON c.id = (
          SELECT correction.id FROM memory_knowledge_assertion_corrections correction
          WHERE correction.assertion_id = a.id ORDER BY correction.created_at DESC LIMIT 1
        )
        WHERE ev.run_id = ? AND a.status IN ('active', 'disputed') AND ev.quote_verified = 1
      `).all(runId) as Array<Record<string, unknown>>
      const entityRows = db.prepare(`
        SELECT DISTINCT e.id, e.canonical_name, e.entity_type, e.identity_hint, e.description,
          GROUP_CONCAT(DISTINCT a.display_alias) AS aliases,
          GROUP_CONCAT(DISTINCT NULLIF(m.note, '')) AS notes
        FROM memory_knowledge_entity_mentions m
        JOIN memory_knowledge_entities e ON e.id = m.entity_id
        LEFT JOIN memory_knowledge_entity_aliases a ON a.entity_id = e.id
        WHERE m.run_id = ? AND e.status = 'active'
        GROUP BY e.id
      `).all(runId) as Array<Record<string, unknown>>
      const projections = [
        ...assertionRows.map((row) => ({
          id: `knowledge-assertion:${row.id}`,
          source: 'knowledge_assertion',
          sourceFile: `assertion:${row.id}`,
          text: `${row.subject_name} ${String(row.canonical_name).replace(/_/g, ' ')} ${row.object_name || formatKnowledgeLiteral(row.object_value_json)}`,
          searchText: [
            row.document_title ? `Document: ${row.document_title}` : '',
            row.section_path ? `Section: ${row.section_path}` : '',
            `${row.subject_name} ${String(row.canonical_name).replace(/_/g, ' ')} ${row.object_name || formatKnowledgeLiteral(row.object_value_json)}`,
            `Predicate aliases: ${(JSON.parse(String(row.aliases_json || '[]')) as string[]).join(', ')}`,
            row.subject_description, row.object_description,
            row.note ? `Note: ${row.note}` : '',
            `Source chunk: ${row.source_text}`,
          ].filter(Boolean).join('\n'),
        })),
        ...entityRows.map((row) => ({
          id: `knowledge-entity:${row.id}`,
          source: 'knowledge_entity',
          sourceFile: `entity:${row.id}`,
          text: `${row.canonical_name} (${row.entity_type})`,
          searchText: [row.canonical_name, row.aliases, row.entity_type, row.identity_hint, row.description, row.notes].filter(Boolean).join('\n'),
        })),
      ]
      if (!projections.length) {
        db.prepare(`UPDATE memory_knowledge_index_runs SET search_projection_status = 'ready', search_projection_error = NULL WHERE id = ?`).run(runId)
        return 0
      }
      throwIfAborted(signal)
      const embeddings = await getEmbeddingProvider().embedBatch(projections.map((projection) => projection.searchText))
      throwIfAborted(signal)
      const documents: VectorDocument[] = projections.map((projection, index) => ({
        ...projection,
        vector: embeddings[index].vector,
        chunkIndex: 0,
        categoryId: String(run.category_id),
        createdAt: Date.now(),
        documentTitle: String(run.file_name),
        sectionPath: projection.source === 'knowledge_assertion' ? 'Knowledge assertions' : 'Entities',
        contentHash: String(run.content_hash),
        embeddingModel: embeddings[index].model,
        // Knowledge projections are their own authoritative rows rather than a
        // search-only view of an indexed source chunk, so they are marked as
        // raw. These fields must be present: LanceDB rejects an append when a
        // table column is omitted from the incoming batch.
        representationType: 'raw',
        sourceChunkId: projection.id,
      }))
      const rag = getRAGStore()
      // addDocuments invalidates FTS and schedules one debounced rebuild. An
      // eager rebuild here would repeat work for every run during bulk edits.
      await rag.deleteByIds(this.tableName, documents.map((document) => document.id), {
        rebuildFts: false,
        throwOnError: false,
      })
      await rag.addDocuments(this.tableName, documents, embeddings[0].dimensions)
      db.prepare(`UPDATE memory_knowledge_index_runs SET search_projection_status = 'ready', search_projection_error = NULL WHERE id = ?`).run(runId)
      return documents.length
    } catch (error) {
      db.prepare(`UPDATE memory_knowledge_index_runs SET search_projection_status = 'error', search_projection_error = ? WHERE id = ?`)
        .run((error as Error | undefined)?.message || 'Knowledge projection failed', runId)
      throw error
    }
  }

  async reindexDocument(documentId: string): Promise<number> {
    const run = getDb().prepare(`
      SELECT id FROM memory_knowledge_index_runs
      WHERE document_id = ? AND status = 'active'
      ORDER BY activated_at DESC LIMIT 1
    `).get(documentId) as { id: string } | undefined
    return run ? this.indexRun(run.id) : 0
  }

  markAllPending(): void {
    getDb().prepare(`
      UPDATE memory_knowledge_index_runs
      SET search_projection_status = 'pending', search_projection_error = NULL
      WHERE status = 'active'
    `).run()
  }

  async reindexAll(signal?: AbortSignal): Promise<{ runs: number; documents: number }> {
    const runs = getDb().prepare(`
      SELECT id FROM memory_knowledge_index_runs WHERE status = 'active' ORDER BY activated_at
    `).all() as Array<{ id: string }>
    let documents = 0
    for (const run of runs) {
      throwIfAborted(signal)
      documents += await this.indexRun(run.id, signal)
    }
    return { runs: runs.length, documents }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' })
}
