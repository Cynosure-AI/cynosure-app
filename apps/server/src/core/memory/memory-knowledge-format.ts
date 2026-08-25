import type { EntityNode, EntityOrigin, EntityType, ImportanceLevel } from './knowledge-types.js'

const QUERY_STOP_WORDS = new Set([
  'about', 'after', 'also', 'and', 'are', 'between', 'das', 'dem', 'den', 'der', 'die', 'ein', 'eine',
  'for', 'from', 'has', 'hat', 'how', 'ist', 'mit', 'oder', 'the', 'their', 'this', 'und', 'von', 'was',
  'what', 'where', 'which', 'who', 'wie', 'with', 'wo', 'zwischen',
])

/** Normalizes user and model supplied labels for identity matching and search. */
export function normalizeKnowledgeLabel(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase().normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s._-]/gu, ' ')
    .replace(/\s+/g, ' ')
}

/** Keeps graph labels and notes compact without leaking whitespace differences into persistence. */
export function cleanKnowledgeDisplay(value: unknown, maxLength = 240): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

export function knowledgeQueryTerms(query: string): string[] {
  return Array.from(new Set(
    normalizeKnowledgeLabel(query)
      .split(/[\s._-]+/)
      .filter((term) => term.length >= 3 && !QUERY_STOP_WORDS.has(term)),
  )).slice(0, 32)
}

export function formatKnowledgeLiteral(value: unknown): string {
  if (typeof value !== 'string') return String(value ?? '')
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
  } catch {
    return value
  }
}

export function knowledgeRowToNode(
  row: Record<string, unknown>,
  sourceCount = 1,
  origins?: EntityOrigin[],
): EntityNode {
  return {
    id: String(row.id),
    name: String(row.canonical_name),
    normalizedName: String(row.normalized_name),
    type: (row.entity_type || 'other') as EntityType,
    aliases: row.aliases ? String(row.aliases).split('\u0000').filter(Boolean) : [],
    importance: Math.min(3, Math.max(0, Number(row.importance || 1))) as ImportanceLevel,
    mentionCount: Number(row.mention_count || 1),
    sourceCount,
    origins,
    firstSeenAt: Number(row.created_at || 0),
    lastSeenAt: Number(row.updated_at || 0),
  }
}
