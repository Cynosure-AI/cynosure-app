import { getMemoryParser, type MemoryRetrievalStatusDetails, type RetrievedChunk } from './parser.js'
import { getRAGStore } from './rag.js'
import { getDb } from '../../db/database.js'
import { buildMemoryCategoryFilter, getMemoryCategoryDirectoryPath } from './memory-category-scope.js'
import { andLanceDbFilters, lanceDbEqFilter, lanceDbInFilter } from './lancedb-filter.js'
import {
    deleteMemoryKnowledgeSource,
    moveMemoryKnowledgeSource,
} from './memory-deep-research.js'
import {
    writeTextFile,
    readTextFile,
    computeFileHash,
    resolveUniqueFileName,
    PLAIN_TEXT_EXTENSIONS,
    archiveFile,
    toMarkdownFileName,
} from './memory-file-manager.js'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { isParseableDocument, parseDocument } from '../utils/document-parser.js'
import { cancelMemoryIndexJobsForFile } from './memory-index-jobs.js'
import { getActivePermanentMemoryTableName } from './memory-index-manifest.js'
import { randomBytes } from 'node:crypto'
import { createStableMemoryDocumentRef } from './memory-reference.js'
import { markMemoryDocumentDeleted, recordMemoryRevision, updateMemoryDocumentLocation, type MemoryRevisionContext } from './memory-revisions.js'

export interface ReindexFileResult {
    fileName: string
    chunkCount: number
}

export interface MemoryDocumentReference {
    documentId: string
    documentRef: string
    categoryId: string
    fileName: string
    revision: string
    chunkCount: number
}

function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return
    const err = new Error('Cancelled')
    err.name = 'AbortError'
    throw err
}

function upsertFileIndex(
    categoryId: string,
    fileName: string,
    contentHash: string,
    chunkCount: number,
): void {
    try {
        const db = getDb()
        const now = Date.now()
        const existing = db.prepare(`
            SELECT document_id, document_ref, content_hash FROM memory_file_index WHERE category_id = ? AND file_name = ?
        `).get(categoryId, fileName) as { document_id: string; document_ref: string; content_hash: string } | undefined
        const documentId = existing?.document_id || randomBytes(16).toString('hex')
        let collisionAttempt = 0
        let documentRef = existing?.document_ref || ''
        while (!documentRef) {
            const candidate = createStableMemoryDocumentRef(fileName, documentId, now, collisionAttempt++)
            if (!db.prepare('SELECT 1 FROM memory_file_index WHERE document_ref = ?').get(candidate)) documentRef = candidate
        }
        db.prepare(`
            INSERT INTO memory_file_index (document_id, document_ref, category_id, file_name, content_hash, chunk_count, last_indexed_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(category_id, file_name) DO UPDATE SET
                document_ref = CASE
                    WHEN memory_file_index.document_ref = '' THEN excluded.document_ref
                    ELSE memory_file_index.document_ref
                END,
                deep_researched_at = CASE
                    WHEN memory_file_index.content_hash = excluded.content_hash THEN memory_file_index.deep_researched_at
                    ELSE 0
                END,
                tags_json = CASE
                    WHEN memory_file_index.content_hash = excluded.content_hash THEN memory_file_index.tags_json
                    ELSE '[]'
                END,
                content_hash = excluded.content_hash,
                chunk_count = excluded.chunk_count,
                last_indexed_at = excluded.last_indexed_at
        `).run(documentId, documentRef, categoryId, fileName, contentHash, chunkCount, now, now)
        if (existing?.content_hash && existing.content_hash !== contentHash) {
            deleteMemoryKnowledgeSource(categoryId, fileName)
        }
    } catch {
        /* non-fatal */
    }
}

function removeFileIndex(categoryId: string, fileName: string): void {
    try {
        const db = getDb()
        db.prepare('DELETE FROM memory_file_index WHERE category_id = ? AND file_name = ?').run(categoryId, fileName)
    } catch { /* non-fatal */ }
}

