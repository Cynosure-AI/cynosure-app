import { getMemoryParser, type RetrievedChunk } from './parser.js'
import { getRAGStore } from './rag.js'

const TABLE_NAME = 'permanent_memory'

/**
 * Persistent knowledge store backed by LanceDB.
 * All memory is scoped to memory spaces (spaceId).
 */
export class AgentMemory {
    private parser = getMemoryParser()

    /**
     * Store a piece of information.
     */
    async store(text: string, sourceFile?: string, spaceId?: string): Promise<number> {
        return this.parser.ingest(TABLE_NAME, text, {
            source: 'permanent',
            sourceFile,
            spaceId
        })
    }

    /**
     * Retrieve relevant memories for a given query, optionally filtered.
     */
    async recall(query: string, topK: number = 3, filter?: string): Promise<RetrievedChunk[]> {
        return this.parser.retrieve(TABLE_NAME, query, topK, filter || undefined)
    }

    /**
     * Retrieve chunks from a source file by index range.
     */
    async getChunksByRange(
        sourceFile: string,
        minIndex: number,
        maxIndex: number,
        filter?: string
    ): Promise<{ text: string; chunkIndex: number; sourceFile: string; spaceId?: string }[]> {
        const ragStore = getRAGStore()
        return ragStore.getChunksByRange(TABLE_NAME, sourceFile, minIndex, maxIndex, filter)
    }

    /**
     * Count total chunks for a given source file.
     */
    async countChunks(sourceFile: string, filter?: string): Promise<number> {
        const ragStore = getRAGStore()
        return ragStore.countBySource(TABLE_NAME, sourceFile, filter)
    }

    /**
     * Delete all chunks for a given source file.
     */
    async deleteBySource(sourceFile: string, filter?: string): Promise<number> {
        const ragStore = getRAGStore()
        return ragStore.deleteBySource(TABLE_NAME, sourceFile, filter)
    }

    /**
     * List all distinct source files (documents) stored,
     * with chunk count per document.
     */
    async listSourceFiles(spaceId?: string, overrideFilter?: string): Promise<{ sourceFile: string; chunkCount: number; createdAt: number }[]> {
        const ragStore = getRAGStore()
        let filter: string | undefined
        if (overrideFilter) {
            filter = overrideFilter
        } else if (spaceId) {
            filter = `spaceId = '${spaceId.replace(/'/g, "''")}'`
        }
        const docs = await ragStore.listDocuments(TABLE_NAME, filter)

        const map = new Map<string, { count: number; earliest: number }>()
        for (const doc of docs) {
            const sf = doc.sourceFile || '(untitled)'
            const existing = map.get(sf)
            if (existing) {
                existing.count++
                if (doc.createdAt < existing.earliest) existing.earliest = doc.createdAt
            } else {
                map.set(sf, { count: 1, earliest: doc.createdAt })
            }
        }

        return Array.from(map.entries())
            .map(([sourceFile, { count, earliest }]) => ({ sourceFile, chunkCount: count, createdAt: earliest }))
            .sort((a, b) => a.sourceFile.localeCompare(b.sourceFile))
    }

    /**
     * Generate a unique sourceFile name by appending a numeric suffix if the name already exists.
     * e.g. "report.pdf" → "report (2).pdf" → "report (3).pdf"
     */
    async resolveUniqueSourceFile(sourceFile: string, spaceId?: string): Promise<string> {
        const existing = await this.listSourceFiles(spaceId)
        const existingNames = new Set(existing.map(e => e.sourceFile))

        if (!existingNames.has(sourceFile)) return sourceFile

        // Split into base name and extension
        const dotIdx = sourceFile.lastIndexOf('.')
        const base = dotIdx > 0 ? sourceFile.slice(0, dotIdx) : sourceFile
        const ext = dotIdx > 0 ? sourceFile.slice(dotIdx) : ''

        let counter = 2
        let candidate = `${base} (${counter})${ext}`
        while (existingNames.has(candidate)) {
            counter++
            candidate = `${base} (${counter})${ext}`
        }
        return candidate
    }
}

let agentMemoryInstance: AgentMemory | null = null

export function getAgentMemory(): AgentMemory {
    if (!agentMemoryInstance) {
        agentMemoryInstance = new AgentMemory()
    }
    return agentMemoryInstance
}
