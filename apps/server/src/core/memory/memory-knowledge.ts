import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import type { DeleteEdgeResult, EntityEdge, EntityMergeResult, EntityNode, EntityType, GraphWalkResult, ImportanceLevel, KnowledgeSourceChunk } from './knowledge-types.js'
import type { PreparedMemoryChunk, RetrievedChunk } from './parser.js'
import { fuseRetrievalChannels } from './parser.js'
import { getEmbeddingProvider } from './embedding.js'
import { lanceDbInFilter } from './lancedb-filter.js'
import { getRAGStore, type SearchResult } from './rag.js'
import { getMemoryReranker } from './reranker.js'
import { cancelMemoryIndexJobsByKind } from './memory-index-jobs.js'
import { getEventBus } from '../telemetry/event-bus.js'
import {
  cleanKnowledgeDisplay as cleanDisplay,
  formatKnowledgeLiteral as formatLiteral,
  knowledgeQueryTerms as queryTerms,
  knowledgeRowToNode as rowToNode,
  normalizeKnowledgeLabel as normalize,
} from './memory-knowledge-format.js'
import { MemoryKnowledgeProjectionStore } from './memory-knowledge-projection.js'
import { MemoryKnowledgeGraphStore, type DocumentKnowledgePreview } from './memory-knowledge-graph.js'
export type { DocumentKnowledgePreview, DocumentKnowledgePreviewItem } from './memory-knowledge-graph.js'

export const MEMORY_KNOWLEDGE_PIPELINE_VERSION = 'knowledge-v4.1.0'
export const MEMORY_KNOWLEDGE_PROMPT_VERSION = 'knowledge-extraction-v5'
export const MEMORY_KNOWLEDGE_VECTOR_TABLE = 'memory_knowledge_v2'

export interface KnowledgeExtractedEntity {
  name: string
  type?: EntityType
  aliases?: string[]
  identityHint?: string
  description?: string
}

export interface KnowledgeExtractedRelation {
  action?: 'assert' | 'delete'
  from: KnowledgeExtractedEntity
  relation: string
  to?: KnowledgeExtractedEntity
  objectValue?: unknown
  importance?: ImportanceLevel
  note?: string
  validFrom?: string | number
  validTo?: string | number
  observedAt?: string | number
  sourceChunkIndex?: number
}

export interface KnowledgeExtractedMention {
  entity: KnowledgeExtractedEntity
  sourceChunkIndex: number
  note?: string
}

export interface KnowledgeExtractedChunkTags {
  sourceChunkIndex: number
  tags: string[]
}

export interface KnowledgePublishResult {
  runId: string
  status: 'active' | 'unchanged'
  textUnits: number
  entities: number
  assertions: number
  evidence: number
  rejectedClaims: number
}

export interface KnowledgeSearchResult {
  graph?: GraphWalkResult
  sourceChunks: RetrievedChunk[]
}

interface PredicateDefinition {
  id: string
  aliases?: string[]
  subjectTypes?: EntityType[]
  objectTypes?: EntityType[]
  inverse?: string
  symmetric?: boolean
  temporal?: boolean
  cardinality?: 'many' | 'one_per_subject' | 'one_per_pair'
  contradictionPolicy?: 'coexist' | 'dispute' | 'supersede_same_source'
}

const DEFAULT_PREDICATES: PredicateDefinition[] = [
  { id: 'related_to', aliases: ['associated_with', 'connected_to'], symmetric: true },
  { id: 'works_at', aliases: ['works_for', 'employed_by', 'employed_at', 'arbeitet_bei'], cardinality: 'one_per_subject', contradictionPolicy: 'supersede_same_source', temporal: true },
  { id: 'belongs_to', aliases: ['member_of', 'part_of', 'gehört_zu'] },
  { id: 'located_in', aliases: ['based_at', 'based_in', 'lives_in', 'wohnt_in'], cardinality: 'one_per_subject', contradictionPolicy: 'dispute', temporal: true },
  { id: 'uses', aliases: ['utilizes', 'verwendet', 'nutzt'] },
  { id: 'depends_on', aliases: ['relies_on', 'abhängig_von'] },
  { id: 'owns', aliases: ['possesses', 'besitzt'], temporal: true },
  { id: 'created', aliases: ['built', 'authored', 'entwickelte', 'erstellt'] },
  { id: 'prefers', aliases: ['likes', 'bevorzugt', 'mag'], temporal: true },
  { id: 'knows', aliases: ['acquainted_with', 'kennt'], symmetric: true, temporal: true },
  { id: 'parent_of', aliases: ['mother_of', 'father_of', 'elternteil_von'], inverse: 'child_of' },
  { id: 'child_of', aliases: ['son_of', 'daughter_of', 'kind_von'], inverse: 'parent_of' },
  { id: 'partner_of', aliases: ['spouse_of', 'married_to', 'partner_von'], symmetric: true, cardinality: 'one_per_subject', contradictionPolicy: 'dispute', temporal: true },
  { id: 'reports_to', aliases: ['managed_by', 'berichtet_an'], inverse: 'manages', cardinality: 'one_per_subject', contradictionPolicy: 'supersede_same_source', temporal: true },
  { id: 'manages', aliases: ['leads', 'supervises', 'leitet'], inverse: 'reports_to', temporal: true },
  { id: 'participated_in', aliases: ['attended', 'teilgenommen_an'], temporal: true },
  { id: 'occurred_on', aliases: ['happened_on', 'fand_statt_am'], subjectTypes: ['event'], objectTypes: ['date'], cardinality: 'one_per_subject', contradictionPolicy: 'supersede_same_source', temporal: true },
  { id: 'has_goal', aliases: ['aims_to', 'möchte', 'ziel'] },
  { id: 'has_role', aliases: ['role_is', 'ist_als'], cardinality: 'one_per_subject', contradictionPolicy: 'supersede_same_source', temporal: true },
]

function clamp(value: unknown, fallback = 0.5): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback
}

function parseTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function requestsRelationalTraversal(query: string): boolean {
  return /\b(connected|connection|path|relationship between|related through|how (?:is|are).*related|zusammenhang|verbunden|beziehung zwischen|wie (?:ist|sind).*verwandt)\b/iu.test(query)
}

const ROLE_PREDICATE_TERMS: Array<{ pattern: RegExp; predicates: string[] }> = [
  { pattern: /\b(?:mama|mami|mom|mommy|mother|mutter|mum|papa|papi|dad|daddy|father|vater|parent|eltern)\b/iu, predicates: ['parent_of', 'child_of'] },
  { pattern: /\b(?:partner|partnerin|spouse|husband|wife|ehemann|ehefrau|boyfriend|girlfriend|lebensgefährte|lebensgefährtin)\b/iu, predicates: ['partner_of'] },
  { pattern: /\b(?:boss|chef|manager|vorgesetzt|reports?|berichtet)\b/iu, predicates: ['reports_to', 'manages'] },
]

function requestedPredicates(query: string): Set<string> {
  const normalized = normalize(query)
  const predicates = new Set<string>()
  for (const definition of DEFAULT_PREDICATES) {
    const surfaces = [definition.id, ...(definition.aliases || [])]
    if (surfaces.some((surface) => normalized.includes(normalize(surface).replace(/_/g, ' ')))) predicates.add(definition.id)
  }
  for (const role of ROLE_PREDICATE_TERMS) {
    if (role.pattern.test(query)) for (const predicate of role.predicates) predicates.add(predicate)
  }
  return predicates
}

function candidateRelevance(candidate: SearchResult, index: number, total: number): number {
  if (typeof candidate.rerankerScore === 'number' && Number.isFinite(candidate.rerankerScore)) {
    return clamp(candidate.rerankerScore)
  }
  if (typeof candidate.denseScore === 'number' && Number.isFinite(candidate.denseScore)) {
    return clamp(candidate.denseScore)
  }
  return Math.max(0.05, 1 - index / Math.max(1, total)) * 0.7
}

function personalizedAssertionRanks(rows: Array<Record<string, unknown>>, seedEntityIds: Set<string>): Map<string, number> {
  if (!seedEntityIds.size) return new Map()
  const adjacency = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!row.object_entity_id) continue
    const from = String(row.subject_entity_id)
    const to = String(row.object_entity_id)
    adjacency.set(from, new Set([...(adjacency.get(from) || []), to]))
    adjacency.set(to, new Set([...(adjacency.get(to) || []), from]))
  }
  const nodes = Array.from(adjacency.keys())
  if (!nodes.length) return new Map()
  const seeds = Array.from(seedEntityIds).filter((id) => adjacency.has(id))
  if (!seeds.length) return new Map()
  const restart = 0.2
  let scores = new Map(nodes.map((node) => [node, seeds.includes(node) ? 1 / seeds.length : 0]))
  for (let iteration = 0; iteration < 16; iteration++) {
    const next = new Map(nodes.map((node) => [node, seeds.includes(node) ? restart / seeds.length : 0]))
    for (const [node, score] of scores) {
      const neighbors = adjacency.get(node)
      if (!neighbors?.size) continue
      const contribution = (1 - restart) * score / neighbors.size
      for (const neighbor of neighbors) next.set(neighbor, (next.get(neighbor) || 0) + contribution)
    }
    scores = next
  }
  const maxScore = Math.max(...scores.values(), 0.000001)
  const assertionRanks = new Map<string, number>()
  for (const row of rows) {
    const endpointScore = Math.max(
      scores.get(String(row.subject_entity_id)) || 0,
      row.object_entity_id ? scores.get(String(row.object_entity_id)) || 0 : 0,
    )
    assertionRanks.set(String(row.id), endpointScore / maxScore)
  }
  return assertionRanks
}