interface FileIndexMoveCandidate {
    documentId: string
    documentRef: string
    categoryId: string
    fileName: string
    contentHash: string
    chunkCount: number
    lastIndexedAt: number
    deepResearchedAt: number
    dreamedAt: number
    tags: string[]
    createdAt: number
}

function parseDocumentTags(value: unknown): string[] {
    try {
        const parsed = JSON.parse(typeof value === 'string' ? value : '[]') as unknown
        return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
    } catch {
        return []
    }
}

/**
 * Persistent knowledge store backed by LanceDB.
 * All memory is scoped to memory categories (categoryId).
 * Files on disk are the source of truth; LanceDB is the retrieval index.
 */
export class AgentMemory {
    private parser = getMemoryParser()

    // -----------------------------------------------------------------------
    // Core: ingest text into LanceDB (low-level, no file I/O)
    // -----------------------------------------------------------------------

    private async ingestText(
        text: string,
        sourceFile: string,
        categoryId: string,
        signal?: AbortSignal,
        tableName = getActivePermanentMemoryTableName(),
    ): Promise<number> {
        return this.parser.ingest(tableName, text, {
            source: 'permanent',
            sourceFile,
            categoryId,
        }, { signal })
    }

    /**
     * Stage a complete replacement before removing the prior chunk IDs. This
     * guarantees failed embeddings leave the last searchable version intact.
     */
    private async replaceIndexedText(
        text: string,
        sourceFile: string,
        categoryId: string,
        replacedSourceFiles: string[],
        signal?: AbortSignal,
    ): Promise<number> {
        const ragStore = getRAGStore()
        const tableName = getActivePermanentMemoryTableName()
        const oldFilter = andLanceDbFilters(
            buildMemoryCategoryFilter([{ id: categoryId }]),
            lanceDbInFilter('sourceFile', Array.from(new Set(replacedSourceFiles.filter(Boolean)))),
        )
        const oldIds = oldFilter
            ? (await ragStore.listDocuments(tableName, oldFilter, { throwOnError: true })).map((doc) => doc.id)
            : []

        const count = await this.ingestText(text, sourceFile, categoryId, signal, tableName)
        const allCurrentIds = oldFilter
            ? (await ragStore.listDocuments(tableName, oldFilter, { throwOnError: true })).map((doc) => doc.id)
            : []
        const oldIdSet = new Set(oldIds)
        const stagedIds = allCurrentIds.filter((id) => !oldIdSet.has(id))
        try {
            throwIfAborted(signal)
            if (oldIds.length > 0) {
                await ragStore.deleteByIds(tableName, oldIds, { throwOnError: true })
            }
        } catch (err) {
            // The new rows stay staged until the old IDs are removed. Roll
            // them back on cancellation or swap failure.
            if (stagedIds.length > 0) {
                await ragStore.deleteByIds(tableName, stagedIds, { throwOnError: true }).catch((rollbackError) => {
                    console.error('[memory] Failed to roll back staged replacement chunks:', rollbackError)
                })
            }
            throw err
        }
        return count
    }

