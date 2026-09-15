import { getDb } from '../../db/database.js'
import type { KnowledgeAssertion, KnowledgeEntity, KnowledgeEvidence, KnowledgeGraphProjection, ImportanceLevel, KnowledgeSourceChunk } from './knowledge-types.js'
import {
  cleanKnowledgeDisplay as cleanDisplay,
  formatKnowledgeLiteral as formatLiteral,
  knowledgeQueryTerms as queryTerms,
  knowledgeRowToNode as rowToNode,
  normalizeKnowledgeLabel as normalize,
} from './memory-knowledge-format.js'

export interface DocumentKnowledgePreviewItem {
  kind: 'relationship' | 'entity'
  label: string
}

export interface DocumentKnowledgePreview {
  items: DocumentKnowledgePreviewItem[]
  total: number
}

export interface DocumentAnalysisChunk {
  chunkIndex: number
  sectionPath: string
  summary: string
  tags: string[]
}

export interface DocumentAnalysisItem extends DocumentKnowledgePreviewItem {
  chunkIndex: number
  importance?: ImportanceLevel
}

export interface DocumentAnalysisRecord {
  contentHash: string
  pipelineVersion: string
  promptVersion: string
  activatedAt: number
  chunks: DocumentAnalysisChunk[]
  items: DocumentAnalysisItem[]
}

/**
 * Read model for the governed knowledge graph.
 *
 * Keeping hydration and browse queries together matters: node provenance,
 * literal nodes, and scoped edges must be assembled by the same rules.
 */
export class MemoryKnowledgeGraphStore {
  graphRows(categoryIds: string[] = [], limit = 5000, assertionId?: string): Array<Record<string, unknown>> {
    const scopes = Array.from(new Set(categoryIds.filter(Boolean)))
    const scopeClause = scopes.length ? `AND r.category_id IN (${scopes.map(() => '?').join(', ')})` : ''
    const assertionClause = assertionId ? 'AND a.id = ?' : ''
    return getDb().prepare(`
      SELECT a.*, p.canonical_name, p.aliases_json,
        se.canonical_name AS subject_name, se.normalized_name AS subject_normalized,
        se.entity_type AS subject_type, se.created_at AS subject_created_at, se.updated_at AS subject_updated_at,
        oe.canonical_name AS object_name, oe.normalized_name AS object_normalized,
        oe.entity_type AS object_type, oe.created_at AS object_created_at, oe.updated_at AS object_updated_at,
        ev.note AS extraction_note, ev.extractor_confidence, ev.entity_resolution_confidence, ev.source_trust, ev.entailment_score,
        (SELECT COUNT(*) FROM memory_knowledge_assertion_evidence evidence
          JOIN memory_knowledge_index_runs evidence_run ON evidence_run.id = evidence.run_id AND evidence_run.status = 'active'
          WHERE evidence.assertion_id = a.id) AS evidence_count,
        c.evidence_text AS correction_evidence, c.confidence AS manual_confidence,
        r.source_id, r.document_id, r.content_hash, r.category_id, r.file_name,
        tu.id AS text_unit_id, tu.text_hash,
        tu.chunk_index, tu.document_title, tu.section_path
      FROM memory_knowledge_assertions a
      JOIN memory_knowledge_predicates p ON p.id = a.predicate_id
      JOIN memory_knowledge_entities se ON se.id = a.subject_entity_id AND se.status = 'active'
      LEFT JOIN memory_knowledge_entities oe ON oe.id = a.object_entity_id AND oe.status = 'active'
      JOIN memory_knowledge_assertion_evidence ev ON ev.id = (
        SELECT candidate.id
        FROM memory_knowledge_assertion_evidence candidate
        JOIN memory_knowledge_index_runs candidate_run ON candidate_run.id = candidate.run_id AND candidate_run.status = 'active'
        WHERE candidate.assertion_id = a.id AND candidate.quote_verified = 1
        ORDER BY candidate.created_at DESC LIMIT 1
      )
      JOIN memory_knowledge_index_runs r ON r.id = ev.run_id AND r.status = 'active'
      JOIN memory_knowledge_text_units tu ON tu.id = ev.text_unit_id
      LEFT JOIN memory_knowledge_assertion_corrections c ON c.id = (
        SELECT correction.id FROM memory_knowledge_assertion_corrections correction
        WHERE correction.assertion_id = a.id ORDER BY correction.created_at DESC LIMIT 1
      )
      WHERE a.status IN ('active', 'disputed') ${scopeClause} ${assertionClause}
      ORDER BY a.importance DESC, a.updated_at DESC
      LIMIT ?
    `).all(...scopes, ...(assertionId ? [assertionId] : []), Math.max(1, limit)) as Array<Record<string, unknown>>
  }

