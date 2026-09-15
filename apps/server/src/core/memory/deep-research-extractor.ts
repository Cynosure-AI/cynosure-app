import { getGateway } from '../gateway/gateway.js'
import { recordAuxiliaryModelUsage } from '../usage-metering.js'
import type { DeepResearchExtractedChunkSummary, DeepResearchExtractedChunkTags, DeepResearchExtractedEntity, DeepResearchExtractedMention, DeepResearchExtractedRelation } from './memory-knowledge.js'
import type { KnowledgeEntityType, ImportanceLevel } from './knowledge-types.js'

export interface DeepResearchSegment {
  content: string
  chunkIndex?: number
  chunkIndexes?: number[]
}

export interface DeepResearchResult {
  relations: DeepResearchExtractedRelation[]
  mentions: DeepResearchExtractedMention[]
  chunkTags: DeepResearchExtractedChunkTags[]
  chunkSummaries: DeepResearchExtractedChunkSummary[]
}

const ENTITY_TYPES = new Set<KnowledgeEntityType>(['person', 'place', 'organization', 'project', 'event', 'date', 'technology', 'product', 'artifact', 'concept', 'other'])
const RESERVED_ENTITY_NAMES = new Set(['user', 'assistant', 'system', 'tool'])

function normalizeName(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s._-]/gu, ' ').replace(/\s+/g, ' ').trim()
    : ''
}

function cleanDisplay(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : ''
}

export function normalizeKnowledgeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const tags: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const tag = raw.normalize('NFKC')
      .replace(/^\s*#+\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[,;:|._-]+|[,;:|._-]+$/g, '')
      .trim()
      .toLocaleLowerCase()
      .slice(0, 80)
      .trim()
    if (tag.length < 2 || !/[\p{L}\p{N}]/u.test(tag) || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  return tags.slice(0, 12)
}

export function mergeDeepResearchChunkTags(chunkTags: DeepResearchExtractedChunkTags[]): string[] {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const chunk of [...chunkTags].sort((a, b) => a.sourceChunkIndex - b.sourceChunkIndex)) {
    for (const tag of normalizeKnowledgeTags(chunk.tags)) {
      if (seen.has(tag)) continue
      seen.add(tag)
      merged.push(tag)
    }
  }
  return merged
}

function parseJsonArray(raw: string): unknown[] {
  const fenced = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  try {
    const parsed = JSON.parse(fenced) as unknown
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { relations?: unknown[] }).relations)) {
      return (parsed as { relations: unknown[] }).relations
    }
  } catch {
    const start = fenced.indexOf('[')
    const end = fenced.lastIndexOf(']')
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(fenced.slice(start, end + 1)) as unknown
        if (Array.isArray(parsed)) return parsed
      } catch { /* malformed model output */ }
    }
  }
  return []
}

function toEntity(value: unknown): DeepResearchExtractedEntity | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const name = cleanDisplay(raw.name, 120)
  const normalized = normalizeName(name)
  if (normalized.length < 2 || RESERVED_ENTITY_NAMES.has(normalized)) return null
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases.map((alias) => cleanDisplay(alias, 120)).filter(Boolean).slice(0, 8)
    : []
  return {
    name,
    type: typeof raw.type === 'string' && ENTITY_TYPES.has(raw.type as KnowledgeEntityType) ? raw.type as KnowledgeEntityType : 'other',
    aliases,
    identityHint: cleanDisplay(raw.identity_hint ?? raw.identityHint, 160) || undefined,
    description: cleanDisplay(raw.description, 280) || undefined,
  }
}

function importance(value: unknown): ImportanceLevel {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(3, Math.round(value))) as ImportanceLevel
    : 2
}

