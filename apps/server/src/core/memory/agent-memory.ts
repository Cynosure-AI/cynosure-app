import { getMemoryParser, type RetrievedChunk } from './parser.js'
import { getRAGStore } from './rag.js'
import { getDb } from '../../db/database.js'
import { buildMemorySpaceFilter, getMemorySpaceFolderPath } from './memory-space-scope.js'
import {
    ensureFolder,
    writeTextFile,
    readTextFile,
    deleteFile,
    computeFileHash,
    resolveUniqueFileName,
    PLAIN_TEXT_EXTENSIONS,
    moveToRevisions,
    toMarkdownFileName,
} from './memory-file-manager.js'
import { join } from 'path'
import { readFileSync } from 'fs'
import { isParseableDocument, parseDocument } from '../utils/document-parser.js'

const TABLE_NAME = 'permanent_memory'

export interface ReindexFileResult {
    fileName: string
    chunkCount: number
}

function upsertFileIndex(
    spaceId: string,
    fileName: string,
    contentHash: string,
    chunkCount: number,
): void {
    try {
        const db = getDb()
        const now = Date.now()
        db.prepare(`
            INSERT INTO memory_file_index (space_id, file_name, content_hash, chunk_count, last_indexed_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(space_id, file_name) DO UPDATE SET
                content_hash = excluded.content_hash,
                chunk_count = excluded.chunk_count,
                last_indexed_at = excluded.last_indexed_at
        `).run(spaceId, fileName, contentHash, chunkCount, now, now)
    } catch {
        /* non-fatal */
    }
}

function removeFileIndex(spaceId: string, fileName: string): void {
    try {
        const db = getDb()
        db.prepare('DELETE FROM memory_file_index WHERE space_id = ? AND file_name = ?').run(spaceId, fileName)
    } catch { /* non-fatal */ }
}

/**
 * Persistent knowledge store backed by LanceDB.
 * All memory is scoped to memory spaces (spaceId).
 * Files on disk are the source of truth; LanceDB is the retrieval index.
 */
export class AgentMemory {
    private parser = getMemoryParser()

    // -----------------------------------------------------------------------
    // Core: ingest text into LanceDB (low-level, no file I/O)
    // -----------------------------------------------------------------------

    private async ingestText(text: string, sourceFile: string, spaceId: string): Promise<number> {
        return this.parser.ingest(TABLE_NAME, text, {
            source: 'permanent',
            sourceFile,
            spaceId,
        })
    }

    // -----------------------------------------------------------------------
    // File-backed operations (write file + index)
    // -----------------------------------------------------------------------

    /**
     * Write a markdown file to the space folder and index it.
     * If folderPath is not provided, only indexes without writing.
     */
    async storeAsFile(
        content: string,
        fileName: string,
        spaceId: string,
    ): Promise<{ fileName: string; chunkCount: number }> {
        const folderPath = getMemorySpaceFolderPath(spaceId)
        if (!folderPath) {
            // Fallback: index without writing to disk
            const count = await this.ingestText(content, fileName, spaceId)
            return { fileName, chunkCount: count }
        }

        ensureFolder(folderPath)
        const uniqueName = resolveUniqueFileName(folderPath, fileName)
        const filePath = writeTextFile(folderPath, uniqueName, content)
        const hash = computeFileHash(filePath)
        const count = await this.ingestText(content, uniqueName, spaceId)
        upsertFileIndex(spaceId, uniqueName, hash, count)
        return { fileName: uniqueName, chunkCount: count }
    }