    /**
     * Re-index an existing file in a space folder (delete old vectors, re-ingest).
     * The file must already exist on disk at directoryPath/fileName.
     * Handles both plain text and parseable document formats.
     */
    async reindexFile(
        directoryPath: string,
        fileName: string,
        categoryId: string,
        opts?: { signal?: AbortSignal; revisionContext?: MemoryRevisionContext },
    ): Promise<ReindexFileResult> {
        throwIfAborted(opts?.signal)
        const filePath = join(directoryPath, fileName)

        let text: string
        const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()

        if (PLAIN_TEXT_EXTENSIONS.has(ext)) {
            text = readTextFile(directoryPath, fileName)
        } else if (isParseableDocument(fileName)) {
            const buf = readFileSync(filePath)
            throwIfAborted(opts?.signal)
            text = await parseDocument(buf, fileName)
            throwIfAborted(opts?.signal)
            const mdName = resolveUniqueFileName(directoryPath, toMarkdownFileName(fileName))
            const mdPath = writeTextFile(directoryPath, mdName, text)

            const count = await this.replaceIndexedText(text, mdName, categoryId, [fileName, mdName], opts?.signal)
            throwIfAborted(opts?.signal)
            archiveFile(directoryPath, fileName)
            removeFileIndex(categoryId, fileName)
            const hash = computeFileHash(mdPath)
            upsertFileIndex(categoryId, mdName, hash, count)
            const ref = this.getDocumentReference(categoryId, mdName)
            if (ref) recordMemoryRevision({ documentId: ref.documentId, documentRef: ref.documentRef, categoryId, fileName: mdName, content: text, context: opts?.revisionContext ?? { source: 'import' } })
            return { fileName: mdName, chunkCount: count }
        } else {
            throw new Error(`Unsupported file type: ${ext}`)
        }

        const count = await this.replaceIndexedText(text, fileName, categoryId, [fileName], opts?.signal)
        throwIfAborted(opts?.signal)
        const hash = computeFileHash(filePath)
        upsertFileIndex(categoryId, fileName, hash, count)
        const ref = this.getDocumentReference(categoryId, fileName)
        if (ref) recordMemoryRevision({ documentId: ref.documentId, documentRef: ref.documentRef, categoryId, fileName, content: text, context: opts?.revisionContext })
        return { fileName, chunkCount: count }
    }

    // -----------------------------------------------------------------------
    // Retrieval
    // -----------------------------------------------------------------------

    async recall(
        query: string,
        topK: number = 3,
        filter?: string,
        onStatus?: (stage: 'rag' | 'reranking', details?: MemoryRetrievalStatusDetails) => void,
    ): Promise<RetrievedChunk[]> {
        return this.parser.retrieve(getActivePermanentMemoryTableName(), query, topK, filter || undefined, onStatus)
    }

    getDocumentReference(categoryId: string, fileName: string): MemoryDocumentReference | undefined {
        try {
            const row = getDb().prepare(`
                SELECT document_id, document_ref, category_id, file_name, content_hash, chunk_count
                FROM memory_file_index
                WHERE category_id = ? AND file_name = ?
            `).get(categoryId, fileName) as {
                document_id: string
                document_ref: string
                category_id: string
                file_name: string
                content_hash: string
                chunk_count: number
            } | undefined
            return row ? {
                documentId: row.document_id,
                documentRef: row.document_ref,
                categoryId: row.category_id,
                fileName: row.file_name,
                revision: row.content_hash,
                chunkCount: row.chunk_count,
            } : undefined
        } catch {
            return undefined
        }
    }

    getDocumentReferenceById(documentId: string): MemoryDocumentReference | undefined {
        try {
            const row = getDb().prepare(`
                SELECT document_id, document_ref, category_id, file_name, content_hash, chunk_count
                FROM memory_file_index
                WHERE document_id = ?
            `).get(documentId) as {
                document_id: string
                document_ref: string
                category_id: string
                file_name: string
                content_hash: string
                chunk_count: number
            } | undefined
            return row ? {
                documentId: row.document_id,
                documentRef: row.document_ref,
                categoryId: row.category_id,
                fileName: row.file_name,
                revision: row.content_hash,
                chunkCount: row.chunk_count,
            } : undefined
        } catch {
            return undefined
        }
    }

    async getChunksByRange(
        sourceFile: string,
        minIndex: number,
        maxIndex: number,
        filter?: string,
    ): Promise<{ text: string; chunkIndex: number; sourceFile: string; categoryId?: string }[]> {
        return getRAGStore().getChunksByRange(getActivePermanentMemoryTableName(), sourceFile, minIndex, maxIndex, filter)
    }

