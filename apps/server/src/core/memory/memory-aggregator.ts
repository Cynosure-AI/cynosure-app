import { getAgentMemory } from './agent-memory.js'
import { getDb } from '../../db/database.js'
import { buildMemoryFolderFilter, getAllMemoryFolders, getAssignedMemoryFolders } from './memory-folder-scope.js'
import type { MemoryRetrievalStatusDetails, RetrievedChunk } from './parser.js'

export interface AggregatedMemory {
  permanent: RetrievedChunk[]
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
      folderIds?: string[]
      permanentTopK?: number
      /** Optional live progress for automatic pre-turn memory retrieval. */
      onStatus?: (stage: 'rag' | 'reranking', details?: MemoryRetrievalStatusDetails) => void
    }
  ): Promise<AggregatedMemory> {
    const permanentMem = getAgentMemory()

    let spaceFilter: string | undefined
    const folderNameMap = new Map<string, string>()

    let scopedSpaces: { id: string; name: string }[] = []

    if (Array.isArray(opts?.folderIds)) {
      try {
        const db = getDb()
        const uniqueSpaceIds = [...new Set(opts.folderIds.map((s) => s.trim()).filter(Boolean))]
        if (uniqueSpaceIds.length > 0) {
          const placeholders = uniqueSpaceIds.map(() => '?').join(', ')
          scopedSpaces = db.prepare(`SELECT id, name FROM memory_folders WHERE id IN (${placeholders})`).all(...uniqueSpaceIds) as { id: string; name: string }[]
          // Explicit scopes are security boundaries. A stale or invalid ID
          // must never broaden or partially alter the requested scope.
          if (!hasExactMemoryFolderScope(uniqueSpaceIds, scopedSpaces)) {
            return { permanent: [] }
          }
        }
      } catch { /* DB not ready */ }
    } else if (opts?.agentId) {
      scopedSpaces = getAssignedMemoryFolders(opts.agentId)
      if (scopedSpaces.length === 0) {
        return { permanent: [] }
      }
    } else {
      scopedSpaces = getAllMemoryFolders()
    }

    if (Array.isArray(opts?.folderIds) && scopedSpaces.length === 0) {
      return { permanent: [] }
    }

    if (scopedSpaces.length > 0) {
      for (const row of scopedSpaces) folderNameMap.set(row.id, row.name)
      spaceFilter = buildMemoryFolderFilter(scopedSpaces)
    }

    const permanent = await permanentMem.recall(query, opts?.permanentTopK ?? 3, spaceFilter, opts?.onStatus).catch(() => [])

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
        .map(c => `${c.sourceFile!}\u0000${c.folderId || ''}`)
    )]
    if (uniqueSourceKeys.length > 0) {
      const counts = await Promise.all(
        uniqueSourceKeys.map(key => {
          const [sf, folderId] = key.split('\u0000')
          const filter = folderId ? buildMemoryFolderFilter([{ id: folderId }]) : spaceFilter
          return permanentMem.countChunks(sf, filter)
        })
      )
      const countMap = new Map(uniqueSourceKeys.map((key, i) => [key, counts[i]]))
      for (const chunk of dedupedPermanent) {
        const key = chunk.sourceFile ? `${chunk.sourceFile}\u0000${chunk.folderId || ''}` : undefined
        if (key && countMap.has(key)) {
          chunk.totalChunks = countMap.get(key)
        }
      }
    }

    if (folderNameMap.size === 0) {
      try {
        const db = getDb()
        const rows = db.prepare('SELECT id, name FROM memory_folders').all() as { id: string; name: string }[]
        for (const row of rows) folderNameMap.set(row.id, row.name)
      } catch { /* DB not ready */ }
    }

    for (const chunk of dedupedPermanent) {
      if (chunk.folderId) {
        chunk.folderName = folderNameMap.get(chunk.folderId)
        if (chunk.sourceFile) {
          const ref = permanentMem.getDocumentReference(chunk.folderId, chunk.sourceFile)
          chunk.documentId = ref?.documentId
          chunk.documentRef = ref?.documentRef
          chunk.revision = ref?.revision
          chunk.documentUpdatedAt = ref?.updatedAt
        }
      }
    }

    return { permanent: dedupedPermanent }
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
            const label = c.folderName ? `${c.folderName} · ${c.sourceFile}` : c.sourceFile
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
            if (c.documentRef) {
              parts.push(`[documentRef=${c.documentRef}]`)
            }
          } else if (c.folderName) {
            parts.push(`[${c.folderName}]`)
          }
          parts.push(c.text)
          return `- ${parts.join(' ')}`
        }).join('\n')
      )
    }

    return sections.join('\n\n')
  }
}

export function hasExactMemoryFolderScope(
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