    /**
     * Re-index an existing file in a space folder (delete old vectors, re-ingest).
     * The file must already exist on disk at folderPath/fileName.
     * Handles both plain text and parseable document formats.
     */
    async reindexFile(
        folderPath: string,
        fileName: string,
        spaceId: string,
    ): Promise<ReindexFileResult> {
        const filePath = join(folderPath, fileName)
        const ragStore = getRAGStore()

        let text: string
        const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()

        if (PLAIN_TEXT_EXTENSIONS.has(ext)) {
            text = readTextFile(folderPath, fileName)
        } else if (isParseableDocument(fileName)) {
            const buf = readFileSync(filePath)
            text = this.withImportMetadata(await parseDocument(buf, fileName), fileName)
            const mdName = resolveUniqueFileName(folderPath, toMarkdownFileName(fileName))
            const mdPath = writeTextFile(folderPath, mdName, text)

            moveToRevisions(folderPath, fileName)

            await ragStore.deleteBySources(TABLE_NAME, [fileName, mdName], buildMemorySpaceFilter([{ id: spaceId }]))
            removeFileIndex(spaceId, fileName)

            const count = await this.ingestText(text, mdName, spaceId)
            const hash = computeFileHash(mdPath)
            upsertFileIndex(spaceId, mdName, hash, count)
            return { fileName: mdName, chunkCount: count }
        } else {
            throw new Error(`Unsupported file type: ${ext}`)
        }

        // Remove old vectors for this file in this space
        await ragStore.deleteBySource(TABLE_NAME, fileName, buildMemorySpaceFilter([{ id: spaceId }]))

        const count = await this.ingestText(text, fileName, spaceId)
        const hash = computeFileHash(filePath)
        upsertFileIndex(spaceId, fileName, hash, count)
        return { fileName, chunkCount: count }
    }

    /**
     * Copy an external file into the space folder, then index it.
     * The content is provided as a string (already parsed/extracted).
     */
    async ingestExternalFile(
        parsedContent: string,
        fileName: string,
        spaceId: string,
        folderPath: string,
    ): Promise<{ fileName: string; chunkCount: number }> {
        ensureFolder(folderPath)
        // Always save as .md regardless of the original extension
        const mdName = toMarkdownFileName(fileName)
        const uniqueName = resolveUniqueFileName(folderPath, mdName)
        const filePath = writeTextFile(folderPath, uniqueName, parsedContent)
        const hash = computeFileHash(filePath)

        const ragStore = getRAGStore()
        await ragStore.deleteBySource(TABLE_NAME, uniqueName, buildMemorySpaceFilter([{ id: spaceId }]))
        const count = await this.ingestText(parsedContent, uniqueName, spaceId)
        upsertFileIndex(spaceId, uniqueName, hash, count)
        return { fileName: uniqueName, chunkCount: count }
    }

    private withImportMetadata(content: string, originalFileName: string): string {
        return [
            '---',
            `importedFrom: ${JSON.stringify(originalFileName)}`,
            `importedAt: ${JSON.stringify(new Date().toISOString())}`,
            '---',
            '',
            content.trim(),
            '',
        ].join('\n')
    }

    // -----------------------------------------------------------------------
    // Legacy: store text (for backwards-compat paths that don't pass folderPath)
    // -----------------------------------------------------------------------

    /** @deprecated Prefer storeAsFile which also writes to disk. */
    async store(text: string, sourceFile?: string, spaceId?: string): Promise<number> {
        return this.ingestText(text, sourceFile ?? '', spaceId ?? '')
    }

    // -----------------------------------------------------------------------
    // Retrieval
    // -----------------------------------------------------------------------

    async recall(query: string, topK: number = 3, filter?: string): Promise<RetrievedChunk[]> {
        return this.parser.retrieve(TABLE_NAME, query, topK, filter || undefined)
    }

    async getChunksByRange(
        sourceFile: string,
        minIndex: number,
        maxIndex: number,
        filter?: string,
    ): Promise<{ text: string; chunkIndex: number; sourceFile: string; spaceId?: string }[]> {
        return getRAGStore().getChunksByRange(TABLE_NAME, sourceFile, minIndex, maxIndex, filter)
    }

    async countChunks(sourceFile: string, filter?: string): Promise<number> {
        return getRAGStore().countBySource(TABLE_NAME, sourceFile, filter)
    }

    // -----------------------------------------------------------------------
    // Deletion
    // -----------------------------------------------------------------------

