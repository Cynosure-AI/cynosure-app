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
    if (opts?.agentId) {
      try {
        const db = getDb()
        const rows = db.prepare('SELECT space_id FROM agent_memory_spaces WHERE agent_id = ?').all(opts.agentId) as { space_id: string }[]
        if (rows.length > 0) {
          const quoted = rows.map(r => `'${r.space_id.replace(/'/g, "''")}'`).join(', ')
          spaceFilter = `spaceId IN (${quoted})`
        }
      } catch { /* DB not ready */ }
    }

    // No assigned spaces means no memory available
    if (!spaceFilter) {
      return { permanent: [] }
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
    const uniqueSources = [...new Set(dedupedPermanent.filter(c => c.sourceFile).map(c => c.sourceFile!))]
    if (uniqueSources.length > 0) {
      const counts = await Promise.all(
        uniqueSources.map(sf => permanentMem.countChunks(sf, spaceFilter))
      )
      const countMap = new Map(uniqueSources.map((sf, i) => [sf, counts[i]]))
      for (const chunk of dedupedPermanent) {
        if (chunk.sourceFile && countMap.has(chunk.sourceFile)) {
          chunk.totalChunks = countMap.get(chunk.sourceFile)
        }
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
            if (idx != null && total != null) {
              parts.push(`[${c.sourceFile} · Part ${idx}/${total}]`)
            } else if (idx != null) {
              parts.push(`[${c.sourceFile} · Part ${idx}]`)
            } else {
              parts.push(`[${c.sourceFile}]`)
            }
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