export async function deepResearchContent(opts: {
  segments: DeepResearchSegment[]
  providerId?: string
  model?: string
  signal?: AbortSignal
  onProgress?: (current: number, total: number) => void
  initialResult?: Omit<DeepResearchResult, 'chunkSummaries'> & { chunkSummaries?: DeepResearchExtractedChunkSummary[] }
  onCheckpoint?: (result: DeepResearchResult) => void
}): Promise<DeepResearchResult> {
  const gateway = getGateway()
  const provider = opts.providerId
    ? gateway.getProvider(opts.providerId) || gateway.getLastUsedProvider()
    : gateway.getLastUsedProvider()
  const systemContent = [
    'Extract durable named entities and explicit relationships from this saved memory document.',
    'Return strict JSON only: an array of objects. Relationship objects use keys action, from, relation, to, object_value, importance, note, source_chunk_index, valid_from, valid_to, observed_at.',
    'action is "assert" for supported facts, "delete" for facts explicitly corrected or no longer true, "mention" for a durable named entity without a relationship, "tags" for chunk keywords, or "summary" for the chunk summary.',
    'A summary object uses keys action="summary", summary, and source_chunk_index.',
    'For every source chunk, return exactly one summary object containing a faithful 1-2 sentence summary in the source language.',
    'A mention object uses keys action, entity, note, and source_chunk_index.',
    'For every source chunk, return exactly one tags object with keys action="tags", tags, and source_chunk_index.',
    'tags must contain 3-8 concise, specific keywords or short keyphrases that describe the chunk for document discovery. Use the source language, lowercase text, no # prefix, and avoid generic words such as document, information, notes, relationship, or person.',
    'from and to are objects with name, type, optional aliases, optional identity_hint, and optional description.',
    'Use to for a named entity and object_value for a scalar or structured literal.',
    'identity_hint must be a stable disambiguator stated in the source. Never invent one.',
    'Allowed types: person, place, organization, project, event, date, technology, product, artifact, concept, other.',
    'Only include durable, source-supported facts. Do not infer facts from general knowledge.',
    'source_chunk_index must identify the one numbered evidence chunk that directly supports the item.',
    'note must be a concise neutral sentence explaining the extracted entity or fact in useful context. Use only information stated in the evidence chunk; do not add assumptions.',
    'Importance: 0 throwaway, 1 minor, 2 useful durable fact, 3 core identity, project, preference, goal, or long-running context.',
    'Prefer: works_at, belongs_to, located_in, uses, depends_on, owns, created, prefers, knows, parent_of, child_of, partner_of, reports_to, manages, participated_in, occurred_on, has_goal, has_role, related_to.',
    'Use ISO-8601 valid_from/valid_to/observed_at only when explicitly stated.',
    'Always return the tags and summary objects for the source chunk; omit relationship and mention objects when nothing durable and grounded is present.',
  ].join('\n')

  const relations: DeepResearchExtractedRelation[] = [...(opts.initialResult?.relations || [])]
  const mentions: DeepResearchExtractedMention[] = [...(opts.initialResult?.mentions || [])]
  const tagsByChunk = new Map<number, string[]>((opts.initialResult?.chunkTags || []).map((item) => [item.sourceChunkIndex, item.tags]))
  const summariesByChunk = new Map<number, string>((opts.initialResult?.chunkSummaries || []).map((item) => [item.sourceChunkIndex, item.summary]))
  const totalSegments = opts.segments.length
  for (let segmentIndex = 0; segmentIndex < totalSegments; segmentIndex++) {
    const segment = opts.segments[segmentIndex]
    const response = await gateway.complete({
      model: opts.model || provider.config.defaultModel,
      signal: opts.signal,
      maxTokens: 8192,
      temperature: 0,
      thinkingEnabled: false,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: segment.content },
      ],
    }, provider.config.id)

    recordAuxiliaryModelUsage({
      kind: 'deep-research',
      provider: provider.config.id,
      model: response.model || opts.model || provider.config.defaultModel,
      inputTokens: response.usage?.promptTokens,
      outputTokens: response.usage?.completionTokens,
      requestCount: 1,
    })

    for (const item of parseJsonArray(response.content)) {
      if (!item || typeof item !== 'object') continue
      const raw = item as Record<string, unknown>
      const parsedIndex = typeof raw.source_chunk_index === 'string' && /^\d+$/.test(raw.source_chunk_index.trim())
        ? Number(raw.source_chunk_index)
        : raw.source_chunk_index
      const requestedIndex = typeof parsedIndex === 'number' && Number.isInteger(parsedIndex) ? parsedIndex : undefined
      const sourceChunkIndex = requestedIndex !== undefined && segment.chunkIndexes?.includes(requestedIndex)
        ? requestedIndex
        : segment.chunkIndex
      if (raw.action === 'tags') {
        if (sourceChunkIndex === undefined) continue
        const combined = normalizeKnowledgeTags([
          ...(tagsByChunk.get(sourceChunkIndex) || []),
          ...(Array.isArray(raw.tags) ? raw.tags : []),
        ])
        tagsByChunk.set(sourceChunkIndex, combined)
        continue
      }
      if (raw.action === 'summary') {
        if (sourceChunkIndex === undefined) continue
        const summary = cleanDisplay(raw.summary, 1200)
        if (summary) summariesByChunk.set(sourceChunkIndex, summary)
        continue
      }
      const note = cleanDisplay(raw.note, 600)
      if (sourceChunkIndex === undefined || !note) continue
      if (raw.action === 'mention') {
        const entity = toEntity(raw.entity)
        if (entity) mentions.push({ entity, sourceChunkIndex, note })
        continue
      }
      const from = toEntity(raw.from)
      const to = toEntity(raw.to)
      if (!from || (!to && raw.object_value === undefined) || typeof raw.relation !== 'string') continue
      relations.push({
        action: raw.action === 'delete' ? 'delete' : 'assert',
        from,
        relation: raw.relation,
        to: to || undefined,
        objectValue: to ? undefined : raw.object_value,
        importance: importance(raw.importance),
        note,
        sourceChunkIndex,
        validFrom: typeof raw.valid_from === 'string' || typeof raw.valid_from === 'number' ? raw.valid_from : undefined,
        validTo: typeof raw.valid_to === 'string' || typeof raw.valid_to === 'number' ? raw.valid_to : undefined,
        observedAt: typeof raw.observed_at === 'string' || typeof raw.observed_at === 'number' ? raw.observed_at : undefined,
      })
    }
    const checkpoint = {
      relations: [...relations],
      mentions: [...mentions],
      chunkTags: [...tagsByChunk.entries()]
        .sort(([a], [b]) => a - b)
        .map(([sourceChunkIndex, tags]) => ({ sourceChunkIndex, tags })),
      chunkSummaries: [...summariesByChunk.entries()]
        .sort(([a], [b]) => a - b)
        .map(([sourceChunkIndex, summary]) => ({ sourceChunkIndex, summary })),
    }
    opts.onCheckpoint?.(checkpoint)
    opts.onProgress?.(segmentIndex + 1, totalSegments)
  }
  return {
    relations,
    mentions,
    chunkTags: [...tagsByChunk.entries()]
      .sort(([a], [b]) => a - b)
      .map(([sourceChunkIndex, tags]) => ({ sourceChunkIndex, tags })),
    chunkSummaries: [...summariesByChunk.entries()]
      .sort(([a], [b]) => a - b)
      .map(([sourceChunkIndex, summary]) => ({ sourceChunkIndex, summary })),
  }
}
