import { getAgentMemory } from './agent-memory.js'
import { getDb } from '../../db/database.js'
import { buildMemorySpaceFilter, getAllMemorySpaces, getAssignedOrDefaultSpaces } from './memory-space-scope.js'
import type { RetrievedChunk } from './parser.js'
import { getEntityGraphStore, type GraphWalkResult } from './entity-graph.js'

export interface AggregatedMemory {
  permanent: RetrievedChunk[]
  graph?: GraphWalkResult
}

/**
 * Aggregates memory from all sources: permanent memory, task memory, and history.
 * Deduplicates and ranks results for injection into the agent's context.
 * 
 * Fallback logic:
 * - If explicit space IDs are provided → query only those spaces
 * - If an agent is provided → query only that agent's assigned spaces
 * - If an agent has no assignments → return no memory
 * - If no agent or explicit scope is provided → query all memory folders
 */
export class MemoryAggregator {
  /**
   * Retrieve relevant context from all memory sources for a query.
   * Enriches each chunk with totalChunks for the same source file.
   */
  async aggregate(
    query: string,
    opts?: {
      conversationId?: string
      agentId?: string
      spaceIds?: string[]
      permanentTopK?: number
      /** Add a small, source-grounded relationship supplement to RAG passages. */
      includeGraph?: boolean
    }
  ): Promise<AggregatedMemory> {
    const permanentMem = getAgentMemory()

    let spaceFilter: string | undefined
    const spaceNameMap = new Map<string, string>()

    let scopedSpaces: { id: string; name: string }[] = []

    if (Array.isArray(opts?.spaceIds)) {
      try {
        const db = getDb()
        const uniqueSpaceIds = [...new Set(opts.spaceIds.map((s) => s.trim()).filter(Boolean))]
        if (uniqueSpaceIds.length > 0) {
          const placeholders = uniqueSpaceIds.map(() => '?').join(', ')
          scopedSpaces = db.prepare(`SELECT id, name FROM memory_spaces WHERE id IN (${placeholders})`).all(...uniqueSpaceIds) as { id: string; name: string }[]
          // Explicit scopes are security boundaries. A stale or invalid ID
          // must never broaden or partially alter the requested scope.
          if (!hasExactMemorySpaceScope(uniqueSpaceIds, scopedSpaces)) {
            return { permanent: [], graph: undefined }
          }
        }
      } catch { /* DB not ready */ }
    } else if (opts?.agentId) {
      scopedSpaces = getAssignedOrDefaultSpaces(opts.agentId)
      if (scopedSpaces.length === 0) {
        return { permanent: [], graph: undefined }
      }
    } else {
      scopedSpaces = getAllMemorySpaces()
    }

    if (Array.isArray(opts?.spaceIds) && scopedSpaces.length === 0) {
      return { permanent: [], graph: undefined }
    }

    if (scopedSpaces.length > 0) {
      for (const row of scopedSpaces) spaceNameMap.set(row.id, row.name)
      spaceFilter = buildMemorySpaceFilter(scopedSpaces)
    }

    const permanent = await permanentMem.recall(query, opts?.permanentTopK ?? 3, spaceFilter).catch(() => [])

    // Deduplicate exact normalized chunks. Prefix-only deduplication can merge
    // unrelated chunks that happen to begin with the same heading/template.
    const seen = new Set<string>()
    const dedup = (chunks: RetrievedChunk[]): RetrievedChunk[] =>
      chunks.filter((c) => {
        const key = c.contentHash || c.text.replace(/\s+/g, ' ').trim()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    const dedupedPermanent = dedup(permanent)

    // Enrich chunks with totalChunks per source file
    const uniqueSourceKeys = [...new Set(
      dedupedPermanent
        .filter(c => c.sourceFile)
        .map(c => `${c.sourceFile!}\u0000${c.spaceId || ''}`)
    )]
    if (uniqueSourceKeys.length > 0) {
      const counts = await Promise.all(
        uniqueSourceKeys.map(key => {
          const [sf, spaceId] = key.split('\u0000')
          const filter = spaceId ? buildMemorySpaceFilter([{ id: spaceId }]) : spaceFilter
          return permanentMem.countChunks(sf, filter)
        })
      )
      const countMap = new Map(uniqueSourceKeys.map((key, i) => [key, counts[i]]))
      for (const chunk of dedupedPermanent) {
        const key = chunk.sourceFile ? `${chunk.sourceFile}\u0000${chunk.spaceId || ''}` : undefined
        if (key && countMap.has(key)) {
          chunk.totalChunks = countMap.get(key)
        }
      }
    }

    if (spaceNameMap.size === 0) {
      try {
        const db = getDb()
        const rows = db.prepare('SELECT id, name FROM memory_spaces').all() as { id: string; name: string }[]
        for (const row of rows) spaceNameMap.set(row.id, row.name)
      } catch { /* DB not ready */ }
    }

    for (const chunk of dedupedPermanent) {
      if (chunk.spaceId) {
        chunk.spaceName = spaceNameMap.get(chunk.spaceId)
        if (chunk.sourceFile) {
          const ref = permanentMem.getDocumentReference(chunk.spaceId, chunk.sourceFile)
          chunk.documentId = ref?.documentId
          chunk.revision = ref?.revision
        }
      }
    }

    let graphWalk: GraphWalkResult | undefined
    if (opts?.includeGraph === true && scopedSpaces.length > 0) {
      try {
        const graph = getEntityGraphStore()
        const seedNodes = graph.findSeedNodes(query, dedupedPermanent.map((chunk) => chunk.text), 8)
        graphWalk = seedNodes.length > 0
          ? graph.focusedWalk(seedNodes.map((node) => node.id), query, 1, 8, 0, {
            // The graph may bridge from a retrieved document to another
            // document, but never outside the caller's memory-space boundary.
            sourceIdPrefixes: scopedSpaces.map((space) => `memory:${space.id}:`),
            contextText: [query, ...dedupedPermanent.map((chunk) => chunk.text)].join(' '),
          })
          : undefined
      } catch (err) {
        console.warn('[memory-aggregator] Entity graph enrichment failed; returning semantic memory only:', err)
      }
    }

    return { permanent: dedupedPermanent, graph: graphWalk }
  }

  /**
   * Format aggregated memory as evidence. The caller must place it below
   * system authority and mark it as untrusted data.
   * Includes chunk index information so the LLM can request more context.
   */
  format(memory: AggregatedMemory): string {
    const sections: string[] = []

    if (memory.permanent.length > 0) {
      sections.push(
        '## Relevant Knowledge\n' +
        memory.permanent.map((c) => {
          const parts: string[] = []
          if (c.sourceFile) {
            const idx = c.chunkIndex != null ? c.chunkIndex + 1 : null
            const total = c.totalChunks ?? null
            const label = c.spaceName ? `${c.spaceName} · ${c.sourceFile}` : c.sourceFile
            if (idx != null && total != null) {
              parts.push(`[${label} · Part ${idx}/${total}]`)
            } else if (idx != null) {
              parts.push(`[${label} · Part ${idx}]`)
            } else {
              parts.push(`[${label}]`)
            }
            if (c.sectionPath && c.sectionPath !== c.documentTitle) {
              parts.push(`[Section: ${c.sectionPath}]`)
            }
            if (c.documentId && c.revision) {
              parts.push(`[documentId=${c.documentId}, revision=${c.revision}]`)
            }
          } else if (c.spaceName) {
            parts.push(`[${c.spaceName}]`)
          }
          parts.push(c.text)
          return `- ${parts.join(' ')}`
        }).join('\n')
      )
    }

    if (memory.graph && memory.graph.edges.length > 0) {
      sections.push(getEntityGraphStore().formatWalk(memory.graph))
    }

    return sections.join('\n\n')
  }
}

export function hasExactMemorySpaceScope(
  requestedIds: string[],
  resolvedSpaces: Array<{ id: string }>,
): boolean {
  const requested = new Set(requestedIds.map((id) => id.trim()).filter(Boolean))
  const resolved = new Set(resolvedSpaces.map((space) => space.id))
  return requested.size === resolved.size && Array.from(requested).every((id) => resolved.has(id))
}

let aggregatorInstance: MemoryAggregator | null = null

export function getMemoryAggregator(): MemoryAggregator {
  if (!aggregatorInstance) {
    aggregatorInstance = new MemoryAggregator()
  }
  return aggregatorInstance
}