  private graphEdge(row: Record<string, unknown>): KnowledgeAssertion {
    const objectName = row.object_name ? String(row.object_name) : formatLiteral(row.object_value_json)
    return {
      id: String(row.id),
      fromNodeId: String(row.subject_entity_id),
      toNodeId: row.object_entity_id ? String(row.object_entity_id) : `literal:${row.id}`,
      fromName: String(row.subject_name),
      toName: objectName,
      relation: String(row.canonical_name),
      importance: Math.min(3, Math.max(0, Number(row.importance))) as ImportanceLevel,
      assertionStatus: String(row.status) as KnowledgeAssertion['assertionStatus'],
      note: String(row.correction_evidence || row.extraction_note || ''),
      sourceKind: row.correction_evidence ? 'manual' : String(row.source_id).startsWith('manual:') ? 'manual' : 'memory',
      sourceId: String(row.source_id),
      sourceDocumentId: String(row.document_id),
      sourceContentHash: String(row.content_hash),
      sourceChunkIndex: Number(row.chunk_index),
      sourceChunk: this.sourceChunkFromRow(row, [String(row.correction_evidence || row.extraction_note || '')].filter(Boolean)),
      sourceIds: [String(row.source_id)],
      mentionCount: Number(row.evidence_count || 1),
      firstSeenAt: Number(row.created_at),
      lastSeenAt: Number(row.updated_at),
    }
  }

  sourceChunkFromRow(row: Record<string, unknown>, notes: string[] = []): KnowledgeSourceChunk {
    return {
      textUnitId: String(row.text_unit_id),
      href: `/api/memory/knowledge/chunks/${encodeURIComponent(String(row.text_unit_id))}`,
      documentId: String(row.document_id),
      fileName: String(row.file_name),
      chunkIndex: Number(row.chunk_index),
      documentTitle: String(row.document_title || ''),
      sectionPath: String(row.section_path || ''),
      text: String(row.source_text || ''),
      notes: Array.from(new Set(notes.map((note) => cleanDisplay(note, 600)).filter(Boolean))),
    }
  }

  private entityOrigins(entityId: string): KnowledgeEvidence[] {
    const rows = getDb().prepare(`
      SELECT r.source_id, r.document_id, r.file_name,
        tu.id AS text_unit_id, tu.chunk_index, tu.document_title, tu.section_path,
        COUNT(m.id) AS mention_count, MAX(m.created_at) AS last_seen_at
      FROM memory_knowledge_entity_mentions m
      JOIN memory_knowledge_index_runs r ON r.id = m.run_id AND r.status = 'active'
      JOIN memory_knowledge_text_units tu ON tu.id = m.text_unit_id
      WHERE m.entity_id = ?
      GROUP BY r.source_id, tu.id
      ORDER BY last_seen_at DESC, tu.chunk_index ASC
    `).all(entityId) as Array<Record<string, unknown>>
    const mentionNotes = getDb().prepare(`
      SELECT m.text_unit_id, m.note
      FROM memory_knowledge_entity_mentions m
      JOIN memory_knowledge_index_runs r ON r.id = m.run_id AND r.status = 'active'
      WHERE m.entity_id = ? AND m.note != ''
    `).all(entityId) as Array<{ text_unit_id: string; note: string }>
    const factNotes = getDb().prepare(`
      SELECT ev.text_unit_id, ev.note
      FROM memory_knowledge_assertion_evidence ev
      JOIN memory_knowledge_index_runs r ON r.id = ev.run_id AND r.status = 'active'
      JOIN memory_knowledge_assertions a ON a.id = ev.assertion_id
      WHERE (a.subject_entity_id = ? OR a.object_entity_id = ?)
        AND a.status IN ('active', 'disputed') AND ev.note != ''
    `).all(entityId, entityId) as Array<{ text_unit_id: string; note: string }>
    const notesByTextUnit = new Map<string, string[]>()
    for (const row of [...mentionNotes, ...factNotes]) {
      notesByTextUnit.set(row.text_unit_id, [...(notesByTextUnit.get(row.text_unit_id) || []), row.note])
    }
    const origins = new Map<string, KnowledgeEvidence>()
    for (const row of rows) {
      const sourceId = String(row.source_id)
      const chunk = this.sourceChunkFromRow(row, [
        ...(notesByTextUnit.get(String(row.text_unit_id)) || []),
      ])
      const sourceKind = sourceId.startsWith('manual:') ? 'manual' : 'memory'
      const existing = origins.get(sourceId)
      if (existing) {
        existing.count += Number(row.mention_count || 0)
        existing.lastSeenAt = Math.max(existing.lastSeenAt, Number(row.last_seen_at || 0))
        existing.chunks.push(chunk)
      } else {
        origins.set(sourceId, {
          sourceKind,
          sourceId,
          label: String(row.file_name || sourceId),
          count: Number(row.mention_count || 0),
          lastSeenAt: Number(row.last_seen_at || 0),
          chunks: [chunk],
        })
      }
    }
    return [...origins.values()]
  }

