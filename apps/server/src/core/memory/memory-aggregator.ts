import { getAgentMemory } from './agent-memory.js'
import { getDb } from '../../db/database.js'
import type { RetrievedChunk } from './parser.js'

export interface AggregatedMemory {
  permanent: RetrievedChunk[]
}

/**
 * Aggregates memory from all sources: permanent memory, task memory, and history.
 * Deduplicates and ranks results for injection into the agent's context.
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
      permanentTopK?: number
    }
  ): Promise<AggregatedMemory> {
    const permanentMem = getAgentMemory()

    // Build a filter covering all assigned memory spaces
    let spaceFilter: string | undefined
    const spaceNameMap = new Map<string, string>()
    if (opts?.agentId) {
      try {
        const db = getDb()
        const rows = db.prepare(`
          SELECT ms.id, ms.name
          FROM agent_memory_spaces ams
          JOIN memory_spaces ms ON ms.id = ams.space_id
          WHERE ams.agent_id = ?
        `).all(opts.agentId) as { id: string; name: string }[]
        if (rows.length > 0) {
          for (const row of rows) spaceNameMap.set(row.id, row.name)
          const quoted = rows.map(r => `'${r.id.replace(/'/g, "''")}'`).join(', ')
          spaceFilter = `spaceId IN (${quoted})`
        }
      } catch { /* DB not ready */ }
    }

    const permanent = await permanentMem.recall(query, opts?.permanentTopK ?? 3, spaceFilter).catch(() => [])

    // Deduplicate by text similarity (exact match)
    const seen = new Set<string>()
    const dedup = (chunks: RetrievedChunk[]): RetrievedChunk[] =>
      chunks.filter((c) => {
        const key = c.text.slice(0, 100)
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
          const filter = spaceId ? `spaceId = '${spaceId.replace(/'/g, "''")}'` : spaceFilter
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
      }
    }

    return { permanent: dedupedPermanent }
  }

  /**
   * Format aggregated memory into a string for injection into system prompt.
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
          } else if (c.spaceName) {
            parts.push(`[${c.spaceName}]`)
          }
          parts.push(c.text)
          return `- ${parts.join(' ')}`
        }).join('\n')
      )
    }

    return sections.join('\n\n')
  }
}

let aggregatorInstance: MemoryAggregator | null = null

export function getMemoryAggregator(): MemoryAggregator {
  if (!aggregatorInstance) {
    aggregatorInstance = new MemoryAggregator()
  }
  return aggregatorInstance
}
