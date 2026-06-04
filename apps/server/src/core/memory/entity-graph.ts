import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getGateway } from '../gateway/gateway.js'

export type EntityType = 'person' | 'place' | 'organization' | 'project' | 'date' | 'technology' | 'concept' | 'other'

export interface EntityNode {
  id: string
  name: string
  normalizedName: string
  type: EntityType
  aliases: string[]
  mentionCount: number
  sourceCount: number
  firstSeenAt: number
  lastSeenAt: number
}

export interface EntityEdge {
  id: string
  fromNodeId: string
  toNodeId: string
  fromName: string
  toName: string
  relation: string
  confidence: number
  evidence: string
  sourceKind: string
  sourceId: string
  mentionCount: number
  firstSeenAt: number
  lastSeenAt: number
}

export interface GraphWalkResult {
  seedNodes: EntityNode[]
  nodes: EntityNode[]
  edges: EntityEdge[]
}

interface ExtractedEntity {
  name: string
  type?: EntityType
  aliases?: string[]
}

interface ExtractedRelation {
  action?: 'assert' | 'delete'
  from: ExtractedEntity
  relation: string
  to: ExtractedEntity
  confidence?: number
  evidence?: string
}

const ENTITY_TYPES = new Set<EntityType>(['person', 'place', 'organization', 'project', 'date', 'technology', 'concept', 'other'])
const STOP_TERMS = new Set(['user', 'assistant', 'you', 'me', 'i', 'we', 'they', 'today', 'tomorrow', 'yesterday', 'this', 'that'])
const FUNCTIONAL_RELATIONS = new Set([
  'works_at',
  'employed_by',
  'lives_in',
  'located_in',
  'based_in',
  'studies_at',
  'studied_at',
  'has_role',
  'reports_to',
  'managed_by',
  'owned_by',
])

function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s._-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeRelation(relation: string): string {
  return relation
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'related_to'
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 120)
}

function cleanEvidence(evidence: string | undefined): string {
  return (evidence || '').replace(/\s+/g, ' ').trim().slice(0, 280)
}

function parseJsonArray(raw: string): unknown[] {
  const trimmed = raw.trim()
  const fenced = trimmed.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  try {
    const parsed = JSON.parse(fenced)
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { relations?: unknown[] }).relations)) {
      return (parsed as { relations: unknown[] }).relations
    }
  } catch {
    const start = fenced.indexOf('[')
    const end = fenced.lastIndexOf(']')
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(fenced.slice(start, end + 1))
        if (Array.isArray(parsed)) return parsed
      } catch { /* ignore */ }
    }
  }
  return []
}

function toEntity(value: unknown): ExtractedEntity | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as { name?: unknown; type?: unknown; aliases?: unknown }
  if (typeof obj.name !== 'string') return null
  const name = cleanName(obj.name)
  const normalizedName = normalizeName(name)
  if (!name || normalizedName.length < 2 || STOP_TERMS.has(normalizedName)) return null
  const type = typeof obj.type === 'string' && ENTITY_TYPES.has(obj.type as EntityType)
    ? obj.type as EntityType
    : 'other'
  const aliases = Array.isArray(obj.aliases)
    ? obj.aliases.filter((a): a is string => typeof a === 'string').map(cleanName).filter(Boolean).slice(0, 8)
    : []
  return { name, type, aliases }
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.7
  return Math.max(0.1, Math.min(1, value))
}

function rowToNode(row: Record<string, unknown>): EntityNode {
  return {
    id: row.id as string,
    name: row.name as string,
    normalizedName: row.normalized_name as string,
    type: row.type as EntityType,
    aliases: JSON.parse((row.aliases_json as string) || '[]') as string[],
    mentionCount: row.mention_count as number,
    sourceCount: row.source_count as number,
    firstSeenAt: row.first_seen_at as number,
    lastSeenAt: row.last_seen_at as number
  }
}