    /**
     * Delete all vectors for a source file, and also delete the physical file
     * from the space folder if it exists there.
     */
    async deleteSourceFile(sourceFile: string, spaceId: string): Promise<number> {
        const ragStore = getRAGStore()
        const spaceFilter = buildMemorySpaceFilter([{ id: spaceId }])
        const deleted = await ragStore.deleteBySource(TABLE_NAME, sourceFile, spaceFilter)

        const folderPath = getMemorySpaceFolderPath(spaceId)
        if (folderPath) {
            deleteFile(folderPath, sourceFile)
        }
        removeFileIndex(spaceId, sourceFile)
        return deleted
    }

    /** Delete vectors by source file without touching the physical file. */
    async deleteBySource(sourceFile: string, filter?: string): Promise<number> {
        return getRAGStore().deleteBySource(TABLE_NAME, sourceFile, filter)
    }

    // -----------------------------------------------------------------------
    // Listing helpers
    // -----------------------------------------------------------------------

    async listSourceFiles(
        spaceId?: string,
        overrideFilter?: string,
    ): Promise<{ sourceFile: string; chunkCount: number; createdAt: number }[]> {
        const ragStore = getRAGStore()
        let filter: string | undefined
        if (overrideFilter) {
            filter = overrideFilter
        } else if (spaceId) {
            filter = buildMemorySpaceFilter([{ id: spaceId }])
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
     * Resolve a unique source file name within a space.
     * Now checks the actual folder on disk instead of LanceDB.
     */
    async resolveUniqueSourceFile(sourceFile: string, spaceId?: string): Promise<string> {
        if (spaceId) {
            const folderPath = getMemorySpaceFolderPath(spaceId)
            if (folderPath) {
                return resolveUniqueFileName(folderPath, sourceFile)
            }
        }
        // Fallback to LanceDB check (legacy path)
        const existing = await this.listSourceFiles(spaceId)
        const existingNames = new Set(existing.map(e => e.sourceFile))
        if (!existingNames.has(sourceFile)) return sourceFile
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

    // -----------------------------------------------------------------------
    // File index read helpers
    // -----------------------------------------------------------------------

    getFileIndex(spaceId: string): Map<string, { contentHash: string; chunkCount: number; lastIndexedAt: number }> {
        try {
            const db = getDb()
            const rows = db
                .prepare('SELECT file_name, content_hash, chunk_count, last_indexed_at FROM memory_file_index WHERE space_id = ?')
                .all(spaceId) as { file_name: string; content_hash: string; chunk_count: number; last_indexed_at: number }[]
            const map = new Map<string, { contentHash: string; chunkCount: number; lastIndexedAt: number }>()
            for (const row of rows) {
                map.set(row.file_name, { contentHash: row.content_hash, chunkCount: row.chunk_count, lastIndexedAt: row.last_indexed_at })
            }
            return map
        } catch {
            return new Map()
        }
    }

    getFileIndexEntry(spaceId: string, fileName: string): { contentHash: string; chunkCount: number; lastIndexedAt: number } | undefined {
        try {
            const db = getDb()
            const row = db
                .prepare('SELECT content_hash, chunk_count, last_indexed_at FROM memory_file_index WHERE space_id = ? AND file_name = ?')
                .get(spaceId, fileName) as { content_hash: string; chunk_count: number; last_indexed_at: number } | undefined
            if (!row) return undefined
            return { contentHash: row.content_hash, chunkCount: row.chunk_count, lastIndexedAt: row.last_indexed_at }
        } catch {
            return undefined
        }
    }

    /**
     * Check whether a file's content hash matches the indexed hash.
     * Returns: 'current' | 'outdated' | 'not_indexed'
     */
    checkFileStatus(spaceId: string, fileName: string, folderPath: string): 'current' | 'outdated' | 'not_indexed' {
        const entry = this.getFileIndexEntry(spaceId, fileName)
        if (!entry) return 'not_indexed'
        const currentHash = computeFileHash(join(folderPath, fileName))
        return currentHash === entry.contentHash ? 'current' : 'outdated'
    }
}

let agentMemoryInstance: AgentMemory | null = null

export function getAgentMemory(): AgentMemory {
    if (!agentMemoryInstance) {
        agentMemoryInstance = new AgentMemory()
    }
    return agentMemoryInstance
}