    async countChunks(sourceFile: string, filter?: string): Promise<number> {
        return getRAGStore().countBySource(getActivePermanentMemoryTableName(), sourceFile, filter)
    }

    // -----------------------------------------------------------------------
    // Deletion
    // -----------------------------------------------------------------------

    /**
     * Delete all vectors for a source file and archive its physical source in
     * the space's hidden trash folder if it still exists.
     */
    async deleteSourceFile(sourceFile: string, categoryId: string): Promise<number> {
        const document = this.getDocumentReference(categoryId, sourceFile)
        const ragStore = getRAGStore()
        const spaceFilter = buildMemoryCategoryFilter([{ id: categoryId }])
        const deleted = await ragStore.deleteBySource(
            getActivePermanentMemoryTableName(),
            sourceFile,
            spaceFilter,
            { throwOnError: true },
        )

        const directoryPath = getMemoryCategoryDirectoryPath(categoryId)
        if (directoryPath) {
            archiveFile(directoryPath, sourceFile)
        }
        removeFileIndex(categoryId, sourceFile)
        if (document) markMemoryDocumentDeleted(document.documentId)
        return deleted
    }

    /**
     * Drop vector and tracking data for source files without touching the
     * physical files. The files will appear as not indexed and can be cleanly
     * re-indexed later.
     */
    async dropSourceIndexes(sourceFiles: string[], categoryId: string): Promise<number> {
        const uniqueSourceFiles = Array.from(new Set(sourceFiles.filter(Boolean)))
        if (uniqueSourceFiles.length === 0) return 0

        for (const sourceFile of uniqueSourceFiles) {
            cancelMemoryIndexJobsForFile(categoryId, sourceFile)
        }

        const deleted = await getRAGStore().deleteBySources(
            getActivePermanentMemoryTableName(),
            uniqueSourceFiles,
            buildMemoryCategoryFilter([{ id: categoryId }]),
        )

        const db = getDb()
        const removeIndexes = db.transaction(() => {
            const stmt = db.prepare('DELETE FROM memory_file_index WHERE category_id = ? AND file_name = ?')
            for (const sourceFile of uniqueSourceFiles) stmt.run(categoryId, sourceFile)
        })
        removeIndexes()

        return deleted
    }

    /** Delete vectors by source file without touching the physical file. */
    async deleteBySource(sourceFile: string, filter?: string): Promise<number> {
        return getRAGStore().deleteBySource(getActivePermanentMemoryTableName(), sourceFile, filter)
    }