  getSourceChunk(textUnitId: string): KnowledgeSourceChunk | null {
    const row = getDb().prepare(`
      SELECT tu.id AS text_unit_id, tu.document_id, tu.file_name, tu.chunk_index,
        tu.document_title, tu.section_path, tu.text AS source_text
      FROM memory_knowledge_text_units tu
      JOIN memory_knowledge_index_runs r ON r.id = tu.run_id AND r.status = 'active'
      WHERE tu.id = ?
    `).get(textUnitId) as Record<string, unknown> | undefined
    if (!row) return null
    const notes = getDb().prepare(`
      SELECT note FROM memory_knowledge_entity_mentions WHERE text_unit_id = ? AND note != ''
      UNION
      SELECT note FROM memory_knowledge_assertion_evidence WHERE text_unit_id = ? AND note != ''
    `).all(textUnitId, textUnitId) as Array<{ note: string }>
    return this.sourceChunkFromRow(row, notes.map((item) => item.note))
  }

  hydrateGraphNode(row: Record<string, unknown>): KnowledgeEntity {
    const entityId = String(row.id)
    const aliases = getDb().prepare(`
      SELECT display_alias FROM memory_knowledge_entity_aliases WHERE entity_id = ? ORDER BY confidence DESC, created_at DESC
    `).all(entityId) as Array<{ display_alias: string }>
    const counts = getDb().prepare(`
      SELECT
        (SELECT COUNT(*) FROM memory_knowledge_entity_mentions m
          JOIN memory_knowledge_index_runs r ON r.id = m.run_id AND r.status = 'active'
          WHERE m.entity_id = ?) AS mentions,
        (SELECT COUNT(DISTINCT r.source_id) FROM memory_knowledge_entity_mentions m
          JOIN memory_knowledge_index_runs r ON r.id = m.run_id AND r.status = 'active'
          WHERE m.entity_id = ?) AS sources,
        (SELECT COALESCE(MAX(importance), 1) FROM memory_knowledge_assertions
          WHERE (subject_entity_id = ? OR object_entity_id = ?) AND status IN ('active', 'disputed')) AS importance
    `).get(entityId, entityId, entityId, entityId) as Record<string, number>
    return rowToNode({
      ...row,
      canonical_name: row.canonical_name,
      normalized_name: row.normalized_name,
      entity_type: row.entity_type,
      aliases: aliases.map((alias) => alias.display_alias).join('\u0000'),
      importance: counts.importance,
      mention_count: counts.mentions || 1,
    }, counts.sources || 1, this.entityOrigins(entityId))
  }

  getNode(id: string): KnowledgeEntity | null {
    const row = getDb().prepare(`SELECT * FROM memory_knowledge_entities WHERE id = ? AND status = 'active'`).get(id) as Record<string, unknown> | undefined
    return row ? this.hydrateGraphNode(row) : null
  }

