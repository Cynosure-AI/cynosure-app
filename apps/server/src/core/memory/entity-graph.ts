import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getGateway } from '../gateway/gateway.js'

export type EntityType = 'person' | 'place' | 'organization' | 'project' | 'event' | 'date' | 'technology' | 'product' | 'artifact' | 'concept' | 'other'

/**
 * Importance levels for entity graph nodes and edges:
 *   0 = random / conversational / temporary
 *   1 = mildly interesting but probably not worth saving (default)
 *   2 = useful durable fact
 *   3 = core fact about user, project, person, preference, goal, or long-running context
 */
export type ImportanceLevel = 0 | 1 | 2 | 3

export interface EntityNode {
  id: string
  name: string
  normalizedName: string
  type: EntityType
  aliases: string[]
  importance: ImportanceLevel
  mentionCount: number
  sourceCount: number
  origins?: EntityOrigin[]
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
  importance: ImportanceLevel
  confidence: number
  evidence: string
  sourceKind: string
  sourceId: string
  mentionCount: number
  firstSeenAt: number
  lastSeenAt: number
}

export interface EntityOrigin {
  sourceKind: string
  sourceId: string
  label: string
  count: number
  lastSeenAt: number
}

export interface GraphWalkResult {
  seedNodes: EntityNode[]
  nodes: EntityNode[]
  edges: EntityEdge[]
}

export interface GraphWalkOptions {
  sourceIds?: string[]
  contextText?: string
}

export interface DeleteEdgeResult {
  edgeDeleted: boolean
  orphanedNodeIds: string[]
}

interface GraphSnapshot {
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
  importance?: ImportanceLevel
  confidence?: number
  evidence?: string
}

const ENTITY_TYPES = new Set<EntityType>(['person', 'place', 'organization', 'project', 'event', 'date', 'technology', 'product', 'artifact', 'concept', 'other'])
const RESERVED_ENTITY_NAMES = new Set(['user', 'assistant', 'system', 'tool'])
const MAX_SEED_SEARCH_TERMS = 32
const SINGLE_TARGET_RELATIONS = new Set([
  'works_at',
  'employed_by',
  'lives_in',
  'located_in',
  'based_in',
  'born_in',
  'founded_by',
  'owned_by',
  'managed_by',
  'reports_to',
  'part_of',
])