    /**
     * Re-map an existing index entry to a new file path when the file content
     * hash proves it was moved or renamed. This keeps vectors and knowledge
     * edges intact, avoiding a full re-index after filesystem moves.
     */
    async remapMovedFileByHash(
        targetCategoryId: string,
        targetFileName: string,
        targetFolderPath: string,
    ): Promise<{ remapped: boolean; fromSpaceId?: string; fromFileName?: string }> {
        const existingTarget = this.getFileIndexEntry(targetCategoryId, targetFileName)
        if (existingTarget) return { remapped: false }

        const targetPath = join(targetFolderPath, targetFileName)
        const contentHash = computeFileHash(targetPath)
        if (!contentHash) return { remapped: false }

        const db = getDb()
        const candidates = db.prepare(`
            SELECT document_id, document_ref, category_id, file_name, content_hash, chunk_count, last_indexed_at, deep_researched_at, dreamed_at, tags_json, created_at
            FROM memory_file_index
            WHERE content_hash = ?
              AND NOT (category_id = ? AND file_name = ?)
            ORDER BY last_indexed_at DESC
        `).all(contentHash, targetCategoryId, targetFileName) as {
            document_id: string
            document_ref: string
            category_id: string
            file_name: string
            content_hash: string
            chunk_count: number
            last_indexed_at: number
            deep_researched_at: number
            dreamed_at: number
            tags_json: string
            created_at: number
        }[]

        const candidate = candidates
            .map((row): FileIndexMoveCandidate => ({
                documentId: row.document_id,
                documentRef: row.document_ref,
                categoryId: row.category_id,
                fileName: row.file_name,
                contentHash: row.content_hash,
                chunkCount: row.chunk_count,
                lastIndexedAt: row.last_indexed_at,
                deepResearchedAt: row.deep_researched_at || 0,
                dreamedAt: row.dreamed_at || 0,
                tags: parseDocumentTags(row.tags_json),
                createdAt: row.created_at,
            }))
            .find((row) => {
                const oldFolderPath = getMemoryCategoryDirectoryPath(row.categoryId)
                return !oldFolderPath || !existsSync(join(oldFolderPath, row.fileName))
            })

        if (!candidate) return { remapped: false }

        const ragStore = getRAGStore()
        const oldFilter = andLanceDbFilters(
            lanceDbEqFilter('categoryId', candidate.categoryId),
            lanceDbEqFilter('sourceFile', candidate.fileName),
        )
        if (oldFilter && candidate.fileName !== targetFileName) {
            await ragStore.updateSourceFile(getActivePermanentMemoryTableName(), oldFilter, targetFileName)
        }

        const newNameFilter = andLanceDbFilters(
            lanceDbEqFilter('categoryId', candidate.categoryId),
            lanceDbEqFilter('sourceFile', targetFileName),
        )
        if (newNameFilter && candidate.categoryId !== targetCategoryId) {
            await ragStore.updateCategoryId(getActivePermanentMemoryTableName(), newNameFilter, targetCategoryId)
        }

        const moveIndex = db.transaction(() => {
            db.prepare('DELETE FROM memory_file_index WHERE category_id = ? AND file_name = ?')
                .run(candidate.categoryId, candidate.fileName)
            db.prepare(`
                INSERT OR REPLACE INTO memory_file_index
                    (document_id, document_ref, category_id, file_name, content_hash, chunk_count, last_indexed_at, deep_researched_at, dreamed_at, tags_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                candidate.documentId,
                candidate.documentRef,
                targetCategoryId,
                targetFileName,
                candidate.contentHash,
                candidate.chunkCount,
                candidate.lastIndexedAt,
                candidate.deepResearchedAt,
                candidate.dreamedAt,
                JSON.stringify(candidate.tags),
                candidate.createdAt || Date.now(),
            )
        })
        moveIndex()

        updateMemoryDocumentLocation(candidate.documentId, targetCategoryId, targetFileName)

        moveMemoryKnowledgeSource(candidate.categoryId, candidate.fileName, targetCategoryId, targetFileName)
        cancelMemoryIndexJobsForFile(candidate.categoryId, candidate.fileName)
        return { remapped: true, fromSpaceId: candidate.categoryId, fromFileName: candidate.fileName }
    }

    // -----------------------------------------------------------------------
    // Listing helpers
    // -----------------------------------------------------------------------

    async listSourceFiles(
        categoryId?: string,
        overrideFilter?: string,
    ): Promise<{ sourceFile: string; categoryId?: string; chunkCount: number; createdAt: number }[]> {
        const ragStore = getRAGStore()
        let filter: string | undefined
        if (overrideFilter) {
            filter = overrideFilter
        } else if (categoryId) {
            filter = buildMemoryCategoryFilter([{ id: categoryId }])
        }
        const docs = await ragStore.listDocuments(getActivePermanentMemoryTableName(), filter)
        const indexedFiles = this.getIndexedFilePairs()

        const map = new Map<string, { sourceFile: string; categoryId?: string; count: number; latest: number }>()
        for (const doc of docs) {
            if (doc.categoryId && !indexedFiles.has(`${doc.categoryId}\0${doc.sourceFile || ''}`)) continue
            const sourceFile = doc.sourceFile || '(untitled)'
            const key = `${doc.categoryId || ''}\0${sourceFile}`
            const existing = map.get(key)
            if (existing) {
                existing.count++
                if (doc.createdAt > existing.latest) existing.latest = doc.createdAt
            } else {
                map.set(key, { sourceFile, categoryId: doc.categoryId, count: 1, latest: doc.createdAt })
            }
        }

        return Array.from(map.values())
            .map(({ sourceFile, categoryId, count, latest }) => ({ sourceFile, categoryId, chunkCount: count, createdAt: latest }))
            .sort((a, b) => b.createdAt - a.createdAt || a.sourceFile.localeCompare(b.sourceFile))
    }

    private getIndexedFilePairs(): Set<string> {
        try {
            const db = getDb()
            const rows = db
                .prepare('SELECT category_id, file_name FROM memory_file_index')
                .all() as { category_id: string; file_name: string }[]
            return new Set(rows.map((row) => `${row.category_id}\0${row.file_name}`))
        } catch {
            return new Set()
        }
    }

    /**
     * Resolve a unique source file name within a space.
     * Now checks the actual folder on disk instead of LanceDB.
     */
    async resolveUniqueSourceFile(sourceFile: string, categoryId?: string): Promise<string> {
        if (categoryId) {
            const directoryPath = getMemoryCategoryDirectoryPath(categoryId)
            if (directoryPath) {
                return resolveUniqueFileName(directoryPath, sourceFile)
            }
        }
        // Fallback to LanceDB check (legacy path)
        const existing = await this.listSourceFiles(categoryId)
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

    getFileIndex(categoryId: string): Map<string, { contentHash: string; chunkCount: number; lastIndexedAt: number; deepResearchedAt: number; dreamedAt: number; tags: string[] }> {
        try {
            const db = getDb()
            const rows = db
                .prepare('SELECT file_name, content_hash, chunk_count, last_indexed_at, deep_researched_at, dreamed_at, tags_json FROM memory_file_index WHERE category_id = ?')
                .all(categoryId) as { file_name: string; content_hash: string; chunk_count: number; last_indexed_at: number; deep_researched_at: number; dreamed_at: number; tags_json: string }[]
            const map = new Map<string, { contentHash: string; chunkCount: number; lastIndexedAt: number; deepResearchedAt: number; dreamedAt: number; tags: string[] }>()
            for (const row of rows) {
                map.set(row.file_name, { contentHash: row.content_hash, chunkCount: row.chunk_count, lastIndexedAt: row.last_indexed_at, deepResearchedAt: row.deep_researched_at || 0, dreamedAt: row.dreamed_at || 0, tags: parseDocumentTags(row.tags_json) })
            }
            return map
        } catch {
            return new Map()
        }
    }

    getFileIndexEntry(categoryId: string, fileName: string): { contentHash: string; chunkCount: number; lastIndexedAt: number; deepResearchedAt: number; tags: string[] } | undefined {
        try {
            const db = getDb()
            const row = db
                .prepare('SELECT content_hash, chunk_count, last_indexed_at, deep_researched_at, tags_json FROM memory_file_index WHERE category_id = ? AND file_name = ?')
                .get(categoryId, fileName) as { content_hash: string; chunk_count: number; last_indexed_at: number; deep_researched_at: number; tags_json: string } | undefined
            if (!row) return undefined
            return { contentHash: row.content_hash, chunkCount: row.chunk_count, lastIndexedAt: row.last_indexed_at, deepResearchedAt: row.deep_researched_at || 0, tags: parseDocumentTags(row.tags_json) }
        } catch {
            return undefined
        }
    }

    /**
     * Check whether a file's content hash matches the indexed hash.
     * Returns: 'current' | 'outdated' | 'not_indexed'
     */
    checkFileStatus(categoryId: string, fileName: string, directoryPath: string): 'current' | 'outdated' | 'not_indexed' {
        const entry = this.getFileIndexEntry(categoryId, fileName)
        if (!entry) return 'not_indexed'
        const currentHash = computeFileHash(join(directoryPath, fileName))
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