  getEdge(id: string): KnowledgeAssertion | null {
    const row = this.graphRows([], 1, id)[0]
    return row ? this.graphEdge(row) : null
  }

  graphStats(categoryIds: string[] = []): { nodeCount: number; edgeCount: number; recentEdgeCount: number } {
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000
    const scopes = Array.from(new Set(categoryIds.filter(Boolean)))
    const scopeClause = scopes.length ? `AND r.category_id IN (${scopes.map(() => '?').join(', ')})` : ''
    const row = getDb().prepare(`
      SELECT
        (SELECT COUNT(*) FROM memory_knowledge_entities WHERE status = 'active' AND EXISTS (
          SELECT 1 FROM memory_knowledge_entity_mentions m JOIN memory_knowledge_index_runs r ON r.id = m.run_id
          WHERE m.entity_id = memory_knowledge_entities.id AND r.status = 'active' ${scopeClause}
        )) AS nodes,
        (SELECT COUNT(*) FROM memory_knowledge_assertions a WHERE a.status IN ('active', 'disputed') AND EXISTS (
          SELECT 1 FROM memory_knowledge_assertion_evidence ev JOIN memory_knowledge_index_runs r ON r.id = ev.run_id
          WHERE ev.assertion_id = a.id AND r.status = 'active' ${scopeClause}
        )) AS edges,
        (SELECT COUNT(*) FROM memory_knowledge_assertions a WHERE a.status IN ('active', 'disputed') AND a.updated_at >= ? AND EXISTS (
          SELECT 1 FROM memory_knowledge_assertion_evidence ev JOIN memory_knowledge_index_runs r ON r.id = ev.run_id
          WHERE ev.assertion_id = a.id AND r.status = 'active' ${scopeClause}
        )) AS recent
    `).get(...scopes, ...scopes, since, ...scopes) as Record<string, number>
    return { nodeCount: row.nodes, edgeCount: row.edges, recentEdgeCount: row.recent }
  }

  documentDeepResearchPreview(categoryId: string, fileName: string, limit = 15): DocumentKnowledgePreview {
    const boundedLimit = Math.min(15, Math.max(1, Math.round(limit)))
    const run = getDb().prepare(`
      SELECT id FROM memory_knowledge_index_runs
      WHERE category_id = ? AND file_name = ? AND status = 'active'
      ORDER BY activated_at DESC LIMIT 1
    `).get(categoryId, fileName) as { id: string } | undefined
    if (!run) return { items: [], total: 0 }

    const relationshipCount = Number((getDb().prepare(`
      SELECT COUNT(DISTINCT a.id) AS count
      FROM memory_knowledge_assertion_evidence ev
      JOIN memory_knowledge_assertions a ON a.id = ev.assertion_id
      WHERE ev.run_id = ? AND ev.quote_verified = 1 AND a.status IN ('active', 'disputed')
    `).get(run.id) as { count: number }).count)
    const relationshipRows = getDb().prepare(`
      SELECT DISTINCT a.id, a.object_value_json, p.canonical_name,
        subject.canonical_name AS subject_name, object.canonical_name AS object_name,
        a.importance, a.updated_at
      FROM memory_knowledge_assertion_evidence ev
      JOIN memory_knowledge_assertions a ON a.id = ev.assertion_id
      JOIN memory_knowledge_predicates p ON p.id = a.predicate_id
      JOIN memory_knowledge_entities subject ON subject.id = a.subject_entity_id
      LEFT JOIN memory_knowledge_entities object ON object.id = a.object_entity_id
      WHERE ev.run_id = ? AND ev.quote_verified = 1 AND a.status IN ('active', 'disputed')
      ORDER BY a.importance DESC, a.updated_at DESC
      LIMIT ?
    `).all(run.id, boundedLimit) as Array<Record<string, unknown>>

    // Mentions that already participate in a relationship are represented by
    // that relationship above. Include only genuinely standalone entities so
    // the preview remains useful instead of repeating every subject/object.
    const isolatedEntityCount = Number((getDb().prepare(`
      SELECT COUNT(DISTINCT e.id) AS count
      FROM memory_knowledge_entity_mentions mention
      JOIN memory_knowledge_entities e ON e.id = mention.entity_id AND e.status = 'active'
      WHERE mention.run_id = ? AND NOT EXISTS (
        SELECT 1 FROM memory_knowledge_assertion_evidence ev
        JOIN memory_knowledge_assertions a ON a.id = ev.assertion_id
        WHERE ev.run_id = mention.run_id AND ev.quote_verified = 1
          AND a.status IN ('active', 'disputed')
          AND (a.subject_entity_id = e.id OR a.object_entity_id = e.id)
      )
    `).get(run.id) as { count: number }).count)
    const remaining = Math.max(0, boundedLimit - relationshipRows.length)
    const entityRows = remaining > 0 ? getDb().prepare(`
      SELECT DISTINCT e.id, e.canonical_name, e.entity_type, e.updated_at
      FROM memory_knowledge_entity_mentions mention
      JOIN memory_knowledge_entities e ON e.id = mention.entity_id AND e.status = 'active'
      WHERE mention.run_id = ? AND NOT EXISTS (
        SELECT 1 FROM memory_knowledge_assertion_evidence ev
        JOIN memory_knowledge_assertions a ON a.id = ev.assertion_id
        WHERE ev.run_id = mention.run_id AND ev.quote_verified = 1
          AND a.status IN ('active', 'disputed')
          AND (a.subject_entity_id = e.id OR a.object_entity_id = e.id)
      )
      ORDER BY e.updated_at DESC
      LIMIT ?
    `).all(run.id, remaining) as Array<Record<string, unknown>> : []

    return {
      items: [
        ...relationshipRows.map((row) => ({
          kind: 'relationship' as const,
          label: `${row.subject_name} ${String(row.canonical_name).replace(/_/g, ' ')} ${row.object_name || formatLiteral(row.object_value_json)}`,
        })),
        ...entityRows.map((row) => ({
          kind: 'entity' as const,
          label: `${row.canonical_name} (${String(row.entity_type).replace(/_/g, ' ')})`,
        })),
      ],
      total: relationshipCount + isolatedEntityCount,
    }
  }