function normalizeName(name: unknown): string {
  if (typeof name !== 'string') return ''
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s._-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeRelation(relation: unknown): string {
  if (typeof relation !== 'string') return 'related_to'
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
    // Attempt to salvage truncated JSON by extracting complete objects
    if (start >= 0) {
      const objects = fenced.slice(start)
      const extracted: unknown[] = []
      let i = 0
      while (i < objects.length) {
        const objStart = objects.indexOf('{', i)
        if (objStart < 0) break
        let depth = 0
        let inString = false
        let escaped = false
        let j = objStart
        while (j < objects.length) {
          const ch = objects[j]
          if (escaped) { escaped = false; j++; continue }
          if (ch === '\\') { escaped = true; j++; continue }
          if (ch === '"') { inString = !inString; j++; continue }
          if (inString) { j++; continue }
          if (ch === '{') depth++
          else if (ch === '}') {
            depth--
            if (depth === 0) {
              try {
                const obj = JSON.parse(objects.slice(objStart, j + 1))
                if (obj && typeof obj === 'object') extracted.push(obj)
              } catch { /* incomplete object, skip */ }
              i = j + 1
              break
            }
          }
          j++
        }
        if (j >= objects.length) break // truncated mid-object, stop
      }
      if (extracted.length > 0) return extracted
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
  if (!name || normalizedName.length < 2 || RESERVED_ENTITY_NAMES.has(normalizedName)) return null
  const type = typeof obj.type === 'string' && ENTITY_TYPES.has(obj.type as EntityType)
    ? obj.type as EntityType
    : 'other'
  const aliases = Array.isArray(obj.aliases)
    ? obj.aliases.filter((a): a is string => typeof a === 'string').map(cleanName).filter(Boolean).slice(0, 8)
    : []
  return { name, type, aliases }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.7
  return Math.max(0.1, Math.min(1, value))
}

function clampImportance(value: unknown): ImportanceLevel {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.max(0, Math.min(3, Math.round(value))) as ImportanceLevel
}

function inferImportance(value: unknown, relation: string, sourceKind: string): ImportanceLevel {
  if (typeof value === 'number' && Number.isFinite(value)) return clampImportance(value)
  const normalizedRelation = normalizeRelation(relation)
  if (sourceKind === 'memory') return 2
  if (['prefers', 'preference', 'likes', 'dislikes', 'works_at', 'employed_by', 'lives_in', 'owns', 'uses', 'goal', 'working_on'].includes(normalizedRelation)) return 3
  if (['depends_on', 'part_of', 'located_in', 'based_in', 'created', 'founded_by', 'managed_by'].includes(normalizedRelation)) return 2
  return 1
}

function effectiveImportance(value: unknown, relation: string, sourceKind: string): ImportanceLevel {
  const stored = clampImportance(value)
  if (stored !== 1) return stored
  return inferImportance(undefined, relation, sourceKind)
}

function memorySourceLabel(sourceId: string): string | null {
  if (!sourceId.startsWith('memory:')) return null
  const parts = sourceId.split(':')
  if (parts.length >= 3) return parts.slice(2).join(':')
  return parts.slice(1).join(':') || null
}

function conversationSourceLabel(sourceId: string): string | null {
  if (!sourceId) return null
  const row = getDb().prepare('SELECT title FROM conversations WHERE id = ?').get(sourceId) as { title: string } | undefined
  return row?.title || null
}

function sourceLabel(sourceKind: string, sourceId: string): string {
  if (sourceKind === 'memory') return memorySourceLabel(sourceId) || 'Memory document'
  if (sourceKind === 'conversation') return conversationSourceLabel(sourceId) || 'Conversation'
  return sourceId || sourceKind
}

function tokenizeEntityQuery(value: string): string[] {
  return Array.from(new Set(
    normalizeName(value)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  ))
}

function scoreEdgeRelevance(edge: EntityEdge, seedIds: Set<string>, sourceIds: Set<string>, contextText: string, contextTokens: string[]): number {
  let score = 0
  if (sourceIds.has(edge.sourceId)) score += 120
  if (seedIds.has(edge.fromNodeId) || seedIds.has(edge.toNodeId)) score += 20

  const fromName = normalizeName(edge.fromName)
  const toName = normalizeName(edge.toName)
  const relation = normalizeName(edge.relation.replace(/_/g, ' '))
  const evidence = normalizeName(edge.evidence)
  const edgeText = `${fromName} ${toName} ${relation} ${evidence}`

  if (fromName.length >= 3 && contextText.includes(fromName)) score += 35
  if (toName.length >= 3 && contextText.includes(toName)) score += 35
  for (const token of contextTokens) {
    if (edgeText.includes(token)) score += 5
  }

  return score
}

function rowToNode(row: Record<string, unknown>): EntityNode {
  return {
    id: row.id as string,
    name: row.name as string,
    normalizedName: row.normalized_name as string,
    type: row.type as EntityType,
    aliases: JSON.parse((row.aliases_json as string) || '[]') as string[],
    importance: effectiveImportance(row.importance, row.relation as string, row.source_kind as string),
    mentionCount: row.mention_count as number,
    sourceCount: row.source_count as number,
    firstSeenAt: row.first_seen_at as number,
    lastSeenAt: row.last_seen_at as number
  }
}

function hydrateNodeOrigins(nodes: EntityNode[]): EntityNode[] {
  if (nodes.length === 0) return nodes
  const nodeIds = nodes.map((node) => node.id)
  const rows = getDb().prepare(`
    SELECT node_id, source_kind, source_id, SUM(mention_count) AS count, MAX(last_seen_at) AS last_seen_at
    FROM (
      SELECT from_node_id AS node_id, source_kind, source_id, mention_count, last_seen_at
      FROM entity_graph_edges
      WHERE from_node_id IN (${nodeIds.map(() => '?').join(', ')})
      UNION ALL
      SELECT to_node_id AS node_id, source_kind, source_id, mention_count, last_seen_at
      FROM entity_graph_edges
      WHERE to_node_id IN (${nodeIds.map(() => '?').join(', ')})
    )
    GROUP BY node_id, source_kind, source_id
    ORDER BY last_seen_at DESC
  `).all(...nodeIds, ...nodeIds) as {
    node_id: string
    source_kind: string
    source_id: string
    count: number
    last_seen_at: number
  }[]

  const originsByNode = new Map<string, EntityOrigin[]>()
  for (const row of rows) {
    const origins = originsByNode.get(row.node_id) || []
    origins.push({
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      label: sourceLabel(row.source_kind, row.source_id),
      count: row.count,
      lastSeenAt: row.last_seen_at,
    })
    originsByNode.set(row.node_id, origins)
  }

  return nodes.map((node) => ({
    ...node,
    origins: (originsByNode.get(node.id) || []).slice(0, 8),
  }))
}

function applyEffectiveNodeImportance(nodes: EntityNode[], edges: EntityEdge[]): EntityNode[] {
  if (nodes.length === 0 || edges.length === 0) return nodes
  const importanceByNode = new Map<string, ImportanceLevel>()
  for (const edge of edges) {
    for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
      const current = importanceByNode.get(nodeId) ?? 1
      importanceByNode.set(nodeId, Math.max(current, edge.importance) as ImportanceLevel)
    }
  }
  return nodes.map((node) => ({
    ...node,
    importance: Math.max(node.importance, importanceByNode.get(node.id) ?? node.importance) as ImportanceLevel,
  }))
}

function rowAliases(row: Record<string, unknown>): string[] {
  return JSON.parse((row.aliases_json as string) || '[]') as string[]
}

function rowToEdge(row: Record<string, unknown>): EntityEdge {
  return {
    id: row.id as string,
    fromNodeId: row.from_node_id as string,
    toNodeId: row.to_node_id as string,
    fromName: row.from_name as string,
    toName: row.to_name as string,
    relation: row.relation as string,
    importance: clampImportance(row.importance),
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
    const lookupNames = Array.from(new Set([name, ...aliases].map(normalizeName).filter(Boolean)))
    const matchingRows = this.findNodeRowsByNames(lookupNames)
    if (matchingRows.length > 1) this.mergeDuplicateNameNodes(matchingRows, now)

    const existing = this.findNodeRowsByNames(lookupNames)[0]

    if (!existing) {
      const id = nanoid()
      db.prepare(`
        INSERT INTO entity_graph_nodes (id, name, normalized_name, type, aliases_json, mention_count, source_count, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
      `).run(id, name, normalizedName, type, JSON.stringify(aliases), now, now)
      return this.mergeNodeIdentityCollisions([name, ...aliases], now) || this.getNode(id)!
    }

    const existingAliases = rowAliases(existing)
    const incomingAliases = existing.normalized_name === normalizedName ? aliases : [name, ...aliases]
    const mergedAliases = Array.from(new Set([...existingAliases, ...incomingAliases].map(cleanName).filter(Boolean))).slice(0, 16)
    const displayName = existing.normalized_name === normalizedName ? name : existing.name as string
    const sourceIncrement = sourceId ? 1 : 0
    db.prepare(`
      UPDATE entity_graph_nodes
      SET name = ?,
          type = CASE WHEN type = 'other' AND ? != 'other' THEN ? ELSE type END,
          aliases_json = ?,
          mention_count = mention_count + 1,
          source_count = source_count + ?,
          last_seen_at = ?
      WHERE id = ?
    `).run(displayName, type, type, JSON.stringify(mergedAliases), sourceIncrement, now, existing.id)
    return this.mergeNodeIdentityCollisions([displayName, ...mergedAliases], now) || this.getNode(existing.id as string)!
  }

  upsertEdge(relation: ExtractedRelation, sourceKind: string, sourceId: string, now = Date.now()): EntityEdge | null {
    const from = this.upsertNode(relation.from, sourceId, now)
    const to = this.upsertNode(relation.to, sourceId, now)
    if (from.id === to.id) return null

    const db = getDb()
    const rel = normalizeRelation(relation.relation)
    const evidence = cleanEvidence(relation.evidence)
    const importance = clampImportance(relation.importance)

    if (SINGLE_TARGET_RELATIONS.has(rel)) {
      const staleRows = db.prepare(`
        SELECT id FROM entity_graph_edges
        WHERE from_node_id = ? AND relation = ? AND to_node_id != ?
      `).all(from.id, rel, to.id) as { id: string }[]
      for (const stale of staleRows) this.deleteEdge(stale.id)
    }

    const existing = db.prepare(`
      SELECT * FROM entity_graph_edges
      WHERE from_node_id = ? AND relation = ? AND to_node_id = ?
    `).get(from.id, rel, to.id) as Record<string, unknown> | undefined

    let edgeId: string
    if (!existing) {
      edgeId = nanoid()
      db.prepare(`
        INSERT INTO entity_graph_edges
          (id, from_node_id, to_node_id, relation, importance, confidence, evidence, source_kind, source_id, mention_count, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(edgeId, from.id, to.id, rel, importance, clampConfidence(relation.confidence), evidence, sourceKind, sourceId, now, now)
    } else {
      edgeId = existing.id as string
      db.prepare(`
        UPDATE entity_graph_edges
        SET importance = MAX(importance, ?), confidence = MAX(confidence, ?), evidence = ?, source_kind = ?, source_id = ?, mention_count = mention_count + 1, last_seen_at = ?
        WHERE id = ?
      `).run(importance, clampConfidence(relation.confidence), evidence || existing.evidence, sourceKind, sourceId, now, edgeId)
    }

    // Derive node importance from connected edges: max importance of all edges touching this node
    this.refreshNodeImportance(from.id)
    this.refreshNodeImportance(to.id)

    return this.getEdge(edgeId)
  }

  /**
   * Derive a node's importance as the max importance of all its connected edges.
   */
  private refreshNodeImportance(nodeId: string): void {
    const db = getDb()
    const row = db.prepare(`
      SELECT MAX(e.importance) AS max_importance
      FROM entity_graph_edges e
      WHERE e.from_node_id = ? OR e.to_node_id = ?
    `).get(nodeId, nodeId) as { max_importance: number | null } | undefined
    const derivedImportance = row?.max_importance ?? 1
    db.prepare('UPDATE entity_graph_nodes SET importance = ? WHERE id = ?').run(derivedImportance, nodeId)
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
    patch: { name?: string; type?: EntityType; aliases?: string[]; importance?: ImportanceLevel },
  ): EntityNode | null {
    const existing = this.getNode(id)
    if (!existing) return null

    const name = patch.name !== undefined ? cleanName(patch.name) : existing.name
    const normalizedName = normalizeName(name)
    if (!name || normalizedName.length < 2 || RESERVED_ENTITY_NAMES.has(normalizedName)) {
      throw new Error('ENTITY_NODE_INVALID_NAME')
    }

    const type = patch.type !== undefined && ENTITY_TYPES.has(patch.type)
      ? patch.type
      : existing.type
    const aliases = patch.aliases !== undefined
      ? Array.from(new Set(patch.aliases.map(cleanName).filter(Boolean))).slice(0, 16)
      : existing.aliases
    const importance = patch.importance !== undefined
      ? clampImportance(patch.importance)
      : existing.importance

    const conflict = getDb().prepare(`
      SELECT id FROM entity_graph_nodes
      WHERE normalized_name = ? AND id != ?
    `).get(normalizedName, id) as { id: string } | undefined
    if (conflict) throw new Error('ENTITY_NODE_CONFLICT')

    const now = Date.now()
    getDb().prepare(`
      UPDATE entity_graph_nodes
      SET name = ?, normalized_name = ?, type = ?, aliases_json = ?, importance = ?, last_seen_at = ?
      WHERE id = ?
    `).run(name, normalizedName, type, JSON.stringify(aliases), importance, now, id)

    return this.mergeNodeIdentityCollisions([name, ...aliases], now) || this.getNode(id)
  }

  updateEdge(
    id: string,
    patch: { relation?: string; evidence?: string; confidence?: number; importance?: ImportanceLevel },
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
    const importance = patch.importance !== undefined
      ? clampImportance(patch.importance)
      : existing.importance

    getDb().prepare(`
      UPDATE entity_graph_edges
      SET relation = ?, evidence = ?, confidence = ?, importance = ?, last_seen_at = ?
      WHERE id = ?
    `).run(relation, evidence, confidence, importance, Date.now(), id)

    // Refresh node importance for both endpoints
    this.refreshNodeImportance(existing.fromNodeId)
    this.refreshNodeImportance(existing.toNodeId)

    return this.getEdge(id)
  }

  deleteEdge(id: string, opts: { deleteOrphanedNodes?: boolean } = {}): DeleteEdgeResult {
    const db = getDb()
    const edge = this.getEdge(id)
    if (!edge) return { edgeDeleted: false, orphanedNodeIds: [] }

    const deleted = db.transaction(() => {
      const result = db.prepare('DELETE FROM entity_graph_edges WHERE id = ?').run(id)
      if (result.changes === 0) return { edgeDeleted: false, orphanedNodeIds: [] }
      if (opts.deleteOrphanedNodes === false) return { edgeDeleted: true, orphanedNodeIds: [] }

      const orphanedNodeIds = [edge.fromNodeId, edge.toNodeId].filter((nodeId, idx, ids) => {
        if (ids.indexOf(nodeId) !== idx) return false
        const linked = db.prepare(`
          SELECT 1
          FROM entity_graph_edges
          WHERE from_node_id = ? OR to_node_id = ?
          LIMIT 1
        `).get(nodeId, nodeId)
        return !linked
      })

      for (const nodeId of orphanedNodeIds) {
        db.prepare('DELETE FROM entity_graph_nodes WHERE id = ?').run(nodeId)
      }

      return { edgeDeleted: true, orphanedNodeIds }
    })()

    // Refresh importance for surviving nodes
    if (!deleted.orphanedNodeIds.includes(edge.fromNodeId)) this.refreshNodeImportance(edge.fromNodeId)
    if (!deleted.orphanedNodeIds.includes(edge.toNodeId)) this.refreshNodeImportance(edge.toNodeId)

    return deleted
  }

  deleteNode(id: string): boolean {
    const result = getDb().prepare('DELETE FROM entity_graph_nodes WHERE id = ?').run(id)
    return result.changes > 0
  }

  deleteMatchingEdge(relation: ExtractedRelation): DeleteEdgeResult {
    const from = this.findNodeByEntity(relation.from)
    const to = this.findNodeByEntity(relation.to)
    if (!from || !to) return { edgeDeleted: false, orphanedNodeIds: [] }
    const row = getDb().prepare(`
      SELECT id FROM entity_graph_edges
      WHERE from_node_id = ? AND relation = ? AND to_node_id = ?
    `).get(from.id, normalizeRelation(relation.relation), to.id) as { id: string } | undefined
    if (!row) return { edgeDeleted: false, orphanedNodeIds: [] }
    return this.deleteEdge(row.id)
  }

  deleteAll(): { nodesDeleted: number; edgesDeleted: number } {
    const db = getDb()
    const edgesDeleted = db.prepare('DELETE FROM entity_graph_edges').run().changes
    const nodesDeleted = db.prepare('DELETE FROM entity_graph_nodes').run().changes
    return { nodesDeleted, edgesDeleted }
  }

  private findNodeByEntity(entity: ExtractedEntity): EntityNode | null {
    const name = cleanName(entity.name)
    const aliases = (entity.aliases || []).map(cleanName).filter(Boolean)
    const row = this.findNodeRowsByNames([name, ...aliases].map(normalizeName).filter(Boolean))[0]
    return row ? rowToNode(row) : null
  }

  private findNodeRowsByNames(names: string[]): Record<string, unknown>[] {
    const normalizedNames = Array.from(new Set(names.filter(Boolean)))
    if (normalizedNames.length === 0) return []

    const db = getDb()
    const byId = new Map<string, Record<string, unknown>>()
    const placeholders = normalizedNames.map(() => '?').join(', ')
    const exactRows = db.prepare(`
      SELECT * FROM entity_graph_nodes
      WHERE normalized_name IN (${placeholders})
    `).all(...normalizedNames) as Record<string, unknown>[]
    for (const row of exactRows) byId.set(row.id as string, row)

    const aliasClauses = normalizedNames.map(() => `aliases_json LIKE ? ESCAPE '\\'`).join(' OR ')
    const aliasRows = db.prepare(`
      SELECT * FROM entity_graph_nodes
      WHERE ${aliasClauses}
    `).all(...normalizedNames.map((name) => `%${escapeLike(name)}%`)) as Record<string, unknown>[]
    const nameSet = new Set(normalizedNames)
    for (const row of aliasRows) {
      const normalizedAliases = rowAliases(row).map(normalizeName).filter(Boolean)
      if (normalizedAliases.some((alias) => nameSet.has(alias))) byId.set(row.id as string, row)
    }

    return [...byId.values()].sort((a, b) => {
      const exactA = nameSet.has(a.normalized_name as string) ? 1 : 0
      const exactB = nameSet.has(b.normalized_name as string) ? 1 : 0
      return exactB - exactA
        || Number(b.mention_count || 0) - Number(a.mention_count || 0)
        || Number(b.last_seen_at || 0) - Number(a.last_seen_at || 0)
    })
  }

  private mergeNodeIdentityCollisions(names: string[], now = Date.now()): EntityNode | null {
    const normalizedNames = Array.from(new Set(names.map(normalizeName).filter(Boolean)))
    if (normalizedNames.length === 0) return null
    const rows = this.findNodeRowsByNames(normalizedNames)
    if (rows.length > 1) this.mergeDuplicateNameNodes(rows, now)
    const row = this.findNodeRowsByNames(normalizedNames)[0]
    return row ? rowToNode(row) : null
  }

  private mergeDuplicateNameNodes(rows: Record<string, unknown>[], now = Date.now()): void {
    if (rows.length < 2) return
    const db = getDb()
    const target = rows[0]
    const sources = rows.slice(1)

    const merge = db.transaction(() => {
      let aliases = JSON.parse((target.aliases_json as string) || '[]') as string[]
      let mentionCount = Number(target.mention_count || 0)
      let sourceCount = Number(target.source_count || 0)
      let firstSeenAt = Number(target.first_seen_at || now)
      let lastSeenAt = Number(target.last_seen_at || now)
      let type = target.type as EntityType

      for (const source of sources) {
        aliases = aliases.concat([source.name as string, ...rowAliases(source)])
        mentionCount += Number(source.mention_count || 0)
        sourceCount += Number(source.source_count || 0)
        firstSeenAt = Math.min(firstSeenAt, Number(source.first_seen_at || firstSeenAt))
        lastSeenAt = Math.max(lastSeenAt, Number(source.last_seen_at || lastSeenAt))
        if (type === 'other' && source.type !== 'other') type = source.type as EntityType

        const edgeRows = db.prepare(`
          SELECT *
          FROM entity_graph_edges
          WHERE from_node_id = ? OR to_node_id = ?
        `).all(source.id, source.id) as Record<string, unknown>[]

        for (const edge of edgeRows) {
          const fromNodeId = edge.from_node_id === source.id ? target.id as string : edge.from_node_id as string
          const toNodeId = edge.to_node_id === source.id ? target.id as string : edge.to_node_id as string
          if (fromNodeId === toNodeId) {
            db.prepare('DELETE FROM entity_graph_edges WHERE id = ?').run(edge.id)
            continue
          }

          const conflict = db.prepare(`
            SELECT *
            FROM entity_graph_edges
            WHERE from_node_id = ? AND relation = ? AND to_node_id = ? AND id != ?
          `).get(fromNodeId, edge.relation, toNodeId, edge.id) as Record<string, unknown> | undefined

          if (conflict) {
            db.prepare(`
              UPDATE entity_graph_edges
              SET confidence = MAX(confidence, ?),
                  evidence = ?,
                  mention_count = mention_count + ?,
                  first_seen_at = MIN(first_seen_at, ?),
                  last_seen_at = MAX(last_seen_at, ?)
              WHERE id = ?
            `).run(
              edge.confidence,
              edge.evidence || conflict.evidence || '',
              Number(edge.mention_count || 0),
              Number(edge.first_seen_at || now),
              Number(edge.last_seen_at || now),
              conflict.id,
            )
            db.prepare('DELETE FROM entity_graph_edges WHERE id = ?').run(edge.id)
            continue
          }

          db.prepare(`
            UPDATE entity_graph_edges
            SET from_node_id = ?, to_node_id = ?
            WHERE id = ?
          `).run(fromNodeId, toNodeId, edge.id)
        }

        db.prepare('DELETE FROM entity_graph_nodes WHERE id = ?').run(source.id)
      }

      db.prepare(`
        UPDATE entity_graph_nodes
        SET type = ?,
            aliases_json = ?,
            mention_count = ?,
            source_count = ?,
            first_seen_at = ?,
            last_seen_at = ?
        WHERE id = ?
      `).run(
        type,
        JSON.stringify(Array.from(new Set(aliases.map(cleanName).filter(Boolean))).slice(0, 16)),
        mentionCount,
        sourceCount,
        firstSeenAt,
        lastSeenAt,
        target.id,
      )
    })

    merge()
  }

  list(limit = 80, minImportance: ImportanceLevel = 0): GraphSnapshot {
    const db = getDb()
    const edgeLimit = limit
    const now = Date.now()
    const edgeRows = db.prepare(`
      WITH node_degrees AS (
        SELECT n.id AS id, COUNT(e.id) AS degree
        FROM entity_graph_nodes n
        LEFT JOIN entity_graph_edges e ON e.from_node_id = n.id OR e.to_node_id = n.id
        GROUP BY n.id
      )
      SELECT e.*, fn.name AS from_name, tn.name AS to_name,
        (e.importance * 10)
        + (e.mention_count * 3)
        + (MAX(fd.degree, td.degree) * 1.5)
        + (MAX(0, 96.0 - ((? - e.last_seen_at) / 3600000.0)) * 0.9)
        + CASE WHEN e.last_seen_at >= ? THEN 24 ELSE 0 END AS overview_score
      FROM entity_graph_edges e
      JOIN entity_graph_nodes fn ON fn.id = e.from_node_id
      JOIN entity_graph_nodes tn ON tn.id = e.to_node_id
      JOIN node_degrees fd ON fd.id = e.from_node_id
      JOIN node_degrees td ON td.id = e.to_node_id
      WHERE e.importance >= ?
      ORDER BY overview_score DESC, e.last_seen_at DESC
      LIMIT ?
    `).all(now, now - 24 * 60 * 60 * 1000, minImportance, edgeLimit) as Record<string, unknown>[]
    const edges = edgeRows.map(rowToEdge)
    const nodeIds = Array.from(new Set(edges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId])))

    if (nodeIds.length === 0) {
      return { nodes: [], edges }
    }

    const placeholders = nodeIds.map(() => '?').join(', ')
    const nodes = db.prepare(`
      SELECT * FROM entity_graph_nodes
      WHERE id IN (${placeholders})
    `).all(...nodeIds) as Record<string, unknown>[]
    return { nodes: hydrateNodeOrigins(applyEffectiveNodeImportance(nodes.map(rowToNode), edges)), edges }
  }

  listTopNodeOverview(limit = 80, minImportance: ImportanceLevel = 0): GraphWalkResult {
    const db = getDb()
    const maxRow = db.prepare(`
      SELECT MAX(importance) AS importance
      FROM entity_graph_nodes
      WHERE importance >= ?
    `).get(minImportance) as { importance: number | null } | undefined
    const topImportance = maxRow?.importance
    if (topImportance == null) return { seedNodes: [], nodes: [], edges: [] }

    const topNodeRows = db.prepare(`
      SELECT *
      FROM entity_graph_nodes
      WHERE importance = ?
      ORDER BY mention_count DESC, source_count DESC, last_seen_at DESC, name ASC
    `).all(topImportance) as Record<string, unknown>[]
    const seedIds = new Set(topNodeRows.map((row) => row.id as string))
    if (seedIds.size === 0) return { seedNodes: [], nodes: [], edges: [] }

    const edgeRows = db.prepare(`
      WITH top_nodes AS (
        SELECT id
        FROM entity_graph_nodes
        WHERE importance = ?
      )
      SELECT e.*, fn.name AS from_name, tn.name AS to_name,
        CASE
          WHEN e.from_node_id IN (SELECT id FROM top_nodes)
           AND e.to_node_id IN (SELECT id FROM top_nodes)
          THEN 1
          ELSE 0
        END AS connects_top_nodes
      FROM entity_graph_edges e
      JOIN entity_graph_nodes fn ON fn.id = e.from_node_id
      JOIN entity_graph_nodes tn ON tn.id = e.to_node_id
      WHERE (e.from_node_id IN (SELECT id FROM top_nodes) OR e.to_node_id IN (SELECT id FROM top_nodes))
        AND e.importance >= ?
      ORDER BY connects_top_nodes DESC, e.importance DESC, e.mention_count DESC, e.confidence DESC, e.last_seen_at DESC
      LIMIT ?
    `).all(topImportance, minImportance, limit) as Record<string, unknown>[]
    const edges = edgeRows.map(rowToEdge)

    const edgeIds = edges.map((edge) => edge.id)
    const edgeNodeClause = edgeIds.length
      ? `
        OR id IN (
          SELECT from_node_id FROM entity_graph_edges WHERE id IN (${edgeIds.map(() => '?').join(', ')})
          UNION
          SELECT to_node_id FROM entity_graph_edges WHERE id IN (${edgeIds.map(() => '?').join(', ')})
        )
      `
      : ''
    const nodeRows = db.prepare(`
      SELECT *
      FROM entity_graph_nodes
      WHERE importance = ?
      ${edgeNodeClause}
    `).all(topImportance, ...edgeIds, ...edgeIds) as Record<string, unknown>[]

    const nodes = hydrateNodeOrigins(applyEffectiveNodeImportance(nodeRows.map(rowToNode), edges))
    const seedNodes = nodes.filter((node) => seedIds.has(node.id))
    return { seedNodes, nodes, edges }
  }

  listRelationships(limit = 5000): GraphSnapshot {
    const db = getDb()
    const edgeRows = db.prepare(`
      SELECT e.*, fn.name AS from_name, tn.name AS to_name
      FROM entity_graph_edges e
      JOIN entity_graph_nodes fn ON fn.id = e.from_node_id
      JOIN entity_graph_nodes tn ON tn.id = e.to_node_id
      ORDER BY e.last_seen_at DESC, e.importance DESC, e.mention_count DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[]
    const edges = edgeRows.map(rowToEdge)
    const nodeIds = Array.from(new Set(edges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId])))

    if (nodeIds.length === 0) return { nodes: [], edges }

    const placeholders = nodeIds.map(() => '?').join(', ')
    const nodes = db.prepare(`
      SELECT * FROM entity_graph_nodes
      WHERE id IN (${placeholders})
    `).all(...nodeIds) as Record<string, unknown>[]
    return { nodes: hydrateNodeOrigins(applyEffectiveNodeImportance(nodes.map(rowToNode), edges)), edges }
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
    const query = normalizeName(text)
    const haystack = normalizeName([text, ...extraTexts].join(' '))
    if (!query && !haystack) return []
    const queryTokens = tokenizeEntityQuery(text)
    const fallbackTokens = queryTokens.length
      ? []
      : tokenizeEntityQuery(extraTexts.join(' ')).slice(0, MAX_SEED_SEARCH_TERMS)
    const tokens = [...queryTokens, ...fallbackTokens].slice(0, MAX_SEED_SEARCH_TERMS)
    const db = getDb()
    const scoreRows = (rows: Record<string, unknown>[], allowPrefix: boolean): EntityNode[] => {
      const scored = new Map<string, { node: EntityNode; score: number }>()
      for (const row of rows) {
        const node = rowToNode(row)
        const names = [node.normalizedName, ...node.aliases.map(normalizeName)].filter(Boolean)
        let score = 0
        for (const name of names) {
          if (query && name === query) score += 100
          else if (query && name.includes(query)) score += 80
          else if (query && query.includes(name) && name.length >= 3) score += 70
          if (haystack.includes(name) && name.length >= 3) score += 45
          for (const token of tokens) {
            if (name === token) score += 40
            else if (name.includes(token)) score += 24
            else if (token.includes(name) && name.length >= 3) score += 18
            else if (allowPrefix && token.length >= 4 && name.startsWith(token.slice(0, 3))) score += 8
          }
        }
        if (score > 0) {
          const existing = scored.get(node.id)
          if (!existing || score > existing.score) scored.set(node.id, { node, score })
        }
      }
      return [...scored.values()]
        .sort((a, b) => b.score - a.score || b.node.mentionCount - a.node.mentionCount || b.node.lastSeenAt - a.node.lastSeenAt)
        .slice(0, limit)
        .map((entry) => entry.node)
    }

    const exactNames = Array.from(new Set([query, ...tokens].filter(Boolean)))
    const exactRows = exactNames.length
      ? db.prepare(`
        SELECT *
        FROM entity_graph_nodes
        WHERE normalized_name IN (${exactNames.map(() => '?').join(', ')})
           OR ${exactNames.map(() => `aliases_json LIKE ? ESCAPE '\\'`).join(' OR ')}
        ORDER BY mention_count DESC, last_seen_at DESC
        LIMIT 120
      `).all(...exactNames, ...exactNames.map((name) => `%${escapeLike(name)}%`)) as Record<string, unknown>[]
      : []
    const exactSeeds = scoreRows(exactRows, false)
    if (exactSeeds.length > 0) return exactSeeds

    const prefixes = tokens
      .filter((token) => token.length >= 4)
      .map((token) => token.slice(0, 3))
      .filter((prefix, index, arr) => arr.indexOf(prefix) === index)
    const clauses: string[] = []
    const args: string[] = []
    if (query) {
      clauses.push(`normalized_name LIKE ? ESCAPE '\\'`, `aliases_json LIKE ? ESCAPE '\\'`)
      args.push(`%${escapeLike(query)}%`, `%${escapeLike(query)}%`)
    }
    for (const prefix of prefixes) {
      clauses.push(`normalized_name LIKE ? ESCAPE '\\'`, `aliases_json LIKE ? ESCAPE '\\'`)
      args.push(`${escapeLike(prefix)}%`, `%"${escapeLike(prefix)}%`)
    }

    const rows = clauses.length
      ? db.prepare(`
        SELECT * FROM entity_graph_nodes
        WHERE ${clauses.join(' OR ')}
        ORDER BY mention_count DESC, last_seen_at DESC
        LIMIT 120
      `).all(...args) as Record<string, unknown>[]
      : []
    return scoreRows(rows, true)
  }

  suggestNodes(text: string, limit = 8): EntityNode[] {
    const query = normalizeName(text)
    if (query.length < 1) return []
    const pattern = `%${escapeLike(query)}%`
    const startsWith = `${escapeLike(query)}%`
    const rows = getDb().prepare(`
      SELECT *
      FROM entity_graph_nodes
      WHERE normalized_name LIKE ? ESCAPE '\\'
         OR aliases_json LIKE ?
      ORDER BY
        CASE WHEN normalized_name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
        mention_count DESC,
        last_seen_at DESC
      LIMIT ?
    `).all(pattern, `%${query}%`, startsWith, limit) as Record<string, unknown>[]
    return rows.map(rowToNode)
  }

  walk(seedNodeIds: string[], depth = 2, edgeLimit = 40, minImportance: ImportanceLevel = 0, opts: GraphWalkOptions = {}): GraphWalkResult {
    const seedIds = Array.from(new Set(seedNodeIds.filter(Boolean)))
    if (seedIds.length === 0) return { seedNodes: [], nodes: [], edges: [] }

    const db = getDb()
    const nodeIds = new Set(seedIds)
    const edgeMap = new Map<string, EntityEdge>()
    const seedIdSet = new Set(seedIds)
    const sourceIds = new Set((opts.sourceIds || []).filter(Boolean))
    const contextText = normalizeName(opts.contextText || '')
    const contextTokens = tokenizeEntityQuery(opts.contextText || '').slice(0, MAX_SEED_SEARCH_TERMS)
    const shouldRankByContext = sourceIds.size > 0 || contextText.length > 0
    let frontier = seedIds
    const maxDepth = Math.max(Math.floor(depth), 1)
    const perDepthLimit = Math.max(Math.ceil(edgeLimit / maxDepth), 1)

    for (let d = 0; d < maxDepth && frontier.length > 0 && edgeMap.size < edgeLimit; d++) {
      const placeholders = frontier.map(() => '?').join(', ')
      const remainingLimit = Math.max(edgeLimit - edgeMap.size, 1)
      const layerLimit = d === maxDepth - 1
        ? remainingLimit
        : Math.min(perDepthLimit, remainingLimit)
      const candidateLimit = shouldRankByContext
        ? Math.min(Math.max(layerLimit * 6, layerLimit + 16), 120)
        : layerLimit
      const rows = db.prepare(`
        SELECT e.*, fn.name AS from_name, tn.name AS to_name
        FROM entity_graph_edges e
        JOIN entity_graph_nodes fn ON fn.id = e.from_node_id
        JOIN entity_graph_nodes tn ON tn.id = e.to_node_id
        WHERE (e.from_node_id IN (${placeholders}) OR e.to_node_id IN (${placeholders}))
          AND e.importance >= ?
        ORDER BY e.confidence DESC, e.mention_count DESC, e.last_seen_at DESC
        LIMIT ?
      `).all(...frontier, ...frontier, minImportance, candidateLimit) as Record<string, unknown>[]

      const rankedEdges = rows.map(rowToEdge)
        .map((edge, index) => ({
          edge,
          index,
          relevance: shouldRankByContext
            ? scoreEdgeRelevance(edge, seedIdSet, sourceIds, contextText, contextTokens)
            : 0,
        }))
        .filter((entry) => {
          if (!shouldRankByContext || d === 0) return true
          return entry.relevance > 0
        })
        .sort((a, b) =>
          b.relevance - a.relevance ||
          b.edge.importance - a.edge.importance ||
          b.edge.confidence - a.edge.confidence ||
          b.edge.mentionCount - a.edge.mentionCount ||
          b.edge.lastSeenAt - a.edge.lastSeenAt ||
          a.index - b.index
        )
        .slice(0, layerLimit)

      const next = new Set<string>()
      for (const { edge } of rankedEdges) {
        if (!edgeMap.has(edge.id)) edgeMap.set(edge.id, edge)
        for (const id of [edge.fromNodeId, edge.toNodeId]) {
          if (!nodeIds.has(id)) {
            nodeIds.add(id)
            next.add(id)
          }
        }
      }
      frontier = Array.from(next)
    }

    const allIds = Array.from(nodeIds)
    const placeholders = allIds.map(() => '?').join(', ')
    const nodeRows = placeholders
      ? db.prepare(`SELECT * FROM entity_graph_nodes WHERE id IN (${placeholders})`).all(...allIds) as Record<string, unknown>[]
      : []
    const nodes = hydrateNodeOrigins(applyEffectiveNodeImportance(nodeRows.map(rowToNode), Array.from(edgeMap.values())))
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
  }): Promise<{ insertedOrUpdated: number; deleted: number; touchedEdgeIds: string[] }> {
    return this.extractFromContent({
      content: `<user>\n${opts.userMessage.slice(0, 4000)}\n</user>\n\n<assistant>\n${opts.assistantResponse.slice(0, 4000)}\n</assistant>`,
      sourceId: opts.conversationId,
      sourceKind: 'conversation',
      providerId: opts.providerId,
      model: opts.model,
      signal: opts.signal,
      systemPrompt: 'Extract durable named entities and explicit relationships from a chat turn.',
    })
  }

  async extractFromContent(opts: {
    content: string
    sourceId: string
    sourceKind?: string
    providerId?: string
    model?: string
    signal?: AbortSignal
    systemPrompt?: string
    replaceSourceIds?: string[]
  }): Promise<{ insertedOrUpdated: number; deleted: number; touchedEdgeIds: string[] }> {
    const gateway = getGateway()
    const provider = opts.providerId
      ? gateway.getProvider(opts.providerId) || gateway.getLastUsedProvider()
      : gateway.getLastUsedProvider()

    const systemContent = [
      opts.systemPrompt || 'Extract durable named entities and explicit relationships from the provided content.',
      'Return strict JSON only: an array of objects with keys action, from, relation, to, importance, confidence, evidence.',
      'action is "assert" for facts that are true now, or "delete" for facts explicitly corrected, negated, or no longer true.',
      'from and to are objects with name, type, and optional aliases.',
      'Allowed types: person, place, organization, project, event, date, technology, product, artifact, concept, other.',
      'Only include facts that would remain useful later. Skip vague, temporary, or unsupported claims.',
      'Set importance as 0 for throwaway context, 1 for minor context, 2 for useful durable facts, 3 for core facts about a user, project, preference, goal, identity, or long-running work.',
      'Use concise snake_case relation names such as works_at, depends_on, located_in, owns, uses, met_on, discussed_with.',
      'When a fact changes, emit a delete for the old relationship if the turn names it, and an assert for the replacement.',
      "Evidence should be one short sentence on why the fact is true.",
      'If there are no durable relationships, return [].'
    ].join('\n')

    const result = await gateway.complete({
      model: opts.model || provider.config.defaultModel,
      signal: opts.signal,
      maxTokens: 4096,
      temperature: 0,
      thinkingEnabled: false,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: opts.content.slice(0, 8000) }
      ]
    }, provider.config.id)

    const rawRelations = parseJsonArray(result.content)
    let count = 0
    let deleted = 0
    const touchedEdgeIds: string[] = []
    const now = Date.now()
    for (const sourceId of Array.from(new Set(opts.replaceSourceIds || [])).filter(Boolean)) {
      deleted += this.deleteEdgesBySourceId(sourceId).edgesDeleted
    }
    for (const item of rawRelations.slice(0, 24)) {
      if (!item || typeof item !== 'object') continue
      const obj = item as { action?: unknown; from?: unknown; relation?: unknown; to?: unknown; importance?: unknown; confidence?: unknown; evidence?: unknown }
      const from = toEntity(obj.from)
      const to = toEntity(obj.to)
      if (!from || !to || typeof obj.relation !== 'string') continue
      const extracted = {
        action: obj.action === 'delete' ? 'delete' as const : 'assert' as const,
        from,
        relation: obj.relation,
        to,
        importance: inferImportance(obj.importance, obj.relation, opts.sourceKind || 'content'),
        confidence: clampConfidence(obj.confidence),
        evidence: typeof obj.evidence === 'string' ? obj.evidence : ''
      }
      if (extracted.action === 'delete') {
        if (this.deleteMatchingEdge(extracted).edgeDeleted) deleted++
        continue
      }
      const edge = this.upsertEdge(extracted, opts.sourceKind || 'content', opts.sourceId, now)
      if (edge) {
        count++
        touchedEdgeIds.push(edge.id)
      }
    }
    return { insertedOrUpdated: count, deleted, touchedEdgeIds }
  }

  deleteEdgesBySourceId(sourceId: string): { edgesDeleted: number; orphanedNodeIds: string[] } {
    const db = getDb()
    const edges = db.prepare(`
      SELECT id, from_node_id, to_node_id FROM entity_graph_edges WHERE source_id = ?
    `).all(sourceId) as { id: string; from_node_id: string; to_node_id: string }[]

    if (edges.length === 0) return { edgesDeleted: 0, orphanedNodeIds: [] }

    const allOrphanedNodeIds = new Set<string>()

    db.transaction(() => {
      // Delete all edges
      db.prepare('DELETE FROM entity_graph_edges WHERE source_id = ?').run(sourceId)

      // Collect all nodes involved in deleted edges
      const involvedNodeIds = new Set<string>()
      for (const edge of edges) {
        involvedNodeIds.add(edge.from_node_id)
        involvedNodeIds.add(edge.to_node_id)
      }

      // Check which nodes are now orphaned (no remaining edges)
      for (const nodeId of involvedNodeIds) {
        const remaining = db.prepare(`
          SELECT 1 FROM entity_graph_edges WHERE from_node_id = ? OR to_node_id = ? LIMIT 1
        `).get(nodeId, nodeId)
        if (!remaining) {
          allOrphanedNodeIds.add(nodeId)
        }
      }

      // Delete orphaned nodes
      for (const nodeId of allOrphanedNodeIds) {
        db.prepare('DELETE FROM entity_graph_nodes WHERE id = ?').run(nodeId)
      }
    })()

    return {
      edgesDeleted: edges.length,
      orphanedNodeIds: Array.from(allOrphanedNodeIds)
    }
  }

  formatWalk(walk: GraphWalkResult): string {
    if (walk.edges.length === 0) return ''
    const importanceLabel = (level: ImportanceLevel): string =>
      ['temporary', 'minor', 'useful', 'core'][level] || 'minor'
    return '## Entity Graph Context\n' + walk.edges.map((edge) => {
      const relation = edge.relation.replace(/_/g, ' ')
      const evidence = edge.evidence ? ` Evidence: ${edge.evidence}` : ''
      return `- [${importanceLabel(edge.importance)}] ${edge.fromName} -> ${relation} -> ${edge.toName}.${evidence}`
    }).join('\n')
  }
}

let graphInstance: EntityGraphStore | null = null

export function getEntityGraphStore(): EntityGraphStore {
  if (!graphInstance) graphInstance = new EntityGraphStore()
  return graphInstance
}