function exactOccurrences(text: string, surface: string): Array<{ start: number; end: number }> {
  const needle = surface.trim()
  if (!needle) return []
  const result: Array<{ start: number; end: number }> = []
  const haystack = text.toLocaleLowerCase()
  const loweredNeedle = needle.toLocaleLowerCase()
  let offset = 0
  while (offset < text.length) {
    const start = haystack.indexOf(loweredNeedle, offset)
    if (start < 0) break
    result.push({ start, end: start + needle.length })
    offset = start + Math.max(1, needle.length)
  }
  return result
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

export class MemoryKnowledgeStore {
  private resetGeneration = 0
  private readonly projections = new MemoryKnowledgeProjectionStore(MEMORY_KNOWLEDGE_VECTOR_TABLE)
  private readonly graph = new MemoryKnowledgeGraphStore()

  getResetGeneration(): number {
    return this.resetGeneration
  }

  ensurePredicateRegistry(): void {
    const db = getDb()
    const now = Date.now()
    const insert = db.prepare(`
      INSERT INTO memory_knowledge_predicates
        (id, canonical_name, aliases_json, subject_types_json, object_types_json,
         inverse_predicate_id, symmetric, temporal, cardinality, contradiction_policy,
         managed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        canonical_name = excluded.canonical_name,
        aliases_json = excluded.aliases_json,
        subject_types_json = excluded.subject_types_json,
        object_types_json = excluded.object_types_json,
        symmetric = excluded.symmetric,
        temporal = excluded.temporal,
        cardinality = excluded.cardinality,
        contradiction_policy = excluded.contradiction_policy,
        managed = 1,
        updated_at = excluded.updated_at
    `)
    db.transaction(() => {
      for (const definition of DEFAULT_PREDICATES) {
        insert.run(
          definition.id, definition.id, JSON.stringify(definition.aliases || []),
          JSON.stringify(definition.subjectTypes || []), JSON.stringify(definition.objectTypes || []),
          definition.symmetric ? 1 : 0, definition.temporal ? 1 : 0,
          definition.cardinality || 'many', definition.contradictionPolicy || 'coexist', now, now,
        )
      }
      const inverse = db.prepare('UPDATE memory_knowledge_predicates SET inverse_predicate_id = ? WHERE id = ?')
      for (const definition of DEFAULT_PREDICATES) if (definition.inverse) inverse.run(definition.inverse, definition.id)
    })()
  }

  private resolvePredicate(rawRelation: string): string {
    this.ensurePredicateRegistry()
    const db = getDb()
    const relation = normalize(rawRelation).replace(/[\s.-]+/g, '_') || 'related_to'
    const rows = db.prepare('SELECT id, canonical_name, aliases_json FROM memory_knowledge_predicates').all() as Array<{ id: string; canonical_name: string; aliases_json: string }>
    for (const row of rows) {
      const aliases = JSON.parse(row.aliases_json || '[]') as string[]
      if ([row.id, row.canonical_name, ...aliases].some((candidate) => normalize(candidate).replace(/[\s.-]+/g, '_') === relation)) return row.id
    }
    const now = Date.now()
    db.prepare(`
      INSERT OR IGNORE INTO memory_knowledge_predicates
        (id, canonical_name, aliases_json, cardinality, contradiction_policy, managed, created_at, updated_at)
      VALUES (?, ?, '[]', 'many', 'coexist', 0, ?, ?)
    `).run(relation, relation, now, now)
    return relation
  }

  private resolveEntity(opts: {
    runId: string
    namespaceId: string
    documentId: string
    entity: KnowledgeExtractedEntity
    now: number
  }): { id: string; confidence: number; created: boolean } | null {
    const db = getDb()
    const name = cleanDisplay(opts.entity.name, 160)
    const normalizedName = normalize(name)
    if (normalizedName.length < 2) return null
    const type = opts.entity.type || 'other'
    const identityHint = cleanDisplay(opts.entity.identityHint, 240)
    const normalizedHint = normalize(identityHint)
    const candidates = db.prepare(`
      SELECT e.*,
        EXISTS (
          SELECT 1 FROM memory_knowledge_entity_mentions m
          JOIN memory_knowledge_text_units tu ON tu.id = m.text_unit_id
          JOIN memory_knowledge_index_runs r ON r.id = m.run_id
          WHERE m.entity_id = e.id AND r.document_id = ? AND (r.status = 'active' OR r.id = ?)
        ) AS same_document
      FROM memory_knowledge_entities e
      WHERE e.namespace_id = ? AND e.entity_type = ? AND e.status = 'active'
        AND (e.normalized_name = ? OR EXISTS (
          SELECT 1 FROM memory_knowledge_entity_aliases a
          WHERE a.entity_id = e.id AND a.normalized_alias = ?
        ))
    `).all(opts.documentId, opts.runId, opts.namespaceId, type, normalizedName, normalizedName) as Array<Record<string, unknown>>

    let selected: Record<string, unknown> | undefined
    let confidence = 0
    let rationale = ''
    if (normalizedHint) {
      const exactHint = candidates.filter((candidate) => String(candidate.normalized_identity_hint) === normalizedHint)
      if (exactHint.length === 1) {
        selected = exactHint[0]
        confidence = 0.98
        rationale = 'exact_name_type_and_identity_hint'
      }
    }
    if (!selected) {
      const sameDocument = candidates.filter((candidate) => Boolean(candidate.same_document))
      if (sameDocument.length === 1) {
        selected = sameDocument[0]
        confidence = 0.94
        rationale = 'same_document_name_and_type'
      }
    }
    if (!selected && candidates.length === 1 && (type !== 'person' || normalizedName.split(' ').length >= 2)) {
      selected = candidates[0]
      confidence = type === 'person' ? 0.84 : 0.9
      rationale = 'unique_exact_name_and_type'
    }

    let id: string
    let created = false
    let decision: 'created' | 'resolved' | 'ambiguous'
    if (selected) {
      id = String(selected.id)
      decision = 'resolved'
      db.prepare(`
        UPDATE memory_knowledge_entities SET
          canonical_name = CASE WHEN length(?) > length(canonical_name) THEN ? ELSE canonical_name END,
          description = CASE WHEN ? != '' THEN ? ELSE description END,
          identity_hint = CASE WHEN identity_hint = '' AND ? != '' THEN ? ELSE identity_hint END,
          normalized_identity_hint = CASE WHEN normalized_identity_hint = '' AND ? != '' THEN ? ELSE normalized_identity_hint END,
          updated_at = ?
        WHERE id = ?
      `).run(name, name, opts.entity.description || '', opts.entity.description || '', identityHint, identityHint, normalizedHint, normalizedHint, opts.now, id)
    } else {
      id = nanoid()
      created = true
      confidence = candidates.length ? 0.55 : 0.8
      rationale = candidates.length ? 'ambiguous_candidates_created_separate_entity' : 'no_candidate'
      decision = candidates.length ? 'ambiguous' : 'created'
      db.prepare(`
        INSERT INTO memory_knowledge_entities
          (id, namespace_id, canonical_name, normalized_name, entity_type, identity_hint,
           normalized_identity_hint, description, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(id, opts.namespaceId, name, normalizedName, type, identityHint, normalizedHint, cleanDisplay(opts.entity.description, 1000), opts.now, opts.now)
    }

    db.prepare(`
      INSERT INTO memory_knowledge_entity_resolution_decisions
        (id, run_id, surface, normalized_surface, entity_type, identity_hint,
         selected_entity_id, candidate_ids_json, decision, confidence, rationale, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nanoid(), opts.runId, name, normalizedName, type, identityHint, id, JSON.stringify(candidates.map((candidate) => candidate.id)), decision, confidence, rationale, opts.now)

    const aliases = Array.from(new Set([name, ...(opts.entity.aliases || [])].map((alias) => cleanDisplay(alias, 160)).filter(Boolean)))
    const addAlias = db.prepare(`
      INSERT INTO memory_knowledge_entity_aliases
        (id, entity_id, display_alias, normalized_alias, source, confidence, created_at)
      VALUES (?, ?, ?, ?, 'extraction', ?, ?)
      ON CONFLICT(entity_id, normalized_alias) DO UPDATE SET
        display_alias = excluded.display_alias,
        confidence = MAX(memory_knowledge_entity_aliases.confidence, excluded.confidence)
    `)
    for (const alias of aliases) addAlias.run(nanoid(), id, alias, normalize(alias), confidence, opts.now)
    return { id, confidence, created }
  }

  publishDocument(opts: {
    documentId: string
    contentHash: string
    spaceId: string
    fileName: string
    sourceId: string
    chunks: PreparedMemoryChunk[]
    relations: KnowledgeExtractedRelation[]
    mentions?: KnowledgeExtractedMention[]
    chunkTags?: KnowledgeExtractedChunkTags[]
    extractorProviderId?: string
    extractorModel?: string
    validateBeforePublish?: () => boolean
  }): KnowledgePublishResult {
    this.ensurePredicateRegistry()
    const db = getDb()
    const existing = db.prepare(`
      SELECT id FROM memory_knowledge_index_runs
      WHERE document_id = ? AND content_hash = ? AND pipeline_version = ? AND status = 'active'
    `).get(opts.documentId, opts.contentHash, MEMORY_KNOWLEDGE_PIPELINE_VERSION) as { id: string } | undefined
    if (existing) {
      const counts = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM memory_knowledge_text_units WHERE run_id = ?) AS text_units,
          (SELECT COUNT(DISTINCT entity_id) FROM memory_knowledge_entity_mentions WHERE run_id = ? AND entity_id IS NOT NULL) AS entities,
          (SELECT COUNT(DISTINCT assertion_id) FROM memory_knowledge_assertion_evidence WHERE run_id = ?) AS assertions,
          (SELECT COUNT(*) FROM memory_knowledge_assertion_evidence WHERE run_id = ?) AS evidence
      `).get(existing.id, existing.id, existing.id, existing.id) as Record<string, number>
      return { runId: existing.id, status: 'unchanged', textUnits: counts.text_units, entities: counts.entities, assertions: counts.assertions, evidence: counts.evidence, rejectedClaims: 0 }
    }

    const conflictingRun = db.prepare(`
      SELECT id FROM memory_knowledge_index_runs
      WHERE document_id = ? AND content_hash = ? AND pipeline_version = ?
    `).get(opts.documentId, opts.contentHash, MEMORY_KNOWLEDGE_PIPELINE_VERSION) as { id: string } | undefined
    if (conflictingRun) db.prepare('DELETE FROM memory_knowledge_index_runs WHERE id = ?').run(conflictingRun.id)

    const runId = nanoid()
    const now = Date.now()
    let entityCount = 0
    let assertionCount = 0
    let evidenceCount = 0
    let rejectedClaims = 0
    const touchedAssertions = new Set<string>()
    const tagsByChunk = new Map((opts.chunkTags || []).map((item) => [item.sourceChunkIndex, item.tags]))

    db.transaction(() => {
      db.prepare(`
        INSERT INTO memory_knowledge_index_runs
          (id, document_id, content_hash, space_id, file_name, source_id, pipeline_version,
           prompt_version, extractor_provider_id, extractor_model, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?)
      `).run(runId, opts.documentId, opts.contentHash, opts.spaceId, opts.fileName, opts.sourceId,
        MEMORY_KNOWLEDGE_PIPELINE_VERSION, MEMORY_KNOWLEDGE_PROMPT_VERSION,
        opts.extractorProviderId || '', opts.extractorModel || '', now)

      const textUnitIds = new Map<number, string>()
      const insertTextUnit = db.prepare(`
        INSERT INTO memory_knowledge_text_units
          (id, run_id, document_id, content_hash, space_id, file_name, chunk_index,
           text, text_hash, document_title, section_path, tags_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const chunk of opts.chunks) {
        const id = nanoid()
        textUnitIds.set(chunk.chunkIndex, id)
        insertTextUnit.run(id, runId, opts.documentId, opts.contentHash, opts.spaceId, opts.fileName,
          chunk.chunkIndex, chunk.text, chunk.contentHash || createHash('sha256').update(chunk.text).digest('hex'),
          chunk.documentTitle, chunk.sectionPath, JSON.stringify(tagsByChunk.get(chunk.chunkIndex) || []), now)
      }

      const addEntityMentions = (
        chunk: PreparedMemoryChunk,
        textUnitId: string,
        entity: KnowledgeExtractedEntity,
        resolvedId: string,
        resolutionConfidence: number,
        contextText: string,
        note: string,
      ) => {
        const occurrences = exactOccurrences(chunk.text, entity.name)
        const values = occurrences.length ? occurrences : [{ start: -1, end: -1 }]
        for (const occurrence of values) {
          db.prepare(`
            INSERT OR IGNORE INTO memory_knowledge_entity_mentions
              (id, run_id, text_unit_id, entity_id, surface, normalized_surface, entity_type,
               span_start, span_end, resolution_confidence, resolution_status, context_text, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(nanoid(), runId, textUnitId, resolvedId, entity.name, normalize(entity.name), entity.type || 'other',
            occurrence.start, occurrence.end, resolutionConfidence,
            occurrences.length === 0 ? 'unresolved' : resolutionConfidence >= 0.75 ? 'resolved' : 'ambiguous', contextText,
            cleanDisplay(note, 600), now)
        }
      }

      for (const mention of opts.mentions || []) {
        const chunk = opts.chunks.find((item) => item.chunkIndex === mention.sourceChunkIndex)
        const textUnitId = textUnitIds.get(mention.sourceChunkIndex)
        if (!chunk || !textUnitId) {
          rejectedClaims++
          continue
        }
        const entity = this.resolveEntity({ runId, namespaceId: opts.spaceId, documentId: opts.documentId, entity: mention.entity, now })
        if (!entity) {
          rejectedClaims++
          continue
        }
        if (entity.created) entityCount++
        const note = cleanDisplay(mention.note, 600) || `${mention.entity.name} is mentioned in this source chunk.`
        addEntityMentions(chunk, textUnitId, mention.entity, entity.id, entity.confidence, note, note)
      }

      for (const relation of opts.relations) {
        const chunk = relation.sourceChunkIndex === undefined ? undefined : opts.chunks.find((item) => item.chunkIndex === relation.sourceChunkIndex)
        const textUnitId = relation.sourceChunkIndex === undefined ? undefined : textUnitIds.get(relation.sourceChunkIndex)
        if (!chunk || !textUnitId || !relation.from || (!relation.to && relation.objectValue === undefined)) {
          rejectedClaims++
          continue
        }

        const predicateId = this.resolvePredicate(relation.relation)
        const predicate = db.prepare(`SELECT subject_types_json, object_types_json FROM memory_knowledge_predicates WHERE id = ?`)
          .get(predicateId) as { subject_types_json: string; object_types_json: string } | undefined
        const subjectTypes = JSON.parse(predicate?.subject_types_json || '[]') as EntityType[]
        const objectTypes = JSON.parse(predicate?.object_types_json || '[]') as EntityType[]
        if ((subjectTypes.length && !subjectTypes.includes(relation.from.type || 'other')) ||
          (relation.to && objectTypes.length && !objectTypes.includes(relation.to.type || 'other'))) {
          rejectedClaims++
          continue
        }

        const subject = this.resolveEntity({ runId, namespaceId: opts.spaceId, documentId: opts.documentId, entity: relation.from, now })
        const object = relation.to
          ? this.resolveEntity({ runId, namespaceId: opts.spaceId, documentId: opts.documentId, entity: relation.to, now })
          : null
        if (!subject || (relation.to && !object)) {
          rejectedClaims++
          continue
        }
        if (subject.created) entityCount++
        if (object?.created) entityCount++
        const objectJson = relation.to ? null : stableJson(relation.objectValue)
        const objectKey = object ? `entity:${object.id}` : `literal:${createHash('sha256').update(objectJson || '').digest('hex')}`

        const existingAssertion = db.prepare(`
          SELECT id FROM memory_knowledge_assertions
          WHERE namespace_id = ? AND subject_entity_id = ? AND predicate_id = ?
            AND normalized_object_key = ? AND status IN ('active', 'staging', 'disputed', 'retired')
          ORDER BY updated_at DESC LIMIT 1
        `).get(opts.spaceId, subject.id, predicateId, objectKey) as { id: string } | undefined
        const assertionId = existingAssertion?.id || nanoid()
        if (!existingAssertion) {
          db.prepare(`
            INSERT INTO memory_knowledge_assertions
              (id, namespace_id, subject_entity_id, predicate_id, object_entity_id,
               object_value_json, normalized_object_key, status, importance, valid_from,
               valid_to, observed_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?)
          `).run(assertionId, opts.spaceId, subject.id, predicateId, object?.id || null, objectJson,
            objectKey, relation.importance ?? 1, parseTime(relation.validFrom), parseTime(relation.validTo),
            parseTime(relation.observedAt) || now, now, now)
          assertionCount++
        } else {
          db.prepare(`UPDATE memory_knowledge_assertions SET importance = MAX(importance, ?), updated_at = ? WHERE id = ?`)
            .run(relation.importance ?? 1, now, assertionId)
        }

        const entityResolutionConfidence = Math.min(subject.confidence, object?.confidence ?? 1)
        const relationshipNote = cleanDisplay(relation.note, 600)
          || `${relation.from.name} ${predicateId.replace(/_/g, ' ')} ${relation.to?.name || formatLiteral(objectJson)}.`
        db.prepare(`
          INSERT OR IGNORE INTO memory_knowledge_assertion_evidence
            (id, assertion_id, run_id, text_unit_id, quote, span_start, span_end,
             extractor_confidence, entity_resolution_confidence, source_trust,
             entailment_score, quote_verified, note, pipeline_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 1, ?, ?, ?)
        `).run(nanoid(), assertionId, runId, textUnitId, '', 0, 0,
          1, entityResolutionConfidence, relationshipNote, MEMORY_KNOWLEDGE_PIPELINE_VERSION, now)
        evidenceCount++
        touchedAssertions.add(assertionId)

        addEntityMentions(chunk, textUnitId, relation.from, subject.id, subject.confidence, relationshipNote, relationshipNote)
        if (relation.to && object) addEntityMentions(chunk, textUnitId, relation.to, object.id, object.confidence, relationshipNote, relationshipNote)

        if (relation.action === 'delete') {
          db.prepare(`UPDATE memory_knowledge_assertions SET status = 'retracted', updated_at = ? WHERE id = ?`).run(now, assertionId)
        }
      }

      if (opts.validateBeforePublish && !opts.validateBeforePublish()) throw new Error('MEMORY_KNOWLEDGE_SOURCE_CHANGED')

      const priorRuns = db.prepare(`
        SELECT id FROM memory_knowledge_index_runs
        WHERE document_id = ? AND status = 'active' AND id != ?
      `).all(opts.documentId, runId) as Array<{ id: string }>
      db.prepare(`
        UPDATE memory_knowledge_index_runs SET status = 'retired', completed_at = COALESCE(completed_at, ?)
        WHERE document_id = ? AND status = 'active' AND id != ?
      `).run(now, opts.documentId, runId)
      db.prepare(`
        UPDATE memory_knowledge_index_runs
        SET status = 'active', completed_at = ?, activated_at = ?, error = NULL
        WHERE id = ?
      `).run(now, now, runId)

      if (priorRuns.length && touchedAssertions.size) {
        const priorPlaceholders = priorRuns.map(() => '?').join(', ')
        for (const assertionId of touchedAssertions) {
          const currentAssertion = db.prepare(`
            SELECT subject_entity_id, predicate_id, normalized_object_key
            FROM memory_knowledge_assertions WHERE id = ?
          `).get(assertionId) as Record<string, unknown> | undefined
          if (!currentAssertion) continue
          db.prepare(`
            UPDATE memory_knowledge_assertions AS prior SET
              status = 'superseded', superseded_by_id = ?, updated_at = ?
            WHERE prior.subject_entity_id = ? AND prior.predicate_id = ?
              AND prior.normalized_object_key != ?
              AND EXISTS (
                SELECT 1 FROM memory_knowledge_predicates p
                WHERE p.id = prior.predicate_id
                  AND p.cardinality = 'one_per_subject'
                  AND p.contradiction_policy = 'supersede_same_source'
              )
              AND EXISTS (
                SELECT 1 FROM memory_knowledge_assertion_evidence ev
                WHERE ev.assertion_id = prior.id AND ev.run_id IN (${priorPlaceholders})
              )
          `).run(assertionId, now, currentAssertion.subject_entity_id, currentAssertion.predicate_id,
            currentAssertion.normalized_object_key, ...priorRuns.map((run) => run.id))
        }
      }

      // Assertions without any evidence from a published run are projections
      // of an old revision and are retired. Assertions supported by the new
      // run become active unless the source explicitly retracted them.
      if (priorRuns.length || touchedAssertions.size) {
        db.prepare(`
          UPDATE memory_knowledge_assertions AS a SET status = 'retired', updated_at = ?
          WHERE status NOT IN ('retracted', 'superseded')
            AND EXISTS (SELECT 1 FROM memory_knowledge_assertion_evidence ev WHERE ev.assertion_id = a.id)
            AND NOT EXISTS (
              SELECT 1 FROM memory_knowledge_assertion_evidence ev
              JOIN memory_knowledge_index_runs r ON r.id = ev.run_id
              WHERE ev.assertion_id = a.id AND r.status = 'active'
            )
        `).run(now)
        for (const assertionId of touchedAssertions) {
          db.prepare(`UPDATE memory_knowledge_assertions SET status = CASE WHEN status = 'retracted' THEN status ELSE 'active' END, updated_at = ? WHERE id = ?`)
            .run(now, assertionId)
        }
      }

      // Functional predicates never silently erase disagreement. A changed
      // value from the same document supersedes the prior value; independently
      // sourced conflicts remain visible and explicitly disputed.
      const functionalAssertions = db.prepare(`
        SELECT a.id, a.subject_entity_id, a.predicate_id, a.normalized_object_key,
               p.contradiction_policy,
               GROUP_CONCAT(DISTINCT r.document_id) AS document_ids
        FROM memory_knowledge_assertions a
        JOIN memory_knowledge_predicates p ON p.id = a.predicate_id
        JOIN memory_knowledge_assertion_evidence ev ON ev.assertion_id = a.id
        JOIN memory_knowledge_index_runs r ON r.id = ev.run_id AND r.status = 'active'
        WHERE a.namespace_id = ? AND a.status = 'active' AND p.cardinality = 'one_per_subject'
        GROUP BY a.id
      `).all(opts.spaceId) as Array<Record<string, unknown>>
      const groups = new Map<string, Array<Record<string, unknown>>>()
      for (const assertion of functionalAssertions) {
        const key = `${assertion.subject_entity_id}\u0000${assertion.predicate_id}`
        groups.set(key, [...(groups.get(key) || []), assertion])
      }
      for (const assertions of groups.values()) {
        if (new Set(assertions.map((assertion) => assertion.normalized_object_key)).size <= 1) continue
        const newAssertion = assertions.find((assertion) => touchedAssertions.has(String(assertion.id)))
        for (const assertion of assertions) {
          if (!newAssertion || assertion.id === newAssertion.id) continue
          const sameDocument = String(assertion.document_ids || '').split(',').includes(opts.documentId)
          if (sameDocument && assertion.contradiction_policy === 'supersede_same_source') {
            db.prepare(`UPDATE memory_knowledge_assertions SET status = 'superseded', superseded_by_id = ?, updated_at = ? WHERE id = ?`)
              .run(newAssertion.id, now, assertion.id)
          } else {
            db.prepare(`UPDATE memory_knowledge_assertions SET status = 'disputed', updated_at = ? WHERE id IN (?, ?)`)
              .run(now, assertion.id, newAssertion.id)
          }
        }
      }
      db.prepare(`
        UPDATE memory_knowledge_entities AS e SET status = 'retired', updated_at = ?
        WHERE e.status = 'active' AND NOT EXISTS (
          SELECT 1 FROM memory_knowledge_entity_mentions m
          JOIN memory_knowledge_index_runs r ON r.id = m.run_id
          WHERE m.entity_id = e.id AND r.status = 'active'
        )
      `).run(now)
    })()

    return { runId, status: 'active', textUnits: opts.chunks.length, entities: entityCount, assertions: assertionCount, evidence: evidenceCount, rejectedClaims }
  }

  retireDocument(documentId: string): void {
    const db = getDb()
    const now = Date.now()
    db.transaction(() => {
      db.prepare(`UPDATE memory_knowledge_index_runs SET status = 'retired', completed_at = COALESCE(completed_at, ?) WHERE document_id = ? AND status = 'active'`).run(now, documentId)
      db.prepare(`
        UPDATE memory_knowledge_assertions AS a SET status = 'retired', updated_at = ?
        WHERE status NOT IN ('retracted', 'superseded')
          AND EXISTS (SELECT 1 FROM memory_knowledge_assertion_evidence ev WHERE ev.assertion_id = a.id)
          AND NOT EXISTS (
            SELECT 1 FROM memory_knowledge_assertion_evidence ev
            JOIN memory_knowledge_index_runs r ON r.id = ev.run_id
            WHERE ev.assertion_id = a.id AND r.status = 'active'
          )
      `).run(now)
      db.prepare(`
        UPDATE memory_knowledge_entities AS e SET status = 'retired', updated_at = ?
        WHERE e.status = 'active' AND NOT EXISTS (
          SELECT 1 FROM memory_knowledge_entity_mentions m
          JOIN memory_knowledge_index_runs r ON r.id = m.run_id
          WHERE m.entity_id = e.id AND r.status = 'active'
        )
      `).run(now)
    })()
  }

  async indexSearchProjection(runId: string, signal?: AbortSignal): Promise<number> {
    return this.projections.indexRun(runId, signal)
  }

  async reindexActiveDocumentProjection(documentId: string): Promise<number> {
    return this.projections.reindexDocument(documentId)
  }

  markSearchProjectionsPending(): void {
    this.projections.markAllPending()
  }

  async reindexAllActiveSearchProjections(signal?: AbortSignal): Promise<{ runs: number; documents: number }> {
    return this.projections.reindexAll(signal)
  }

  getSourceChunk(textUnitId: string): KnowledgeSourceChunk | null {
    return this.graph.getSourceChunk(textUnitId)
  }

  getNode(id: string): EntityNode | null {
    return this.graph.getNode(id)
  }

  getEdge(id: string): EntityEdge | null {
    return this.graph.getEdge(id)
  }

  graphStats(spaceIds: string[] = []): { nodeCount: number; edgeCount: number; recentEdgeCount: number } {
    return this.graph.graphStats(spaceIds)
  }

  documentExtractionPreview(spaceId: string, fileName: string, limit = 15): DocumentKnowledgePreview {
    return this.graph.documentExtractionPreview(spaceId, fileName, limit)
  }

  browseGraph(opts: {
    query?: string
    nodeId?: string
    nodeIds?: string[]
    limit?: number
    minImportance?: ImportanceLevel
    spaceIds?: string[]
    depth?: number
  } = {}): GraphWalkResult {
    return this.graph.browseGraph(opts)
  }

  suggestNodes(query: string, limit = 8, spaceIds: string[] = []): EntityNode[] {
    return this.graph.suggestNodes(query, limit, spaceIds)
  }

  async mergeEntities(opts: {
    entityIds: string[]
    canonicalName: string
    spaceIds?: string[]
  }): Promise<EntityMergeResult> {
    let entityIds = Array.from(new Set(opts.entityIds.map((id) => id.trim()).filter(Boolean))).slice(0, 20)
    if (entityIds.length < 1) throw new Error('ENTITY_MERGE_REQUIRES_MULTIPLE')
    const canonicalName = cleanDisplay(opts.canonicalName, 160)
    const normalizedName = normalize(canonicalName)
    if (!canonicalName || !normalizedName) throw new Error('ENTITY_MERGE_INVALID_NAME')

    let placeholders = entityIds.map(() => '?').join(', ')
    let rows = getDb().prepare(`
      SELECT * FROM memory_knowledge_entities
      WHERE id IN (${placeholders}) AND status = 'active'
    `).all(...entityIds) as Array<Record<string, unknown>>
    if (rows.length !== entityIds.length) throw new Error('ENTITY_MERGE_ENTITY_NOT_FOUND')
    const rowsById = new Map(rows.map((row) => [String(row.id), row]))
    const primary = rowsById.get(entityIds[0])!
    const namespaceId = String(primary.namespace_id)
    if (rows.some((row) => String(row.namespace_id) !== namespaceId)) {
      throw new Error('ENTITY_MERGE_CROSS_NAMESPACE')
    }
    const allowedSpaces = new Set((opts.spaceIds || []).filter(Boolean))
    if (allowedSpaces.size > 0 && !allowedSpaces.has(namespaceId)) throw new Error('ENTITY_MERGE_OUT_OF_SCOPE')

    let primaryId = String(primary.id)
    const primaryType = String(primary.entity_type) as EntityType
    const suppliedCanonical = rows.find((row) =>
      String(row.normalized_name) === normalizedName && String(row.entity_type) === primaryType)
    if (suppliedCanonical) primaryId = String(suppliedCanonical.id)
    const conflict = suppliedCanonical ? undefined : getDb().prepare(`
      SELECT * FROM memory_knowledge_entities
      WHERE namespace_id = ? AND normalized_name = ? AND entity_type = ?
        AND status = 'active' AND id NOT IN (${placeholders})
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(namespaceId, normalizedName, primaryType, ...entityIds) as Record<string, unknown> | undefined
    if (conflict) {
      primaryId = String(conflict.id)
      entityIds = [primaryId, ...entityIds]
      rows = [conflict, ...rows]
      placeholders = entityIds.map(() => '?').join(', ')
    }
    if (entityIds.length < 2) throw new Error('ENTITY_MERGE_REQUIRES_MULTIPLE')

    const aliases = getDb().prepare(`
      SELECT entity_id, display_alias, normalized_alias
      FROM memory_knowledge_entity_aliases WHERE entity_id IN (${placeholders})
      ORDER BY confidence DESC, created_at ASC
    `).all(...entityIds) as Array<{ entity_id: string; display_alias: string; normalized_alias: string }>
    const aliasesByNormalized = new Map<string, string>()
    for (const row of rows) {
      const display = cleanDisplay(row.canonical_name, 160)
      const normalized = normalize(display)
      if (normalized && normalized !== normalizedName && !aliasesByNormalized.has(normalized)) {
        aliasesByNormalized.set(normalized, display)
      }
    }
    for (const alias of aliases) {
      const display = cleanDisplay(alias.display_alias, 160)
      const normalized = normalize(display)
      if (normalized && normalized !== normalizedName && !aliasesByNormalized.has(normalized)) {
        aliasesByNormalized.set(normalized, display)
      }
    }

    const activeRuns = getDb().prepare(`
      SELECT DISTINCT r.id
      FROM memory_knowledge_index_runs r
      WHERE r.status = 'active' AND (
        EXISTS (
          SELECT 1 FROM memory_knowledge_entity_mentions m
          WHERE m.run_id = r.id AND m.entity_id IN (${placeholders})
        ) OR EXISTS (
          SELECT 1 FROM memory_knowledge_assertion_evidence ev
          JOIN memory_knowledge_assertions a ON a.id = ev.assertion_id
          WHERE ev.run_id = r.id
            AND (a.subject_entity_id IN (${placeholders}) OR a.object_entity_id IN (${placeholders}))
        )
      )
    `).all(...entityIds, ...entityIds, ...entityIds) as Array<{ id: string }>
    const decisions = getDb().prepare(`
      SELECT id, candidate_ids_json FROM memory_knowledge_entity_resolution_decisions
    `).all() as Array<{ id: string; candidate_ids_json: string }>
    const selfRelationshipIds = (getDb().prepare(`
      SELECT id FROM memory_knowledge_assertions
      WHERE subject_entity_id IN (${placeholders}) AND object_entity_id IN (${placeholders})
        AND subject_entity_id != object_entity_id AND status IN ('active', 'disputed')
    `).all(...entityIds, ...entityIds) as Array<{ id: string }>).map((row) => row.id)

    let consolidatedAssertions = 0
    const retiredAssertionIds = new Set(selfRelationshipIds)
    const now = Date.now()
    getDb().transaction(() => {
      getDb().prepare(`
        UPDATE memory_knowledge_entity_mentions
        SET entity_id = ?, entity_type = ?, resolution_status = 'manual'
        WHERE entity_id IN (${placeholders})
      `).run(primaryId, primaryType, ...entityIds)
      getDb().prepare(`
        UPDATE memory_knowledge_entity_resolution_decisions
        SET selected_entity_id = ?, entity_type = ?, decision = 'manual',
          confidence = 1, rationale = 'entities manually merged'
        WHERE selected_entity_id IN (${placeholders})
      `).run(primaryId, primaryType, ...entityIds)
      const updateCandidates = getDb().prepare(`
        UPDATE memory_knowledge_entity_resolution_decisions SET candidate_ids_json = ? WHERE id = ?
      `)
      for (const decision of decisions) {
        let candidates: unknown
        try { candidates = JSON.parse(decision.candidate_ids_json) } catch { continue }
        if (!Array.isArray(candidates) || !candidates.some((id) => entityIds.includes(String(id)))) continue
        const merged = Array.from(new Set(candidates.map((id) => entityIds.includes(String(id)) ? primaryId : String(id))))
        updateCandidates.run(JSON.stringify(merged), decision.id)
      }

      getDb().prepare(`UPDATE memory_knowledge_assertions SET subject_entity_id = ?, updated_at = ? WHERE subject_entity_id IN (${placeholders})`)
        .run(primaryId, now, ...entityIds)
      getDb().prepare(`UPDATE memory_knowledge_assertions SET object_entity_id = ?, normalized_object_key = ?, updated_at = ? WHERE object_entity_id IN (${placeholders})`)
        .run(primaryId, `entity:${primaryId}`, now, ...entityIds)
      if (selfRelationshipIds.length) {
        const selfPlaceholders = selfRelationshipIds.map(() => '?').join(', ')
        getDb().prepare(`UPDATE memory_knowledge_assertions SET status = 'retired', updated_at = ? WHERE id IN (${selfPlaceholders})`)
          .run(now, ...selfRelationshipIds)
      }

      const activeAssertions = getDb().prepare(`
        SELECT id, subject_entity_id, predicate_id, normalized_object_key, status,
          importance, created_at, updated_at
        FROM memory_knowledge_assertions
        WHERE namespace_id = ? AND status IN ('active', 'disputed')
          AND (subject_entity_id = ? OR object_entity_id = ?)
        ORDER BY (status = 'active') DESC, importance DESC, updated_at DESC
      `).all(namespaceId, primaryId, primaryId) as Array<{
        id: string; subject_entity_id: string; predicate_id: string; normalized_object_key: string
        status: string; importance: number; created_at: number; updated_at: number
      }>
      const assertionGroups = new Map<string, typeof activeAssertions>()
      for (const assertion of activeAssertions) {
        const key = `${assertion.subject_entity_id}\u0000${assertion.predicate_id}\u0000${assertion.normalized_object_key}`
        assertionGroups.set(key, [...(assertionGroups.get(key) || []), assertion])
      }
      for (const group of assertionGroups.values()) {
        if (group.length < 2) continue
        const keeper = group[0]
        for (const duplicate of group.slice(1)) {
          const evidence = getDb().prepare(`
            SELECT id, run_id, text_unit_id, span_start, span_end
            FROM memory_knowledge_assertion_evidence WHERE assertion_id = ?
          `).all(duplicate.id) as Array<{ id: string; run_id: string; text_unit_id: string; span_start: number; span_end: number }>
          for (const item of evidence) {
            const existing = getDb().prepare(`
              SELECT id FROM memory_knowledge_assertion_evidence
              WHERE assertion_id = ? AND run_id = ? AND text_unit_id = ? AND span_start = ? AND span_end = ?
            `).get(keeper.id, item.run_id, item.text_unit_id, item.span_start, item.span_end) as { id: string } | undefined
            if (existing) getDb().prepare('DELETE FROM memory_knowledge_assertion_evidence WHERE id = ?').run(item.id)
            else getDb().prepare('UPDATE memory_knowledge_assertion_evidence SET assertion_id = ? WHERE id = ?').run(keeper.id, item.id)
          }
          getDb().prepare('UPDATE memory_knowledge_assertion_corrections SET assertion_id = ? WHERE assertion_id = ?').run(keeper.id, duplicate.id)
          getDb().prepare('UPDATE memory_knowledge_assertions SET superseded_by_id = ? WHERE superseded_by_id = ?').run(keeper.id, duplicate.id)
          getDb().prepare(`UPDATE memory_knowledge_assertions SET status = 'retired', superseded_by_id = ?, updated_at = ? WHERE id = ?`)
            .run(keeper.id, now, duplicate.id)
          retiredAssertionIds.add(duplicate.id)
          consolidatedAssertions++
        }
        getDb().prepare(`
          UPDATE memory_knowledge_assertions
          SET status = ?, importance = ?, created_at = ?, updated_at = ? WHERE id = ?
        `).run(
          group.some((item) => item.status === 'active') ? 'active' : 'disputed',
          Math.max(...group.map((item) => item.importance)),
          Math.min(...group.map((item) => item.created_at)),
          now,
          keeper.id,
        )
      }

      getDb().prepare(`DELETE FROM memory_knowledge_entity_aliases WHERE entity_id IN (${placeholders})`).run(...entityIds)
      const insertAlias = getDb().prepare(`
        INSERT INTO memory_knowledge_entity_aliases
          (id, entity_id, display_alias, normalized_alias, source, confidence, created_at)
        VALUES (?, ?, ?, ?, 'manual', 1, ?)
      `)
      for (const [normalizedAlias, displayAlias] of aliasesByNormalized) {
        insertAlias.run(nanoid(), primaryId, displayAlias, normalizedAlias, now)
      }
      getDb().prepare(`
        UPDATE memory_knowledge_entities
        SET canonical_name = ?, normalized_name = ?, updated_at = ? WHERE id = ?
      `).run(canonicalName, normalizedName, now, primaryId)
      const mergedIds = entityIds.filter((id) => id !== primaryId)
      if (mergedIds.length) {
        const mergedPlaceholders = mergedIds.map(() => '?').join(', ')
        getDb().prepare(`
          UPDATE memory_knowledge_entities
          SET status = 'merged', merged_into_id = ?, updated_at = ?
          WHERE id IN (${mergedPlaceholders})
        `).run(primaryId, now, ...mergedIds)
      }
    })()

    const retiredProjectionIds = [
      ...entityIds.filter((id) => id !== primaryId).map((id) => `knowledge-entity:${id}`),
      ...Array.from(retiredAssertionIds, (id) => `knowledge-assertion:${id}`),
    ]
    if (retiredProjectionIds.length) {
      await getRAGStore().deleteByIds(MEMORY_KNOWLEDGE_VECTOR_TABLE, retiredProjectionIds, {
        rebuildFts: false,
        throwOnError: false,
      })
    }
    await Promise.allSettled(activeRuns.map((run) => this.indexSearchProjection(run.id)))
    const entity = this.getNode(primaryId)
    if (!entity) throw new Error('ENTITY_MERGE_RESULT_MISSING')
    return {
      entity,
      mergedEntityIds: entityIds.filter((id) => id !== primaryId),
      consolidatedAssertions,
      retiredSelfRelationships: selfRelationshipIds.length,
    }
  }

  updateEntity(id: string, patch: { name?: string; type?: EntityType; aliases?: string[]; importance?: ImportanceLevel }): EntityNode | null {
    const existing = this.getNode(id)
    if (!existing) return null
    const nextName = cleanDisplay(patch.name || existing.name, 160)
    if (!nextName) throw new Error('ENTITY_NODE_INVALID_NAME')
    const db = getDb()
    const conflict = db.prepare(`SELECT id FROM memory_knowledge_entities WHERE namespace_id = (SELECT namespace_id FROM memory_knowledge_entities WHERE id = ?) AND normalized_name = ? AND entity_type = ? AND status = 'active' AND id != ?`)
      .get(id, normalize(nextName), patch.type || existing.type, id)
    if (conflict) throw new Error('ENTITY_NODE_CONFLICT')
    const now = Date.now()
    const activeRuns = db.prepare(`
      SELECT DISTINCT r.id FROM memory_knowledge_entity_mentions m
      JOIN memory_knowledge_index_runs r ON r.id = m.run_id AND r.status = 'active'
      WHERE m.entity_id = ?
    `).all(id) as Array<{ id: string }>
    db.transaction(() => {
      db.prepare(`UPDATE memory_knowledge_entities SET canonical_name = ?, normalized_name = ?, entity_type = ?, updated_at = ? WHERE id = ?`)
        .run(nextName, normalize(nextName), patch.type || existing.type, now, id)
      const insertAlias = db.prepare(`INSERT INTO memory_knowledge_entity_aliases (id, entity_id, display_alias, normalized_alias, source, confidence, created_at) VALUES (?, ?, ?, ?, 'manual', 1, ?) ON CONFLICT(entity_id, normalized_alias) DO UPDATE SET display_alias = excluded.display_alias, source = 'manual', confidence = 1`)
      for (const alias of Array.from(new Set([existing.name, nextName, ...(patch.aliases || [])].map((value) => cleanDisplay(value, 160)).filter(Boolean)))) {
        insertAlias.run(nanoid(), id, alias, normalize(alias), now)
      }
      if (patch.importance !== undefined) db.prepare(`UPDATE memory_knowledge_assertions SET importance = ?, updated_at = ? WHERE (subject_entity_id = ? OR object_entity_id = ?) AND status IN ('active', 'disputed')`).run(patch.importance, now, id, id)
      if (activeRuns[0]) db.prepare(`
        INSERT INTO memory_knowledge_entity_resolution_decisions
          (id, run_id, surface, normalized_surface, entity_type, identity_hint,
           selected_entity_id, candidate_ids_json, decision, confidence, rationale, created_at)
        VALUES (?, ?, ?, ?, ?, '', ?, ?, 'manual', 1, 'manual entity correction', ?)
      `).run(nanoid(), activeRuns[0].id, nextName, normalize(nextName), patch.type || existing.type, id, JSON.stringify([id]), now)
    })()
    for (const run of activeRuns) void this.indexSearchProjection(run.id).catch(() => undefined)
    return this.getNode(id)
  }

  retractEntityById(id: string): boolean {
    return this.retractEntitiesByIds([id]) === 1
  }

  retractEntitiesByIds(values: string[]): number {
    const ids = Array.from(new Set(values.map((id) => id.trim()).filter(Boolean))).slice(0, 500)
    if (!ids.length) return 0
    const now = Date.now()
    const db = getDb()
    const placeholders = ids.map(() => '?').join(', ')
    const activeEntities = db.prepare(`
      SELECT id FROM memory_knowledge_entities
      WHERE id IN (${placeholders}) AND status = 'active'
    `).all(...ids) as Array<{ id: string }>
    if (activeEntities.length !== ids.length) return 0
    const assertions = db.prepare(`
      SELECT id, predicate_id FROM memory_knowledge_assertions
      WHERE (subject_entity_id IN (${placeholders}) OR object_entity_id IN (${placeholders}))
        AND status IN ('active', 'disputed')
    `).all(...ids, ...ids) as Array<{ id: string; predicate_id: string }>
    const activeRuns = db.prepare(`
      SELECT DISTINCT r.id FROM memory_knowledge_index_runs r
      WHERE r.status = 'active' AND (
        EXISTS (SELECT 1 FROM memory_knowledge_entity_mentions m WHERE m.run_id = r.id AND m.entity_id IN (${placeholders}))
        OR EXISTS (
          SELECT 1 FROM memory_knowledge_assertion_evidence ev
          JOIN memory_knowledge_assertions a ON a.id = ev.assertion_id
          WHERE ev.run_id = r.id
            AND (a.subject_entity_id IN (${placeholders}) OR a.object_entity_id IN (${placeholders}))
        )
      )
    `).all(...ids, ...ids, ...ids) as Array<{ id: string }>
    db.transaction(() => {
      for (const assertion of assertions) db.prepare(`
        INSERT INTO memory_knowledge_assertion_corrections
          (id, assertion_id, action, prior_predicate_id, predicate_id, rationale, created_at)
        VALUES (?, ?, 'retract', ?, ?, 'manual entity retraction', ?)
      `).run(nanoid(), assertion.id, assertion.predicate_id, assertion.predicate_id, now)
      db.prepare(`
        UPDATE memory_knowledge_assertions SET status = 'retracted', updated_at = ?
        WHERE (subject_entity_id IN (${placeholders}) OR object_entity_id IN (${placeholders}))
          AND status IN ('active', 'disputed')
      `).run(now, ...ids, ...ids)
      db.prepare(`UPDATE memory_knowledge_entities SET status = 'retired', updated_at = ? WHERE id IN (${placeholders})`)
        .run(now, ...ids)
    })()
    for (const run of activeRuns) void this.indexSearchProjection(run.id).catch(() => undefined)
    return ids.length
  }

  updateEdge(id: string, patch: { relation?: string; note?: string; importance?: ImportanceLevel }): EntityEdge | null {
    if (!this.getEdge(id)) return null
    this.correctRelationship(id, patch)
    return this.getEdge(id)
  }

  deleteEdge(id: string, spaceIds: string[] = []): DeleteEdgeResult {
    const deleted = this.deleteEdgesByIds([id], spaceIds)
    return { edgeDeleted: deleted === 1, orphanedNodeIds: [] }
  }

  deleteEdgesByIds(values: string[], spaceIds: string[] = []): number {
    const ids = Array.from(new Set(values.map((id) => id.trim()).filter(Boolean))).slice(0, 1000)
    if (!ids.length) return 0
    const db = getDb()
    const placeholders = ids.map(() => '?').join(', ')
    const assertions = db.prepare(`
      SELECT id, predicate_id FROM memory_knowledge_assertions
      WHERE id IN (${placeholders}) AND status IN ('active', 'disputed')
    `).all(...ids) as Array<{ id: string; predicate_id: string }>
    if (assertions.length !== ids.length) return 0
    if (spaceIds.length) {
      const scopePlaceholders = spaceIds.map(() => '?').join(', ')
      const allowed = Number((db.prepare(`
        SELECT COUNT(DISTINCT ev.assertion_id) AS count
        FROM memory_knowledge_assertion_evidence ev
        JOIN memory_knowledge_index_runs r ON r.id = ev.run_id AND r.status = 'active'
        WHERE ev.assertion_id IN (${placeholders}) AND r.space_id IN (${scopePlaceholders})
      `).get(...ids, ...spaceIds) as { count: number }).count)
      if (allowed !== ids.length) return 0
    }
    const activeRuns = db.prepare(`
      SELECT DISTINCT r.id FROM memory_knowledge_assertion_evidence ev
      JOIN memory_knowledge_index_runs r ON r.id = ev.run_id AND r.status = 'active'
      WHERE ev.assertion_id IN (${placeholders})
    `).all(...ids) as Array<{ id: string }>
    const now = Date.now()
    db.transaction(() => {
      const addCorrection = db.prepare(`
        INSERT INTO memory_knowledge_assertion_corrections
          (id, assertion_id, action, prior_predicate_id, predicate_id, rationale, created_at)
        VALUES (?, ?, 'retract', ?, ?, 'manual graph correction', ?)
      `)
      for (const assertion of assertions) {
        addCorrection.run(nanoid(), assertion.id, assertion.predicate_id, assertion.predicate_id, now)
      }
      db.prepare(`
        UPDATE memory_knowledge_assertions SET status = 'retracted', updated_at = ?
        WHERE id IN (${placeholders})
      `).run(now, ...ids)
    })()
    for (const run of activeRuns) void this.indexSearchProjection(run.id).catch((error) => {
      console.warn('[memory] Failed to refresh a manually corrected knowledge projection:', error)
    })
    return ids.length
  }

  deleteMatchingEdge(fromName: string, relation: string, toName: string, spaceIds: string[]): DeleteEdgeResult {
    const normalizedRelation = this.resolvePredicate(relation)
    const row = this.graph.graphRows(spaceIds, 5000).find((candidate) => normalize(candidate.subject_name) === normalize(fromName) && normalize(candidate.object_name) === normalize(toName) && String(candidate.canonical_name) === normalizedRelation)
    return row ? this.deleteEdge(String(row.id), spaceIds) : { edgeDeleted: false, orphanedNodeIds: [] }
  }

  assertRelationship(opts: {
    spaceId: string
    from: KnowledgeExtractedEntity
    relation: string
    to: KnowledgeExtractedEntity
    importance?: ImportanceLevel
    note?: string
  }): EntityEdge {
    this.ensurePredicateRegistry()
    const db = getDb()
    const now = Date.now()
    const runId = `manual-knowledge:${opts.spaceId}`
    const documentId = `manual-relationships:${opts.spaceId}`
    const sourceId = `manual:${opts.spaceId}:relationship-assertions`
    const contentHash = 'manual-knowledge-v1'
    const relation = this.resolvePredicate(opts.relation)
    const note = cleanDisplay(opts.note, 600) || `${opts.from.name} ${relation.replace(/_/g, ' ')} ${opts.to.name}.`
    let assertionId = ''

    db.transaction(() => {
      db.prepare(`
        INSERT INTO memory_knowledge_index_runs
          (id, document_id, content_hash, space_id, file_name, source_id, pipeline_version,
           prompt_version, extractor_provider_id, extractor_model, status, started_at,
           completed_at, activated_at, search_projection_status)
        VALUES (?, ?, ?, ?, 'Manual relationships', ?, ?, ?, '', '', 'active', ?, ?, ?, 'pending')
        ON CONFLICT(id) DO UPDATE SET status = 'active', activated_at = excluded.activated_at,
          search_projection_status = 'pending'
      `).run(runId, documentId, contentHash, opts.spaceId, sourceId,
        MEMORY_KNOWLEDGE_PIPELINE_VERSION, MEMORY_KNOWLEDGE_PROMPT_VERSION, now, now, now)

      const subject = this.resolveEntity({ runId, namespaceId: opts.spaceId, documentId, entity: opts.from, now })
      const object = this.resolveEntity({ runId, namespaceId: opts.spaceId, documentId, entity: opts.to, now })
      if (!subject || !object) throw new Error('KNOWLEDGE_ENTITY_INVALID')
      const objectKey = `entity:${object.id}`
      const existing = db.prepare(`
        SELECT id FROM memory_knowledge_assertions
        WHERE namespace_id = ? AND subject_entity_id = ? AND predicate_id = ?
          AND normalized_object_key = ? AND status IN ('active', 'disputed', 'retired', 'retracted')
        ORDER BY updated_at DESC LIMIT 1
      `).get(opts.spaceId, subject.id, relation, objectKey) as { id: string } | undefined
      assertionId = existing?.id || nanoid()
      if (existing) {
        db.prepare(`UPDATE memory_knowledge_assertions SET status = 'active', importance = MAX(importance, ?), updated_at = ? WHERE id = ?`)
          .run(opts.importance ?? 2, now, assertionId)
      } else {
        db.prepare(`
          INSERT INTO memory_knowledge_assertions
            (id, namespace_id, subject_entity_id, predicate_id, object_entity_id, object_value_json,
             normalized_object_key, status, importance, observed_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?, 'active', ?, ?, ?, ?)
        `).run(assertionId, opts.spaceId, subject.id, relation, object.id, objectKey, opts.importance ?? 2, now, now, now)
      }

      const chunkIndex = Number((db.prepare(`SELECT COALESCE(MAX(chunk_index), -1) + 1 AS next FROM memory_knowledge_text_units WHERE run_id = ?`).get(runId) as { next: number }).next)
      const textUnitId = nanoid()
      db.prepare(`
        INSERT INTO memory_knowledge_text_units
          (id, run_id, document_id, content_hash, space_id, file_name, chunk_index, text,
           text_hash, document_title, section_path, created_at)
        VALUES (?, ?, ?, ?, ?, 'Manual relationships', ?, ?, ?, 'Manual relationships', 'Assertions', ?)
      `).run(textUnitId, runId, documentId, contentHash, opts.spaceId, chunkIndex, note,
        createHash('sha256').update(note).digest('hex'), now)
      db.prepare(`
        INSERT INTO memory_knowledge_assertion_evidence
          (id, assertion_id, run_id, text_unit_id, quote, span_start, span_end,
           extractor_confidence, entity_resolution_confidence, source_trust,
           entailment_score, quote_verified, note, pipeline_version, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 1, NULL, 1, ?, ?, ?)
      `).run(nanoid(), assertionId, runId, textUnitId, '', 0,
        1, Math.min(subject.confidence, object.confidence), note, MEMORY_KNOWLEDGE_PIPELINE_VERSION, now)

      const addMention = db.prepare(`
        INSERT OR IGNORE INTO memory_knowledge_entity_mentions
          (id, run_id, text_unit_id, entity_id, surface, normalized_surface, entity_type,
           span_start, span_end, resolution_confidence, resolution_status, context_text, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)
      `)
      for (const [entity, resolved] of [[opts.from, subject], [opts.to, object]] as const) {
        const span = note.toLocaleLowerCase().indexOf(entity.name.toLocaleLowerCase())
        addMention.run(nanoid(), runId, textUnitId, resolved.id, entity.name, normalize(entity.name), entity.type || 'other',
          span < 0 ? null : span, span < 0 ? null : span + entity.name.length, resolved.confidence, note, note, now)
      }
    })()

    void this.indexSearchProjection(runId).catch((error) => console.warn('[memory] Failed to index manual knowledge assertion:', error))
    const edge = this.getEdge(assertionId)
    if (!edge) throw new Error('KNOWLEDGE_ASSERTION_NOT_PUBLISHED')
    return edge
  }

  async reset(): Promise<{ nodesDeleted: number; edgesDeleted: number }> {
    const before = this.graphStats()
    this.resetGeneration++
    cancelMemoryIndexJobsByKind('entity-index')
    const db = getDb()
    db.transaction(() => {
      db.prepare(`DELETE FROM memory_knowledge_assertion_corrections`).run()
      db.prepare(`DELETE FROM memory_knowledge_assertion_evidence`).run()
      db.prepare(`DELETE FROM memory_knowledge_assertions`).run()
      db.prepare(`DELETE FROM memory_knowledge_entity_mentions`).run()
      db.prepare(`DELETE FROM memory_knowledge_entity_resolution_decisions`).run()
      db.prepare(`DELETE FROM memory_knowledge_entity_aliases`).run()
      db.prepare(`DELETE FROM memory_knowledge_entities`).run()
      db.prepare(`DELETE FROM memory_knowledge_text_units`).run()
      db.prepare(`DELETE FROM memory_knowledge_index_runs`).run()
      db.prepare(`DELETE FROM memory_index_jobs WHERE kind = 'entity-index'`).run()
      db.prepare(`UPDATE memory_file_index SET entity_indexed_at = 0, tags_json = '[]'`).run()
    })()
    getEventBus().emit('memory:graph-reset', { resetAt: Date.now() })
    await getRAGStore().deleteTable(MEMORY_KNOWLEDGE_VECTOR_TABLE)
    return { nodesDeleted: before.nodeCount, edgesDeleted: before.edgeCount }
  }

  formatWalk(walk: GraphWalkResult): string {
    if (!walk.edges.length) return ''
    return '## Source-grounded relationships\n' + walk.edges.map((edge) => {
      const status = edge.assertionStatus === 'disputed' ? ' [disputed]' : ''
      const source = edge.sourceDocumentId ? ` [document=${edge.sourceDocumentId}${edge.sourceChunkIndex === undefined ? '' : `, part=${edge.sourceChunkIndex + 1}`}]` : ''
      const note = edge.note ? ` Note: ${edge.note}` : ''
      return `- ${edge.fromName} --${edge.relation}--> ${edge.toName}${status}.${note}${source}`
    }).join('\n')
  }

  private correctRelationship(
    assertionId: string,
    patch: { relation?: string; note?: string; importance?: ImportanceLevel; retract?: boolean },
  ): number {
    const db = getDb()
    const assertions = db.prepare(`
      SELECT DISTINCT a.id, a.predicate_id, r.id AS run_id,
        se.canonical_name AS subject_name,
        COALESCE(oe.canonical_name, a.object_value_json) AS object_name
      FROM memory_knowledge_assertions a
      JOIN memory_knowledge_entities se ON se.id = a.subject_entity_id
      LEFT JOIN memory_knowledge_entities oe ON oe.id = a.object_entity_id
      JOIN memory_knowledge_assertion_evidence ev ON ev.assertion_id = a.id
      JOIN memory_knowledge_index_runs r ON r.id = ev.run_id AND r.status = 'active'
      WHERE a.status IN ('active', 'disputed')
        AND a.id = ?
    `).all(assertionId) as Array<{ id: string; predicate_id: string; run_id: string; subject_name: string; object_name: string }>
    if (!assertions.length) return 0
    const nextPredicate = patch.relation ? this.resolvePredicate(patch.relation) : undefined
    const now = Date.now()
    db.transaction(() => {
      for (const assertion of assertions) {
        db.prepare(`
          INSERT INTO memory_knowledge_assertion_corrections
            (id, assertion_id, action, prior_predicate_id, predicate_id, evidence_text,
             confidence, importance, rationale, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual graph correction', ?)
        `).run(nanoid(), assertion.id, patch.retract ? 'retract' : 'update', assertion.predicate_id,
          nextPredicate || assertion.predicate_id,
          patch.note === undefined && patch.relation
            ? `Manual correction: ${assertion.subject_name} ${String(nextPredicate || assertion.predicate_id).replace(/_/g, ' ')} ${formatLiteral(assertion.object_name)}.`
            : patch.note === undefined ? null : cleanDisplay(patch.note, 1000),
          null, patch.importance ?? null, now)
        db.prepare(`
          UPDATE memory_knowledge_assertions SET
            predicate_id = COALESCE(?, predicate_id),
            importance = COALESCE(?, importance),
            status = CASE WHEN ? = 1 THEN 'retracted' ELSE status END,
            updated_at = ?
          WHERE id = ?
        `).run(nextPredicate || null, patch.importance ?? null, patch.retract ? 1 : 0, now, assertion.id)
      }
    })()
    for (const runId of new Set(assertions.map((assertion) => assertion.run_id))) {
      void this.indexSearchProjection(runId).catch((error) => {
        console.warn('[memory] Failed to refresh a manually corrected knowledge projection:', error)
      })
    }
    return assertions.length
  }

  filterManuallySupersededChunks(chunks: RetrievedChunk[]): RetrievedChunk[] {
    const db = getDb()
    const schemaExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_knowledge_assertion_corrections'`).get()
    if (!schemaExists) return chunks
    const isSuperseded = db.prepare(`
      SELECT 1
      FROM memory_knowledge_assertion_evidence ev
      JOIN memory_knowledge_assertion_corrections c ON c.assertion_id = ev.assertion_id
      JOIN memory_knowledge_index_runs r ON r.id = ev.run_id AND r.status = 'active'
      JOIN memory_knowledge_text_units tu ON tu.id = ev.text_unit_id
      WHERE r.document_id = ? AND r.content_hash = ? AND tu.chunk_index = ?
      LIMIT 1
    `)
    return chunks.filter((chunk) => {
      if (!chunk.documentId || !chunk.revision || chunk.chunkIndex === undefined) return true
      return !isSuperseded.get(chunk.documentId, chunk.revision, chunk.chunkIndex)
    })
  }

  private resolveQuerySeedNodes(
    query: string,
    spaceIds: string[],
    opts: { allowAmbiguousExactMatches?: boolean } = {},
  ): EntityNode[] {
    const scopes = Array.from(new Set(spaceIds.filter(Boolean)))
    if (!scopes.length) return []
    const rows = getDb().prepare(`
      SELECT e.*, GROUP_CONCAT(DISTINCT a.normalized_alias) AS normalized_aliases
      FROM memory_knowledge_entities e
      JOIN memory_knowledge_entity_mentions m ON m.entity_id = e.id
      JOIN memory_knowledge_index_runs r ON r.id = m.run_id AND r.status = 'active'
      LEFT JOIN memory_knowledge_entity_aliases a ON a.entity_id = e.id
      WHERE e.status = 'active' AND r.space_id IN (${scopes.map(() => '?').join(', ')})
      GROUP BY e.id
      ORDER BY e.updated_at DESC
    `).all(...scopes) as Array<Record<string, unknown>>
    const normalizedQueryValue = normalize(query).replace(/[._-]+/g, ' ')
    const normalizedQuery = ` ${normalizedQueryValue} `
    const isSingleTermQuery = normalizedQueryValue.split(' ').filter(Boolean).length === 1
    const terms = new Set(queryTerms(query))
    const tokenOwners = new Map<string, Set<string>>()
    const surfacesById = new Map<string, string[]>()

    for (const row of rows) {
      const id = String(row.id)
      const aliases = String(row.normalized_aliases || '').split(',').filter(Boolean)
      const surfaces = [String(row.normalized_name), ...aliases]
        .map((surface) => normalize(surface).replace(/[._-]+/g, ' '))
        .filter(Boolean)
      surfacesById.set(id, surfaces)
      for (const token of new Set(surfaces.flatMap((surface) => surface.split(' ')).filter((token) => token.length >= 4))) {
        tokenOwners.set(token, new Set([...(tokenOwners.get(token) || []), id]))
      }
    }

    const exactMatches = rows.filter((row) => {
      const id = String(row.id)
      const surfaces = surfacesById.get(id) || []
      // A focused one-term lookup should return every entity with that exact
      // name or alias. Duplicate names remain separate identities, but they
      // must not make the name itself undiscoverable.
      if (isSingleTermQuery && surfaces.includes(normalizedQueryValue)) return true
      return surfaces.some((surface) => {
        if (!normalizedQuery.includes(` ${surface} `)) return false
        return surface.includes(' ') || opts.allowAmbiguousExactMatches === true || tokenOwners.get(surface)?.size === 1
      })
    })
    if (exactMatches.length) {
      return exactMatches.slice(0, 8).map((row) => this.graph.hydrateGraphNode(row))
    }

    return rows.filter((row) => {
      const id = String(row.id)
      const surfaces = surfacesById.get(id) || []
      return surfaces.some((surface) => {
        const surfaceTerms = surface.split(' ').filter((term) => term.length >= 4)
        if (surfaceTerms.length > 1 && surfaceTerms.every((term) => terms.has(term))) return true
        return surfaceTerms.some((term) => terms.has(term) && tokenOwners.get(term)?.size === 1)
      })
    }).slice(0, 8).map((row) => this.graph.hydrateGraphNode(row))
  }

  private async retrieveKnowledgeCandidates(query: string, scopes: string[], limit: number): Promise<SearchResult[]> {
    try {
      const reranker = getMemoryReranker()
      const candidateCount = Math.min(100, Math.max(24, reranker.getCandidateCount(limit * 4)))
      const embedding = await getEmbeddingProvider().embed(query)
      const rag = getRAGStore()
      const filter = lanceDbInFilter('spaceId', scopes)
      const [dense, lexical] = await Promise.all([
        rag.search(MEMORY_KNOWLEDGE_VECTOR_TABLE, embedding.vector, candidateCount, filter),
        rag.lexicalSearch(MEMORY_KNOWLEDGE_VECTOR_TABLE, query, candidateCount, filter),
      ])
      const fused = fuseRetrievalChannels([dense, lexical], candidateCount)
      const reranked = await reranker.rerank(query, fused, Math.min(fused.length, Math.max(16, limit * 3)))
        .catch(() => fused.slice(0, Math.max(16, limit * 3)))
      const hasRerankerScores = reranked.some((candidate) => typeof candidate.rerankerScore === 'number')
      if (hasRerankerScores) return reranked

      // Reranking is optional. The mandatory fallback gate retains lexical
      // hits and only a narrow, sufficiently similar dense neighborhood.
      const bestDense = Math.max(...reranked.map((candidate) => candidate.denseScore || 0), 0)
      const denseThreshold = Math.max(0.5, bestDense - 0.08)
      return reranked.filter((candidate) =>
        (typeof candidate.lexicalScore === 'number' && candidate.lexicalScore > 0)
        || (typeof candidate.denseScore === 'number' && candidate.denseScore >= denseThreshold),
      )
    } catch {
      return []
    }
  }

  async search(
    query: string,
    spaceIds: string[],
    limit = 8,
    opts: { depth?: number; allowAmbiguousExactMatches?: boolean } = {},
  ): Promise<KnowledgeSearchResult> {
    const terms = queryTerms(query)
    const scopes = Array.from(new Set(spaceIds.filter(Boolean)))
    if (!terms.length || !scopes.length) return { sourceChunks: [] }
    const depth = Math.max(1, Math.min(3, Math.floor(opts.depth || 1)))
    const exactSeedNodes = this.resolveQuerySeedNodes(query, scopes, {
      allowAmbiguousExactMatches: opts.allowAmbiguousExactMatches,
    })
    const exactSeedIds = new Set(exactSeedNodes.map((node) => node.id))
    const vectorAssertionIds = new Set<string>()
    const vectorEntityIds = new Set<string>()
    const candidateScores = new Map<string, number>()
    const knowledgeCandidates = exactSeedIds.size
      ? []
      : await this.retrieveKnowledgeCandidates(query, scopes, limit)
    knowledgeCandidates.forEach((candidate, index) => {
      const reference = candidate.sourceFile || ''
      const relevance = candidateRelevance(candidate, index, knowledgeCandidates.length)
      if (reference.startsWith('assertion:')) {
        const id = reference.slice('assertion:'.length)
        vectorAssertionIds.add(id)
        candidateScores.set(id, Math.max(candidateScores.get(id) || 0, relevance))
      }
      if (reference.startsWith('entity:')) {
        const id = reference.slice('entity:'.length)
        vectorEntityIds.add(id)
        candidateScores.set(id, Math.max(candidateScores.get(id) || 0, relevance))
      }
    })
    // Exact name/alias resolution is authoritative for focused lookups.
    // Semantic entity neighbors may seed a search only when no exact entity
    // could be resolved.
    if (exactSeedIds.size) {
      vectorEntityIds.clear()
    } else {
      const strongestSemanticEntities = [...vectorEntityIds]
        .sort((a, b) => (candidateScores.get(b) || 0) - (candidateScores.get(a) || 0))
        .slice(0, 3)
      vectorEntityIds.clear()
      for (const id of strongestSemanticEntities) vectorEntityIds.add(id)
    }
    const strongestSemanticAssertions = [...vectorAssertionIds]
      .sort((a, b) => (candidateScores.get(b) || 0) - (candidateScores.get(a) || 0))
      .slice(0, Math.max(8, limit * 2))
    vectorAssertionIds.clear()
    for (const id of strongestSemanticAssertions) vectorAssertionIds.add(id)
    const focusedSeedIds = exactSeedIds.size ? exactSeedIds : vectorEntityIds
    const scopePlaceholders = scopes.map(() => '?').join(', ')
    const historicalQuery = /\b(former(?:ly)?|histor(?:y|ical)|previous(?:ly)?|used to|before|when|damals|ehemals|früher|historisch|vorher|wann|war)\b/iu.test(query)
    const validityClause = historicalQuery ? '' : 'AND (a.valid_from IS NULL OR a.valid_from <= ?) AND (a.valid_to IS NULL OR a.valid_to >= ?)'
    const validityArgs = historicalQuery ? [] : [Date.now(), Date.now()]
    const likeClause = terms.map(() => `(
      e.normalized_name LIKE ? ESCAPE '\\' OR oe.normalized_name LIKE ? ESCAPE '\\'
      OR replace(p.canonical_name, '_', ' ') LIKE ? ESCAPE '\\'
      OR lower(ev.note) LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM memory_knowledge_entity_aliases ea WHERE ea.entity_id IN (e.id, oe.id) AND ea.normalized_alias LIKE ? ESCAPE '\\')
    )`).join(' OR ')
    const likeArgs = terms.flatMap((term) => Array(5).fill(`%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`))
    const vectorClauses: string[] = []
    const vectorArgs: string[] = []
    if (vectorAssertionIds.size) {
      vectorClauses.push(`a.id IN (${Array.from(vectorAssertionIds).map(() => '?').join(', ')})`)
      vectorArgs.push(...vectorAssertionIds)
    }
    if (vectorEntityIds.size) {
      vectorClauses.push(`(a.subject_entity_id IN (${Array.from(vectorEntityIds).map(() => '?').join(', ')}) OR a.object_entity_id IN (${Array.from(vectorEntityIds).map(() => '?').join(', ')}))`)
      vectorArgs.push(...vectorEntityIds, ...vectorEntityIds)
    }
    const relevanceClause = vectorClauses.length ? `((${likeClause}) OR ${vectorClauses.join(' OR ')})` : `(${likeClause})`
    let rows: Array<Record<string, unknown>> = focusedSeedIds.size ? [] : getDb().prepare(`
      SELECT a.*, p.canonical_name, p.aliases_json,
        e.canonical_name AS subject_name, e.normalized_name AS subject_normalized, e.entity_type AS subject_type,
        e.created_at AS subject_created_at, e.updated_at AS subject_updated_at,
        oe.canonical_name AS object_name, oe.normalized_name AS object_normalized, oe.entity_type AS object_type,
        oe.created_at AS object_created_at, oe.updated_at AS object_updated_at,
        ev.note AS extraction_note, ev.extractor_confidence, ev.entity_resolution_confidence, ev.source_trust,
        ev.entailment_score, c.evidence_text AS correction_evidence, c.confidence AS manual_confidence,
        ev.text_unit_id, tu.text AS source_text, tu.chunk_index,
        tu.document_title, tu.section_path, tu.text_hash, r.space_id, r.file_name,
        r.document_id, r.content_hash, r.source_id, r.activated_at
      FROM memory_knowledge_assertions a
      JOIN memory_knowledge_predicates p ON p.id = a.predicate_id
      JOIN memory_knowledge_entities e ON e.id = a.subject_entity_id
      LEFT JOIN memory_knowledge_entities oe ON oe.id = a.object_entity_id
      JOIN memory_knowledge_assertion_evidence ev ON ev.assertion_id = a.id AND ev.quote_verified = 1
      JOIN memory_knowledge_text_units tu ON tu.id = ev.text_unit_id
      LEFT JOIN memory_knowledge_assertion_corrections c ON c.id = (
        SELECT correction.id FROM memory_knowledge_assertion_corrections correction
        WHERE correction.assertion_id = a.id ORDER BY correction.created_at DESC LIMIT 1
      )
      JOIN memory_knowledge_index_runs r ON r.id = ev.run_id AND r.status = 'active'
      WHERE a.status IN ('active', 'disputed') AND r.space_id IN (${scopePlaceholders})
        ${validityClause}
        AND ${relevanceClause}
      ORDER BY a.importance DESC, ev.source_trust DESC, ev.extractor_confidence DESC, r.activated_at DESC
      LIMIT 400
    `).all(...scopes, ...validityArgs, ...likeArgs, ...vectorArgs) as Array<Record<string, unknown>>

    const hopByAssertionId = new Map<string, number>()
    if (focusedSeedIds.size) {
      const now = Date.now()
      const allRows = this.graph.graphRows(scopes, 10_000).filter((row) => historicalQuery || (
        (row.valid_from == null || Number(row.valid_from) <= now)
        && (row.valid_to == null || Number(row.valid_to) >= now)
      ))
      const included = new Set(focusedSeedIds)
      let frontier = new Set(focusedSeedIds)
      const focusedRows = new Map<string, Record<string, unknown>>()
      for (let hop = 1; hop <= depth && frontier.size; hop++) {
        const next = new Set<string>()
        for (const row of allRows) {
          const subjectId = String(row.subject_entity_id)
          const objectId = row.object_entity_id ? String(row.object_entity_id) : ''
          if (!frontier.has(subjectId) && (!objectId || !frontier.has(objectId))) continue
          const id = String(row.id)
          focusedRows.set(id, row)
          hopByAssertionId.set(id, Math.min(hopByAssertionId.get(id) || hop, hop))
          if (!included.has(subjectId)) next.add(subjectId)
          if (objectId && !included.has(objectId)) next.add(objectId)
        }
        for (const id of next) included.add(id)
        frontier = next
      }
      rows = [...focusedRows.values()]
    }

    let graphRanks = new Map<string, number>()
    if (requestsRelationalTraversal(query) && !focusedSeedIds.size) {
      const traversalRows = getDb().prepare(`
        SELECT a.*, p.canonical_name, p.aliases_json,
          e.canonical_name AS subject_name, e.normalized_name AS subject_normalized, e.entity_type AS subject_type,
          e.created_at AS subject_created_at, e.updated_at AS subject_updated_at,
          oe.canonical_name AS object_name, oe.normalized_name AS object_normalized, oe.entity_type AS object_type,
          oe.created_at AS object_created_at, oe.updated_at AS object_updated_at,
          ev.note AS extraction_note, ev.extractor_confidence, ev.entity_resolution_confidence, ev.source_trust,
          ev.entailment_score, c.evidence_text AS correction_evidence, c.confidence AS manual_confidence,
          ev.text_unit_id, tu.text AS source_text, tu.chunk_index,
          tu.document_title, tu.section_path, tu.text_hash, r.space_id, r.file_name,
          r.document_id, r.content_hash, r.source_id, r.activated_at
        FROM memory_knowledge_assertions a
        JOIN memory_knowledge_predicates p ON p.id = a.predicate_id
        JOIN memory_knowledge_entities e ON e.id = a.subject_entity_id
        LEFT JOIN memory_knowledge_entities oe ON oe.id = a.object_entity_id
        JOIN memory_knowledge_assertion_evidence ev ON ev.assertion_id = a.id AND ev.quote_verified = 1
        JOIN memory_knowledge_text_units tu ON tu.id = ev.text_unit_id
        LEFT JOIN memory_knowledge_assertion_corrections c ON c.id = (
          SELECT correction.id FROM memory_knowledge_assertion_corrections correction
          WHERE correction.assertion_id = a.id ORDER BY correction.created_at DESC LIMIT 1
        )
        JOIN memory_knowledge_index_runs r ON r.id = ev.run_id AND r.status = 'active'
        WHERE a.status IN ('active', 'disputed') AND r.space_id IN (${scopePlaceholders})
          ${validityClause}
        ORDER BY a.importance DESC, r.activated_at DESC
        LIMIT 3000
      `).all(...scopes, ...validityArgs) as Array<Record<string, unknown>>
      const seedIds = new Set(vectorEntityIds)
      const normalizedQuery = normalize(query)
      for (const row of traversalRows) {
        if (normalizedQuery.includes(String(row.subject_normalized))) seedIds.add(String(row.subject_entity_id))
        if (row.object_entity_id && normalizedQuery.includes(String(row.object_normalized))) seedIds.add(String(row.object_entity_id))
      }
      graphRanks = personalizedAssertionRanks(traversalRows, seedIds)
      const existingIds = new Set(rows.map((row) => String(row.id)))
      const expansion = traversalRows
        .filter((row) => !existingIds.has(String(row.id)) && (graphRanks.get(String(row.id)) || 0) >= 0.08)
        .sort((a, b) => (graphRanks.get(String(b.id)) || 0) - (graphRanks.get(String(a.id)) || 0))
        .slice(0, 24)
      rows = [...rows, ...expansion]
    }

    const normalizedQuery = normalize(query)
    const predicateIntents = requestedPredicates(query)
    const scored = rows.map((row) => {
      const predicate = String(row.canonical_name).replace(/_/g, ' ')
      const effectiveNote = row.correction_evidence || row.extraction_note || ''
      const haystack = normalize(`${row.subject_name} ${row.object_name || row.object_value_json || ''} ${predicate} ${effectiveNote}`)
      const matched = terms.filter((term) => haystack.includes(term)).length
      const touchesSeed = focusedSeedIds.has(String(row.subject_entity_id)) || focusedSeedIds.has(String(row.object_entity_id))
      const endpointBoost = touchesSeed
        ? exactSeedIds.size ? 0.45 : 0.35
        : [row.subject_normalized, row.object_normalized].some((name) => name && normalizedQuery.includes(String(name))) ? 0.25 : 0
      const predicateBoost = predicateIntents.has(String(row.canonical_name))
        ? 0.45
        : normalizedQuery.includes(normalize(predicate)) ? 0.2 : 0
      const relevance = matched / Math.max(1, terms.length)
      const semanticRelevance = Math.max(
        candidateScores.get(String(row.id)) || 0,
        candidateScores.get(String(row.subject_entity_id)) || 0,
        candidateScores.get(String(row.object_entity_id)) || 0,
      )
      const vectorBoost = semanticRelevance * 0.3
      const extractionConfidence = row.manual_confidence == null ? Number(row.extractor_confidence) : Number(row.manual_confidence)
      const evidenceQuality = 0.4 * extractionConfidence + 0.35 * Number(row.entity_resolution_confidence) + 0.25 * Number(row.source_trust)
      const graphBoost = (graphRanks.get(String(row.id)) || 0) * 0.2
      const hopPenalty = Math.max(0, (hopByAssertionId.get(String(row.id)) || 1) - 1) * 0.2
      return { row, score: relevance * 0.35 + evidenceQuality * 0.1 + endpointBoost + predicateBoost + vectorBoost + graphBoost - hopPenalty }
    }).sort((a, b) => b.score - a.score || Number(b.row.importance) - Number(a.row.importance))

    const selected = new Map<string, { row: Record<string, unknown>; score: number }>()
    for (const entry of scored) if (!selected.has(String(entry.row.id))) selected.set(String(entry.row.id), entry)
    const chosenEntries = Array.from(selected.values())
      .filter((entry) => focusedSeedIds.size > 0 || entry.score >= 0.4)
      .slice(0, Math.max(1, limit))
    const chosen = chosenEntries.map((entry) => entry.row)
    const chosenScores = new Map(chosenEntries.map((entry) => [String(entry.row.id), clamp(entry.score)]))
    const nodes = new Map<string, EntityNode>()
    const edges: EntityEdge[] = []
    const sourceChunks = new Map<string, RetrievedChunk>()
    const mentionLikeClause = terms.map(() => `(
      e.normalized_name LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM memory_knowledge_entity_aliases ea WHERE ea.entity_id = e.id AND ea.normalized_alias LIKE ? ESCAPE '\\')
    )`).join(' OR ')
    const mentionLikeArgs = terms.flatMap((term) => Array(2).fill(`%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`))
    const entityVectorClause = vectorEntityIds.size
      ? `OR e.id IN (${Array.from(vectorEntityIds).map(() => '?').join(', ')})`
      : ''
    const mentionRows = getDb().prepare(`
      SELECT DISTINCT e.id, e.canonical_name, e.normalized_name, e.entity_type,
        e.created_at, e.updated_at, m.resolution_confidence, m.text_unit_id,
        tu.text AS source_text, tu.text_hash, tu.chunk_index, tu.document_title,
        tu.section_path, r.space_id, r.file_name, r.document_id, r.content_hash
      FROM memory_knowledge_entity_mentions m
      JOIN memory_knowledge_entities e ON e.id = m.entity_id AND e.status = 'active'
      JOIN memory_knowledge_text_units tu ON tu.id = m.text_unit_id
      JOIN memory_knowledge_index_runs r ON r.id = m.run_id AND r.status = 'active'
      WHERE r.space_id IN (${scopePlaceholders}) AND ((${mentionLikeClause}) ${entityVectorClause})
        AND NOT EXISTS (
          SELECT 1 FROM memory_knowledge_assertion_evidence corrected_ev
          JOIN memory_knowledge_assertion_corrections correction ON correction.assertion_id = corrected_ev.assertion_id
          WHERE corrected_ev.text_unit_id = m.text_unit_id
        )
      ORDER BY m.resolution_confidence DESC, r.activated_at DESC
      LIMIT 100
    `).all(...scopes, ...mentionLikeArgs, ...vectorEntityIds) as Array<Record<string, unknown>>
    for (const row of mentionRows) {
      const entityId = String(row.id)
      if (!nodes.has(entityId)) nodes.set(entityId, this.getNode(entityId) || rowToNode({
        id: entityId, canonical_name: row.canonical_name, normalized_name: row.normalized_name,
        entity_type: row.entity_type, created_at: row.created_at, updated_at: row.updated_at,
      }))
      const chunkKey = String(row.text_unit_id)
      if (!sourceChunks.has(chunkKey)) sourceChunks.set(chunkKey, {
        id: chunkKey, text: String(row.source_text), source: 'memory', score: Number(row.resolution_confidence),
        scoreType: 'entity-resolution', sourceFile: String(row.file_name), chunkIndex: Number(row.chunk_index),
        spaceId: String(row.space_id), documentTitle: String(row.document_title), sectionPath: String(row.section_path),
        contentHash: String(row.text_hash), documentId: String(row.document_id), revision: String(row.content_hash),
      })
    }
    if (!chosen.length) {
      const allowedSeedIds = exactSeedIds.size ? exactSeedIds : vectorEntityIds
      const nodeList = Array.from(nodes.values()).filter((node) => allowedSeedIds.has(node.id)).slice(0, limit)
      return {
        graph: nodeList.length ? { seedNodes: nodeList, nodes: nodeList, edges: [] } : undefined,
        sourceChunks: Array.from(sourceChunks.values()).slice(0, limit),
      }
    }

    for (const row of chosen) {
      const subjectId = String(row.subject_entity_id)
      const objectId = row.object_entity_id ? String(row.object_entity_id) : `literal:${row.id}`
      if (!nodes.has(subjectId)) nodes.set(subjectId, this.getNode(subjectId) || rowToNode({
        id: subjectId, canonical_name: row.subject_name, normalized_name: row.subject_normalized,
        entity_type: row.subject_type, importance: row.importance, created_at: row.subject_created_at,
        updated_at: row.subject_updated_at,
      }))
      const objectName = row.object_name ? String(row.object_name) : formatLiteral(row.object_value_json)
      if (!nodes.has(objectId)) nodes.set(objectId, row.object_entity_id ? this.getNode(objectId) || rowToNode({
        id: objectId, canonical_name: objectName, normalized_name: normalize(objectName),
        entity_type: row.object_type || 'concept', importance: row.importance,
        created_at: row.object_created_at || row.created_at, updated_at: row.object_updated_at || row.updated_at,
      }) : rowToNode({
        id: objectId, canonical_name: objectName, normalized_name: normalize(objectName),
        entity_type: 'concept', importance: row.importance,
        created_at: row.created_at, updated_at: row.updated_at,
      }, 1, [{
        sourceKind: row.correction_evidence ? 'manual' : 'memory',
        sourceId: row.correction_evidence ? `manual:assertion:${row.id}` : String(row.source_id),
        label: String(row.file_name || row.source_id), count: 1, lastSeenAt: Number(row.updated_at),
        chunks: [this.graph.sourceChunkFromRow(row, [String(row.correction_evidence || row.extraction_note || '')].filter(Boolean))],
      }]))
      edges.push({
        id: String(row.id), fromNodeId: subjectId, toNodeId: objectId,
        fromName: String(row.subject_name), toName: objectName, relation: String(row.canonical_name),
        importance: Math.min(3, Math.max(0, Number(row.importance))) as ImportanceLevel,
        retrievalRelevance: chosenScores.get(String(row.id)),
        assertionStatus: String(row.status) as EntityEdge['assertionStatus'],
        note: String(row.correction_evidence || row.extraction_note || ''),
        sourceKind: row.correction_evidence ? 'manual' : 'memory',
        sourceId: row.correction_evidence ? `manual:assertion:${row.id}` : String(row.source_id),
        sourceDocumentId: row.correction_evidence ? undefined : String(row.document_id),
        sourceContentHash: row.correction_evidence ? undefined : String(row.content_hash),
        sourceChunkIndex: row.correction_evidence ? undefined : Number(row.chunk_index),
        sourceChunk: this.graph.sourceChunkFromRow(row, [String(row.correction_evidence || row.extraction_note || '')].filter(Boolean)),
        sourceIds: row.correction_evidence ? [`manual:assertion:${row.id}`] : [String(row.source_id)], mentionCount: 1,
        firstSeenAt: Number(row.created_at), lastSeenAt: Number(row.updated_at),
      })
      const chunkKey = String(row.text_unit_id)
      if (!row.correction_evidence && !sourceChunks.has(chunkKey)) sourceChunks.set(chunkKey, {
        id: chunkKey, text: String(row.source_text), source: 'memory', score: chosenScores.get(String(row.id)) || 0,
        scoreType: 'fusion', sourceFile: String(row.file_name), chunkIndex: Number(row.chunk_index),
        spaceId: String(row.space_id), documentTitle: String(row.document_title), sectionPath: String(row.section_path),
        contentHash: String(row.text_hash), documentId: String(row.document_id), revision: String(row.content_hash),
      })
    }
    const assertionIds = chosen.map((row) => String(row.id))
    if (assertionIds.length) {
      const evidenceRows = getDb().prepare(`
        SELECT ev.assertion_id, ev.text_unit_id, tu.text AS source_text, tu.chunk_index, tu.document_title,
          tu.section_path, tu.text_hash, r.space_id, r.file_name, r.document_id,
          r.content_hash, r.source_id
        FROM memory_knowledge_assertion_evidence ev
        JOIN memory_knowledge_text_units tu ON tu.id = ev.text_unit_id
        JOIN memory_knowledge_index_runs r ON r.id = ev.run_id AND r.status = 'active'
        WHERE ev.assertion_id IN (${assertionIds.map(() => '?').join(', ')})
          AND ev.quote_verified = 1 AND r.space_id IN (${scopePlaceholders})
          AND NOT EXISTS (SELECT 1 FROM memory_knowledge_assertion_corrections c WHERE c.assertion_id = ev.assertion_id)
        ORDER BY r.activated_at DESC, tu.chunk_index
      `).all(...assertionIds, ...scopes) as Array<Record<string, unknown>>
      for (const row of evidenceRows) {
        const chunkKey = String(row.text_unit_id)
        if (sourceChunks.has(chunkKey)) continue
        const assertionRelevance = chosenScores.get(String(row.assertion_id)) || 0
        sourceChunks.set(chunkKey, {
          id: chunkKey, text: String(row.source_text), source: 'memory', score: assertionRelevance,
          scoreType: 'fusion', sourceFile: String(row.file_name), chunkIndex: Number(row.chunk_index),
          spaceId: String(row.space_id), documentTitle: String(row.document_title), sectionPath: String(row.section_path),
          contentHash: String(row.text_hash), documentId: String(row.document_id), revision: String(row.content_hash),
        })
      }
    }
    const visibleNodeIds = new Set(edges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]))
    const semanticSeedIds = exactSeedIds.size ? exactSeedIds : vectorEntityIds
    for (const id of semanticSeedIds) visibleNodeIds.add(id)
    const nodeList = Array.from(nodes.values()).filter((node) => visibleNodeIds.has(node.id))
    const seedNodes = nodeList.filter((node) => semanticSeedIds.has(node.id))
    if (!edges.length && !seedNodes.length) return { sourceChunks: [] }
    return { graph: { seedNodes, nodes: nodeList, edges }, sourceChunks: Array.from(sourceChunks.values()) }
  }

  stats(): Record<string, number> {
    const row = getDb().prepare(`
      SELECT
        (SELECT COUNT(*) FROM memory_knowledge_index_runs WHERE status = 'active') AS active_runs,
        (SELECT COUNT(*) FROM memory_knowledge_text_units tu JOIN memory_knowledge_index_runs r ON r.id = tu.run_id WHERE r.status = 'active') AS active_text_units,
        (SELECT COUNT(*) FROM memory_knowledge_entities WHERE status = 'active') AS entities,
        (SELECT COUNT(*) FROM memory_knowledge_entity_mentions m JOIN memory_knowledge_index_runs r ON r.id = m.run_id WHERE r.status = 'active') AS active_mentions,
        (SELECT COUNT(*) FROM memory_knowledge_assertions WHERE status = 'active') AS active_assertions,
        (SELECT COUNT(*) FROM memory_knowledge_assertions WHERE status = 'disputed') AS disputed_assertions,
        (SELECT COUNT(*) FROM memory_knowledge_assertion_evidence ev JOIN memory_knowledge_index_runs r ON r.id = ev.run_id WHERE r.status = 'active' AND ev.quote_verified = 1) AS verified_evidence,
        (SELECT COUNT(*) FROM memory_knowledge_predicates WHERE managed = 0) AS unmanaged_predicates,
        (SELECT COUNT(*) FROM memory_file_index) AS indexed_documents,
        (SELECT COUNT(*) FROM memory_file_index m WHERE EXISTS (
          SELECT 1 FROM memory_knowledge_index_runs r
          WHERE r.document_id = m.document_id AND r.content_hash = m.content_hash
            AND r.pipeline_version = '${MEMORY_KNOWLEDGE_PIPELINE_VERSION}' AND r.status = 'active'
        )) AS covered_documents,
        (SELECT COUNT(*) FROM memory_knowledge_index_runs WHERE status = 'active' AND search_projection_status = 'ready') AS projection_ready_runs,
        (SELECT COUNT(*) FROM memory_knowledge_index_runs WHERE status = 'active' AND search_projection_status = 'error') AS projection_error_runs,
        (SELECT COUNT(*) FROM memory_knowledge_entity_mentions m JOIN memory_knowledge_index_runs r ON r.id = m.run_id WHERE r.status = 'active' AND m.resolution_status = 'ambiguous') AS ambiguous_mentions
    `).get() as Record<string, number>
    return row
  }
}

let instance: MemoryKnowledgeStore | null = null

export function getMemoryKnowledgeStore(): MemoryKnowledgeStore {
  if (!instance) instance = new MemoryKnowledgeStore()
  return instance
}