  documentAnalysis(categoryId: string, fileName: string): DocumentAnalysisRecord | null {
    const run = getDb().prepare(`
      SELECT id, content_hash, pipeline_version, prompt_version, activated_at
      FROM memory_knowledge_index_runs
      WHERE category_id = ? AND file_name = ? AND status = 'active'
      ORDER BY activated_at DESC LIMIT 1
    `).get(categoryId, fileName) as { id: string; content_hash: string; pipeline_version: string; prompt_version: string; activated_at: number } | undefined
    if (!run) return null

    const chunkRows = getDb().prepare(`
      SELECT chunk_index, section_path, summary, tags_json
      FROM memory_knowledge_text_units
      WHERE run_id = ? ORDER BY chunk_index
    `).all(run.id) as Array<{ chunk_index: number; section_path: string; summary: string; tags_json: string }>
    const chunks = chunkRows.map((row) => {
      let tags: string[] = []
      try {
        const parsed = JSON.parse(row.tags_json) as unknown
        if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string')
      } catch { /* malformed derived metadata is omitted */ }
      return {
        chunkIndex: row.chunk_index,
        sectionPath: row.section_path,
        summary: row.summary,
        tags,
      }
    })

    const relationshipRows = getDb().prepare(`
      SELECT DISTINCT a.id, a.object_value_json, p.canonical_name,
        subject.canonical_name AS subject_name, object.canonical_name AS object_name,
        a.importance, tu.chunk_index
      FROM memory_knowledge_assertion_evidence ev
      JOIN memory_knowledge_assertions a ON a.id = ev.assertion_id
      JOIN memory_knowledge_predicates p ON p.id = a.predicate_id
      JOIN memory_knowledge_entities subject ON subject.id = a.subject_entity_id
      LEFT JOIN memory_knowledge_entities object ON object.id = a.object_entity_id
      JOIN memory_knowledge_text_units tu ON tu.id = ev.text_unit_id
      WHERE ev.run_id = ? AND ev.quote_verified = 1 AND a.status IN ('active', 'disputed')
      ORDER BY tu.chunk_index, a.importance DESC, a.updated_at DESC
    `).all(run.id) as Array<Record<string, unknown>>
    const entityRows = getDb().prepare(`
      SELECT e.id, e.canonical_name, e.entity_type, MIN(tu.chunk_index) AS chunk_index
      FROM memory_knowledge_entity_mentions mention
      JOIN memory_knowledge_entities e ON e.id = mention.entity_id AND e.status = 'active'
      JOIN memory_knowledge_text_units tu ON tu.id = mention.text_unit_id
      WHERE mention.run_id = ? AND NOT EXISTS (
        SELECT 1 FROM memory_knowledge_assertion_evidence ev
        JOIN memory_knowledge_assertions a ON a.id = ev.assertion_id
        WHERE ev.run_id = mention.run_id AND ev.quote_verified = 1
          AND a.status IN ('active', 'disputed')
          AND (a.subject_entity_id = e.id OR a.object_entity_id = e.id)
      )
      GROUP BY e.id, e.canonical_name, e.entity_type
      ORDER BY chunk_index, e.canonical_name
    `).all(run.id) as Array<Record<string, unknown>>

    return {
      contentHash: run.content_hash,
      pipelineVersion: run.pipeline_version,
      promptVersion: run.prompt_version,
      activatedAt: run.activated_at,
      chunks,
      items: [
        ...relationshipRows.map((row) => ({
          kind: 'relationship' as const,
          label: `${row.subject_name} ${String(row.canonical_name).replace(/_/g, ' ')} ${row.object_name || formatLiteral(row.object_value_json)}`,
          chunkIndex: Number(row.chunk_index),
          importance: Math.min(3, Math.max(0, Number(row.importance))) as ImportanceLevel,
        })),
        ...entityRows.map((row) => ({
          kind: 'entity' as const,
          label: `${row.canonical_name} (${String(row.entity_type).replace(/_/g, ' ')})`,
          chunkIndex: Number(row.chunk_index),
        })),
      ].sort((a, b) => a.chunkIndex - b.chunkIndex),
    }
  }