function rowToEdge(row: Record<string, unknown>): EntityEdge {
  return {
    id: row.id as string,
    fromNodeId: row.from_node_id as string,
    toNodeId: row.to_node_id as string,
    fromName: row.from_name as string,
    toName: row.to_name as string,
    relation: row.relation as string,
    confidence: row.confidence as number,
    evidence: row.evidence as string,
    sourceKind: row.source_kind as string,
    sourceId: row.source_id as string,
    mentionCount: row.mention_count as number,
    firstSeenAt: row.first_seen_at as number,
    lastSeenAt: row.last_seen_at as number
  }
}

export class EntityGraphStore {
  upsertNode(entity: ExtractedEntity, sourceId: string, now = Date.now()): EntityNode {
    const db = getDb()
    const name = cleanName(entity.name)
    const normalizedName = normalizeName(name)
    const type = ENTITY_TYPES.has((entity.type || 'other') as EntityType) ? entity.type || 'other' : 'other'
    const aliases = Array.from(new Set((entity.aliases || []).map(cleanName).filter(Boolean)))
    const existing = db.prepare(
      'SELECT * FROM entity_graph_nodes WHERE normalized_name = ? AND type = ?'
    ).get(normalizedName, type) as Record<string, unknown> | undefined

    if (!existing) {
      const id = nanoid()
      db.prepare(`
        INSERT INTO entity_graph_nodes (id, name, normalized_name, type, aliases_json, mention_count, source_count, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
      `).run(id, name, normalizedName, type, JSON.stringify(aliases), now, now)
      return this.getNode(id)!
    }

    const existingAliases = JSON.parse((existing.aliases_json as string) || '[]') as string[]
    const mergedAliases = Array.from(new Set([...existingAliases, ...aliases])).slice(0, 16)
    const sourceIncrement = sourceId ? 1 : 0
    db.prepare(`
      UPDATE entity_graph_nodes
      SET name = ?, aliases_json = ?, mention_count = mention_count + 1, source_count = source_count + ?, last_seen_at = ?
      WHERE id = ?
    `).run(name, JSON.stringify(mergedAliases), sourceIncrement, now, existing.id)
    return this.getNode(existing.id as string)!
  }