  browseGraph(opts: {
    query?: string
    nodeId?: string
    nodeIds?: string[]
    limit?: number
    minImportance?: ImportanceLevel
    categoryIds?: string[]
    depth?: number
  } = {}): KnowledgeGraphProjection {
    const limit = Math.max(1, opts.limit || 80)
    const minImportance = opts.minImportance || 0
    const requestedNodeIds = Array.from(new Set([opts.nodeId, ...(opts.nodeIds || [])].filter((id): id is string => Boolean(id))))
    let edges = this.graphRows(opts.categoryIds, Math.max(limit * 4, 100)).map((row) => this.graphEdge(row)).filter((edge) => edge.importance >= minImportance)
    const allEntityIds = new Set(edges.flatMap((edge) => [edge.fromNodeId, ...(edge.toNodeId.startsWith('literal:') ? [] : [edge.toNodeId])]))
    const scopes = Array.from(new Set((opts.categoryIds || []).filter(Boolean)))
    const mentionedRows = getDb().prepare(`
      SELECT DISTINCT e.* FROM memory_knowledge_entities e
      JOIN memory_knowledge_entity_mentions m ON m.entity_id = e.id
      JOIN memory_knowledge_index_runs r ON r.id = m.run_id AND r.status = 'active'
      WHERE e.status = 'active' ${scopes.length ? `AND r.category_id IN (${scopes.map(() => '?').join(', ')})` : ''}
      ORDER BY e.updated_at DESC LIMIT ?
    `).all(...scopes, Math.max(limit * 2, 100)) as Array<Record<string, unknown>>
    for (const row of mentionedRows) allEntityIds.add(String(row.id))
    const scopedEntityIds = new Set(mentionedRows.map((row) => String(row.id)))
    for (const nodeId of requestedNodeIds) {
      if (!scopes.length || scopedEntityIds.has(nodeId)) allEntityIds.add(nodeId)
    }
    const entityRows = allEntityIds.size
      ? getDb().prepare(`SELECT * FROM memory_knowledge_entities WHERE id IN (${Array.from(allEntityIds).map(() => '?').join(', ')}) AND status = 'active'`).all(...allEntityIds) as Array<Record<string, unknown>>
      : []
    let nodes = entityRows.map((row) => this.hydrateGraphNode(row))
    for (const edge of edges.filter((candidate) => candidate.toNodeId.startsWith('literal:'))) {
      const origins: KnowledgeEvidence[] = edge.sourceChunk ? [{
        sourceKind: edge.sourceKind,
        sourceId: edge.sourceId,
        label: edge.sourceChunk.fileName || edge.sourceId,
        count: edge.mentionCount,
        lastSeenAt: edge.lastSeenAt,
        chunks: [edge.sourceChunk],
      }] : []
      nodes.push(rowToNode({
        id: edge.toNodeId, canonical_name: edge.toName, normalized_name: normalize(edge.toName),
        entity_type: 'concept', importance: edge.importance, created_at: edge.firstSeenAt, updated_at: edge.lastSeenAt,
      }, origins.length, origins))
    }

    const query = normalize(opts.query || '')
    let seedNodes: KnowledgeEntity[] = []
    if (requestedNodeIds.length) {
      const requestedIds = new Set(requestedNodeIds)
      seedNodes = nodes.filter((node) => requestedIds.has(node.id))
    }
    else if (query) {
      const terms = queryTerms(query)
      seedNodes = nodes.filter((node) => [node.name, ...node.aliases].some((name) => {
        const candidate = normalize(name)
        return query.includes(candidate) || terms.some((term) => candidate.includes(term))
      })).slice(0, 12)
      const matchingIds = new Set(seedNodes.map((node) => node.id))
      edges = edges.filter((edge) => matchingIds.has(edge.fromNodeId) || matchingIds.has(edge.toNodeId) || terms.some((term) => normalize(`${edge.relation} ${edge.note || ''}`).includes(term)))
    }

    if (requestedNodeIds.length && seedNodes.length) {
      const included = new Set(seedNodes.map((node) => node.id))
      let frontier = new Set(included)
      for (let hop = 0; hop < Math.max(1, Math.min(3, opts.depth || 2)); hop++) {
        const nextFrontier = new Set<string>()
        for (const edge of edges) if (frontier.has(edge.fromNodeId) || frontier.has(edge.toNodeId)) {
          if (!included.has(edge.fromNodeId)) nextFrontier.add(edge.fromNodeId)
          if (!included.has(edge.toNodeId)) nextFrontier.add(edge.toNodeId)
        }
        for (const nodeId of nextFrontier) included.add(nodeId)
        frontier = nextFrontier
        if (!frontier.size) break
      }
      edges = edges.filter((edge) => included.has(edge.fromNodeId) && included.has(edge.toNodeId))
    }

    edges = edges.slice(0, limit)
    const visibleIds = new Set(edges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]))
    nodes = nodes.filter((node) => (!requestedNodeIds.length && !query) || visibleIds.has(node.id) || seedNodes.some((seed) => seed.id === node.id)).slice(0, limit)
    return { seedNodes, nodes, edges }
  }

  suggestNodes(query: string, limit = 8, categoryIds: string[] = []): KnowledgeEntity[] {
    const normalized = normalize(query)
    const scopeClause = categoryIds.length ? `AND r.category_id IN (${categoryIds.map(() => '?').join(', ')})` : ''
    const rows = getDb().prepare(`
      SELECT DISTINCT e.* FROM memory_knowledge_entities e
      JOIN memory_knowledge_entity_mentions m ON m.entity_id = e.id
      JOIN memory_knowledge_index_runs r ON r.id = m.run_id AND r.status = 'active'
      WHERE e.status = 'active' ${scopeClause}
        AND (? = '' OR e.normalized_name LIKE ? ESCAPE '\\' OR EXISTS (
          SELECT 1 FROM memory_knowledge_entity_aliases a WHERE a.entity_id = e.id AND a.normalized_alias LIKE ? ESCAPE '\\'
        ))
      ORDER BY e.updated_at DESC LIMIT ?
    `).all(...categoryIds, normalized, `%${normalized.replace(/[\\%_]/g, (char) => `\\${char}`)}%`, `%${normalized.replace(/[\\%_]/g, (char) => `\\${char}`)}%`, limit) as Array<Record<string, unknown>>
    return rows.map((row) => this.hydrateGraphNode(row))
  }


}