  upsertEdge(relation: ExtractedRelation, sourceKind: string, sourceId: string, now = Date.now()): EntityEdge | null {
    const from = this.upsertNode(relation.from, sourceId, now)
    const to = this.upsertNode(relation.to, sourceId, now)
    if (from.id === to.id) return null

    const db = getDb()
    const rel = normalizeRelation(relation.relation)
    const evidence = cleanEvidence(relation.evidence)
    this.deleteConflictingFunctionalEdges(from.id, rel, to.id)
    const existing = db.prepare(`
      SELECT * FROM entity_graph_edges
      WHERE from_node_id = ? AND relation = ? AND to_node_id = ?
    `).get(from.id, rel, to.id) as Record<string, unknown> | undefined

    if (!existing) {
      const id = nanoid()
      db.prepare(`
        INSERT INTO entity_graph_edges
          (id, from_node_id, to_node_id, relation, confidence, evidence, source_kind, source_id, mention_count, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(id, from.id, to.id, rel, clampConfidence(relation.confidence), evidence, sourceKind, sourceId, now, now)
      return this.getEdge(id)
    }

    db.prepare(`
      UPDATE entity_graph_edges
      SET confidence = MAX(confidence, ?), evidence = ?, source_kind = ?, source_id = ?, mention_count = mention_count + 1, last_seen_at = ?
      WHERE id = ?
    `).run(clampConfidence(relation.confidence), evidence || existing.evidence, sourceKind, sourceId, now, existing.id)
    return this.getEdge(existing.id as string)
  }

  getNode(id: string): EntityNode | null {
    const row = getDb().prepare('SELECT * FROM entity_graph_nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? rowToNode(row) : null
  }

  getEdge(id: string): EntityEdge | null {
    const row = getDb().prepare(`
      SELECT e.*, fn.name AS from_name, tn.name AS to_name
      FROM entity_graph_edges e
      JOIN entity_graph_nodes fn ON fn.id = e.from_node_id
      JOIN entity_graph_nodes tn ON tn.id = e.to_node_id
      WHERE e.id = ?
    `).get(id) as Record<string, unknown> | undefined
    return row ? rowToEdge(row) : null
  }

  updateNode(
    id: string,
    patch: { name?: string; type?: EntityType; aliases?: string[] },
  ): EntityNode | null {
    const existing = this.getNode(id)
    if (!existing) return null

    const name = patch.name !== undefined ? cleanName(patch.name) : existing.name
    const normalizedName = normalizeName(name)
    if (!name || normalizedName.length < 2 || STOP_TERMS.has(normalizedName)) {
      throw new Error('ENTITY_NODE_INVALID_NAME')
    }

    const type = patch.type !== undefined && ENTITY_TYPES.has(patch.type)
      ? patch.type
      : existing.type
    const aliases = patch.aliases !== undefined
      ? Array.from(new Set(patch.aliases.map(cleanName).filter(Boolean))).slice(0, 16)
      : existing.aliases

    const conflict = getDb().prepare(`
      SELECT id FROM entity_graph_nodes
      WHERE normalized_name = ? AND type = ? AND id != ?
    `).get(normalizedName, type, id) as { id: string } | undefined
    if (conflict) throw new Error('ENTITY_NODE_CONFLICT')

    getDb().prepare(`
      UPDATE entity_graph_nodes
      SET name = ?, normalized_name = ?, type = ?, aliases_json = ?, last_seen_at = ?
      WHERE id = ?
    `).run(name, normalizedName, type, JSON.stringify(aliases), Date.now(), id)

    return this.getNode(id)
  }

  updateEdge(
    id: string,
    patch: { relation?: string; evidence?: string; confidence?: number },
  ): EntityEdge | null {
    const existing = this.getEdge(id)
    if (!existing) return null

    const relation = patch.relation !== undefined
      ? normalizeRelation(patch.relation)
      : existing.relation
    const evidence = patch.evidence !== undefined
      ? cleanEvidence(patch.evidence)
      : existing.evidence
    const confidence = patch.confidence !== undefined
      ? clampConfidence(patch.confidence)
      : existing.confidence

    getDb().prepare(`
      UPDATE entity_graph_edges
      SET relation = ?, evidence = ?, confidence = ?, last_seen_at = ?
      WHERE id = ?
    `).run(relation, evidence, confidence, Date.now(), id)

    return this.getEdge(id)
  }

  deleteEdge(id: string): boolean {
    const result = getDb().prepare('DELETE FROM entity_graph_edges WHERE id = ?').run(id)
    return result.changes > 0
  }

  deleteNode(id: string): boolean {
    const result = getDb().prepare('DELETE FROM entity_graph_nodes WHERE id = ?').run(id)
    return result.changes > 0
  }

  deleteMatchingEdge(relation: ExtractedRelation): number {
    const from = this.findNodeByEntity(relation.from)
    const to = this.findNodeByEntity(relation.to)
    if (!from || !to) return 0
    const result = getDb().prepare(`
      DELETE FROM entity_graph_edges
      WHERE from_node_id = ? AND relation = ? AND to_node_id = ?
    `).run(from.id, normalizeRelation(relation.relation), to.id)
    return result.changes
  }

  deleteAll(): { nodesDeleted: number; edgesDeleted: number } {
    const db = getDb()
    const edgesDeleted = db.prepare('DELETE FROM entity_graph_edges').run().changes
    const nodesDeleted = db.prepare('DELETE FROM entity_graph_nodes').run().changes
    return { nodesDeleted, edgesDeleted }
  }

  private findNodeByEntity(entity: ExtractedEntity): EntityNode | null {
    const name = cleanName(entity.name)
    const normalizedName = normalizeName(name)
    const type = ENTITY_TYPES.has((entity.type || 'other') as EntityType) ? entity.type || 'other' : 'other'
    const row = getDb().prepare(`
      SELECT * FROM entity_graph_nodes
      WHERE normalized_name = ? AND type = ?
    `).get(normalizedName, type) as Record<string, unknown> | undefined
    return row ? rowToNode(row) : null
  }

  private deleteConflictingFunctionalEdges(fromNodeId: string, relation: string, toNodeId: string): number {
    if (!FUNCTIONAL_RELATIONS.has(relation)) return 0
    const result = getDb().prepare(`
      DELETE FROM entity_graph_edges
      WHERE from_node_id = ? AND relation = ? AND to_node_id != ?
    `).run(fromNodeId, relation, toNodeId)
    return result.changes
  }

  list(limit = 80): { nodes: EntityNode[]; edges: EntityEdge[] } {
    const db = getDb()
    const nodes = db.prepare(`
      SELECT * FROM entity_graph_nodes
      ORDER BY last_seen_at DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[]
    const edges = db.prepare(`
      SELECT e.*, fn.name AS from_name, tn.name AS to_name
      FROM entity_graph_edges e
      JOIN entity_graph_nodes fn ON fn.id = e.from_node_id
      JOIN entity_graph_nodes tn ON tn.id = e.to_node_id
      ORDER BY e.last_seen_at DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[]
    return { nodes: nodes.map(rowToNode), edges: edges.map(rowToEdge) }
  }

  stats(): { nodeCount: number; edgeCount: number; recentEdgeCount: number } {
    const db = getDb()
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000
    return {
      nodeCount: (db.prepare('SELECT COUNT(*) AS count FROM entity_graph_nodes').get() as { count: number }).count,
      edgeCount: (db.prepare('SELECT COUNT(*) AS count FROM entity_graph_edges').get() as { count: number }).count,
      recentEdgeCount: (db.prepare('SELECT COUNT(*) AS count FROM entity_graph_edges WHERE last_seen_at >= ?').get(since) as { count: number }).count
    }
  }

  findSeedNodes(text: string, extraTexts: string[] = [], limit = 8): EntityNode[] {
    const haystack = normalizeName([text, ...extraTexts].join(' '))
    if (!haystack) return []
    const rows = getDb().prepare(`
      SELECT * FROM entity_graph_nodes
      ORDER BY mention_count DESC, last_seen_at DESC
      LIMIT 500
    `).all() as Record<string, unknown>[]
    const seeds: EntityNode[] = []
    for (const row of rows) {
      const node = rowToNode(row)
      const names = [node.normalizedName, ...node.aliases.map(normalizeName)].filter(Boolean)
      if (names.some((name) => name.length >= 2 && haystack.includes(name))) {
        seeds.push(node)
        if (seeds.length >= limit) break
      }
    }
    return seeds
  }

  walk(seedNodeIds: string[], depth = 2, edgeLimit = 40): GraphWalkResult {
    const seedIds = Array.from(new Set(seedNodeIds.filter(Boolean)))
    if (seedIds.length === 0) return { seedNodes: [], nodes: [], edges: [] }

    const db = getDb()
    const nodeIds = new Set(seedIds)
    const edgeMap = new Map<string, EntityEdge>()
    let frontier = seedIds

    for (let d = 0; d < depth && frontier.length > 0 && edgeMap.size < edgeLimit; d++) {
      const placeholders = frontier.map(() => '?').join(', ')
      const rows = db.prepare(`
        SELECT e.*, fn.name AS from_name, tn.name AS to_name
        FROM entity_graph_edges e
        JOIN entity_graph_nodes fn ON fn.id = e.from_node_id
        JOIN entity_graph_nodes tn ON tn.id = e.to_node_id
        WHERE e.from_node_id IN (${placeholders}) OR e.to_node_id IN (${placeholders})
        ORDER BY e.confidence DESC, e.mention_count DESC, e.last_seen_at DESC
        LIMIT ?
      `).all(...frontier, ...frontier, Math.max(edgeLimit - edgeMap.size, 1)) as Record<string, unknown>[]

      const next: string[] = []
      for (const row of rows) {
        const edge = rowToEdge(row)
        if (!edgeMap.has(edge.id)) edgeMap.set(edge.id, edge)
        for (const id of [edge.fromNodeId, edge.toNodeId]) {
          if (!nodeIds.has(id)) {
            nodeIds.add(id)
            next.push(id)
          }
        }
      }
      frontier = next
    }

    const allIds = Array.from(nodeIds)
    const placeholders = allIds.map(() => '?').join(', ')
    const nodeRows = placeholders
      ? db.prepare(`SELECT * FROM entity_graph_nodes WHERE id IN (${placeholders})`).all(...allIds) as Record<string, unknown>[]
      : []
    const nodes = nodeRows.map(rowToNode)
    const seedNodes = nodes.filter((node) => seedIds.includes(node.id))
    return { seedNodes, nodes, edges: Array.from(edgeMap.values()) }
  }

  async extractFromTurn(opts: {
    conversationId: string
    userMessage: string
    assistantResponse: string
    providerId?: string
    model?: string
    signal?: AbortSignal
  }): Promise<{ insertedOrUpdated: number; deleted: number }> {
    const gateway = getGateway()
    const provider = opts.providerId
      ? gateway.getProvider(opts.providerId) || gateway.getLastUsedProvider()
      : gateway.getLastUsedProvider()
    const result = await gateway.complete({
      model: opts.model || provider.config.defaultModel,
      signal: opts.signal,
      maxTokens: 900,
      temperature: 0,
      thinkingEnabled: false,
      messages: [
        {
          role: 'system',
          content: [
            'Extract durable named entities and explicit relationships from a chat turn.',
            'Return strict JSON only: an array of objects with keys action, from, relation, to, confidence, evidence.',
            'action is "assert" for facts that are true now, or "delete" for facts explicitly corrected, negated, or no longer true.',
            'from and to are objects with name, type, and optional aliases.',
            'Allowed types: person, place, organization, project, date, technology, concept, other.',
            'Only include facts that would remain useful later. Skip vague, temporary, or unsupported claims.',
            'Use concise snake_case relation names such as works_at, depends_on, located_in, owns, uses, met_on, discussed_with.',
            'When a fact changes, emit a delete for the old relationship if the turn names it, and an assert for the replacement.',
            'If there are no durable relationships, return [].'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            '<user>',
            opts.userMessage.slice(0, 4000),
            '</user>',
            '',
            '<assistant>',
            opts.assistantResponse.slice(0, 4000),
            '</assistant>'
          ].join('\n')
        }
      ]
    }, provider.config.id)

    const rawRelations = parseJsonArray(result.content)
    let count = 0
    let deleted = 0
    const now = Date.now()
    for (const item of rawRelations.slice(0, 24)) {
      if (!item || typeof item !== 'object') continue
      const obj = item as { action?: unknown; from?: unknown; relation?: unknown; to?: unknown; confidence?: unknown; evidence?: unknown }
      const from = toEntity(obj.from)
      const to = toEntity(obj.to)
      if (!from || !to || typeof obj.relation !== 'string') continue
      const extracted = {
        action: obj.action === 'delete' ? 'delete' as const : 'assert' as const,
        from,
        relation: obj.relation,
        to,
        confidence: clampConfidence(obj.confidence),
        evidence: typeof obj.evidence === 'string' ? obj.evidence : ''
      }
      if (extracted.action === 'delete') {
        deleted += this.deleteMatchingEdge(extracted)
        continue
      }
      const edge = this.upsertEdge(extracted, 'conversation', opts.conversationId, now)
      if (edge) count++
    }
    return { insertedOrUpdated: count, deleted }
  }

  formatWalk(walk: GraphWalkResult): string {
    if (walk.edges.length === 0) return ''
    return '## Entity Graph Context\n' + walk.edges.map((edge) => {
      const relation = edge.relation.replace(/_/g, ' ')
      const evidence = edge.evidence ? ` Evidence: ${edge.evidence}` : ''
      return `- ${edge.fromName} -> ${relation} -> ${edge.toName}.${evidence}`
    }).join('\n')
  }
}

let graphInstance: EntityGraphStore | null = null

export function getEntityGraphStore(): EntityGraphStore {
  if (!graphInstance) graphInstance = new EntityGraphStore()
  return graphInstance
}
