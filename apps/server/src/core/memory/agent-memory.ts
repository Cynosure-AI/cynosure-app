import { getMemoryParser, type RetrievedChunk } from './parser.js'
import { getRAGStore } from './rag.js'
import { getDb } from '../../db/database.js'
import { buildMemorySpaceFilter, getMemorySpaceFolderPath } from './memory-space-scope.js'
import { andLanceDbFilters, lanceDbEqFilter, lanceDbInFilter } from './lancedb-filter.js'
import {
    deleteMemoryGraphSource,
    indexMemoryContentIntoEntityGraph,
    moveMemoryGraphSource,
} from './memory-entity-indexer.js'
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
import { cancelMemoryIndexJobsForFile, startMemoryIndexJob } from './memory-index-jobs.js'
import { getActivePermanentMemoryTableName } from './memory-index-manifest.js'
import { randomBytes } from 'node:crypto'
import { createStableMemoryDocumentRef } from './memory-reference.js'

export interface ReindexFileResult {
    fileName: string
    chunkCount: number
}

export interface MemoryDocumentReference {
    documentId: string
    documentRef: string
    spaceId: string
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
    spaceId: string,
    fileName: string,
    contentHash: string,
    chunkCount: number,
): void {
    try {
        const db = getDb()
        const now = Date.now()
        const existing = db.prepare(`
            SELECT document_id, document_ref FROM memory_file_index WHERE space_id = ? AND file_name = ?
        `).get(spaceId, fileName) as { document_id: string; document_ref: string } | undefined
        const documentId = existing?.document_id || randomBytes(16).toString('hex')
        let collisionAttempt = 0
        let documentRef = existing?.document_ref || ''
        while (!documentRef) {
            const candidate = createStableMemoryDocumentRef(fileName, documentId, now, collisionAttempt++)
            if (!db.prepare('SELECT 1 FROM memory_file_index WHERE document_ref = ?').get(candidate)) documentRef = candidate
        }
        db.prepare(`
            INSERT INTO memory_file_index (document_id, document_ref, space_id, file_name, content_hash, chunk_count, last_indexed_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(space_id, file_name) DO UPDATE SET
                document_ref = CASE
                    WHEN memory_file_index.document_ref = '' THEN excluded.document_ref
                    ELSE memory_file_index.document_ref
                END,
                entity_indexed_at = CASE
                    WHEN memory_file_index.content_hash = excluded.content_hash THEN memory_file_index.entity_indexed_at
                    ELSE 0
                END,
                content_hash = excluded.content_hash,
                chunk_count = excluded.chunk_count,
                last_indexed_at = excluded.last_indexed_at
        `).run(documentId, documentRef, spaceId, fileName, contentHash, chunkCount, now, now)
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

interface FileIndexMoveCandidate {
    documentId: string
    documentRef: string
    spaceId: string
    fileName: string
    contentHash: string
    chunkCount: number
    lastIndexedAt: number
    entityIndexedAt: number
    createdAt: number
}

/**
 * Persistent knowledge store backed by LanceDB.
 * All memory is scoped to memory spaces (spaceId).
 * Files on disk are the source of truth; LanceDB is the retrieval index.
 */
export class AgentMemory {
    private parser = getMemoryParser()

    /**
     * The graph is a rebuildable derivative of the indexed document. Remove
     * stale claims first, then repopulate best-effort. A provider failure must
     * never make the source document unavailable to RAG.
     */
    private scheduleDerivedGraphRefresh(
        content: string,
        fileName: string,
        spaceId: string,
        replacedSourceFiles: string[] = [fileName],
    ): void {
        try {
            for (const priorFileName of Array.from(new Set(replacedSourceFiles.filter(Boolean)))) {
                deleteMemoryGraphSource(spaceId, priorFileName)
            }
            getDb().prepare(`
                UPDATE memory_file_index SET entity_indexed_at = 0
                WHERE space_id = ? AND file_name = ?
            `).run(spaceId, fileName)
            startMemoryIndexJob({
                kind: 'entity-index',
                spaceId,
                fileName,
                replaceExisting: true,
                run: (jobSignal) => indexMemoryContentIntoEntityGraph({
                    content,
                    spaceId,
                    fileName,
                    replaceExisting: true,
                    signal: jobSignal,
                }),
            })
        } catch (err) {
            console.warn(`[memory] Document indexed, but graph derivation could not be scheduled for ${spaceId}/${fileName}:`, err)
        }
    }

    // -----------------------------------------------------------------------
    // Core: ingest text into LanceDB (low-level, no file I/O)
    // -----------------------------------------------------------------------

    private async ingestText(
        text: string,
        sourceFile: string,
        spaceId: string,
        signal?: AbortSignal,
        tableName = getActivePermanentMemoryTableName(),
    ): Promise<number> {
        return this.parser.ingest(tableName, text, {
            source: 'permanent',
            sourceFile,
            spaceId,
        }, { signal })
    }

    /**
     * Stage a complete replacement before removing the prior chunk IDs. This
     * guarantees failed embeddings leave the last searchable version intact.
     */
    private async replaceIndexedText(
        text: string,
        sourceFile: string,
        spaceId: string,
        replacedSourceFiles: string[],
        signal?: AbortSignal,
    ): Promise<number> {
        const ragStore = getRAGStore()
        const tableName = getActivePermanentMemoryTableName()
        const oldFilter = andLanceDbFilters(
            buildMemorySpaceFilter([{ id: spaceId }]),
            lanceDbInFilter('sourceFile', Array.from(new Set(replacedSourceFiles.filter(Boolean)))),
        )
        const oldIds = oldFilter
            ? (await ragStore.listDocuments(tableName, oldFilter, { throwOnError: true })).map((doc) => doc.id)
            : []

        const count = await this.ingestText(text, sourceFile, spaceId, signal, tableName)
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
     * The file must already exist on disk at folderPath/fileName.
     * Handles both plain text and parseable document formats.
     */
    async reindexFile(
        folderPath: string,
        fileName: string,
        spaceId: string,
        opts?: { signal?: AbortSignal },
    ): Promise<ReindexFileResult> {
        throwIfAborted(opts?.signal)
        const filePath = join(folderPath, fileName)

        let text: string
        const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()

        if (PLAIN_TEXT_EXTENSIONS.has(ext)) {
            text = readTextFile(folderPath, fileName)
        } else if (isParseableDocument(fileName)) {
            const buf = readFileSync(filePath)
            throwIfAborted(opts?.signal)
            text = await parseDocument(buf, fileName)
            throwIfAborted(opts?.signal)
            const mdName = resolveUniqueFileName(folderPath, toMarkdownFileName(fileName))
            const mdPath = writeTextFile(folderPath, mdName, text)

            const count = await this.replaceIndexedText(text, mdName, spaceId, [fileName, mdName], opts?.signal)
            throwIfAborted(opts?.signal)
            archiveFile(folderPath, fileName)
            removeFileIndex(spaceId, fileName)
            const hash = computeFileHash(mdPath)
            upsertFileIndex(spaceId, mdName, hash, count)
            this.scheduleDerivedGraphRefresh(text, mdName, spaceId, [fileName, mdName])
            return { fileName: mdName, chunkCount: count }
        } else {
            throw new Error(`Unsupported file type: ${ext}`)
        }

        const count = await this.replaceIndexedText(text, fileName, spaceId, [fileName], opts?.signal)
        throwIfAborted(opts?.signal)
        const hash = computeFileHash(filePath)
        upsertFileIndex(spaceId, fileName, hash, count)
        this.scheduleDerivedGraphRefresh(text, fileName, spaceId)
        return { fileName, chunkCount: count }
    }

    // -----------------------------------------------------------------------
    // Retrieval
    // -----------------------------------------------------------------------

    async recall(query: string, topK: number = 3, filter?: string): Promise<RetrievedChunk[]> {
        return this.parser.retrieve(getActivePermanentMemoryTableName(), query, topK, filter || undefined)
    }

    getDocumentReference(spaceId: string, fileName: string): MemoryDocumentReference | undefined {
        try {
            const row = getDb().prepare(`
                SELECT document_id, document_ref, space_id, file_name, content_hash, chunk_count
                FROM memory_file_index
                WHERE space_id = ? AND file_name = ?
            `).get(spaceId, fileName) as {
                document_id: string
                document_ref: string
                space_id: string
                file_name: string
                content_hash: string
                chunk_count: number
            } | undefined
            return row ? {
                documentId: row.document_id,
                documentRef: row.document_ref,
                spaceId: row.space_id,
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
                SELECT document_id, document_ref, space_id, file_name, content_hash, chunk_count
                FROM memory_file_index
                WHERE document_id = ?
            `).get(documentId) as {
                document_id: string
                document_ref: string
                space_id: string
                file_name: string
                content_hash: string
                chunk_count: number
            } | undefined
            return row ? {
                documentId: row.document_id,
                documentRef: row.document_ref,
                spaceId: row.space_id,
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
    ): Promise<{ text: string; chunkIndex: number; sourceFile: string; spaceId?: string }[]> {
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
    async deleteSourceFile(sourceFile: string, spaceId: string): Promise<number> {
        const ragStore = getRAGStore()
        const spaceFilter = buildMemorySpaceFilter([{ id: spaceId }])
        const deleted = await ragStore.deleteBySource(
            getActivePermanentMemoryTableName(),
            sourceFile,
            spaceFilter,
            { throwOnError: true },
        )

        const folderPath = getMemorySpaceFolderPath(spaceId)
        if (folderPath) {
            archiveFile(folderPath, sourceFile)
        }
        removeFileIndex(spaceId, sourceFile)
        return deleted
    }

    /**
     * Drop vector and tracking data for source files without touching the
     * physical files. The files will appear as not indexed and can be cleanly
     * re-indexed later.
     */
    async dropSourceIndexes(sourceFiles: string[], spaceId: string): Promise<number> {
        const uniqueSourceFiles = Array.from(new Set(sourceFiles.filter(Boolean)))
        if (uniqueSourceFiles.length === 0) return 0

        for (const sourceFile of uniqueSourceFiles) {
            cancelMemoryIndexJobsForFile(spaceId, sourceFile)
        }

        const deleted = await getRAGStore().deleteBySources(
            getActivePermanentMemoryTableName(),
            uniqueSourceFiles,
            buildMemorySpaceFilter([{ id: spaceId }]),
        )

        const db = getDb()
        const removeIndexes = db.transaction(() => {
            const stmt = db.prepare('DELETE FROM memory_file_index WHERE space_id = ? AND file_name = ?')
            for (const sourceFile of uniqueSourceFiles) stmt.run(spaceId, sourceFile)
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
     * hash proves it was moved or renamed. This keeps vectors and entity graph
     * edges intact, avoiding a full re-index after filesystem moves.
     */
    async remapMovedFileByHash(
        targetSpaceId: string,
        targetFileName: string,
        targetFolderPath: string,
    ): Promise<{ remapped: boolean; fromSpaceId?: string; fromFileName?: string }> {
        const existingTarget = this.getFileIndexEntry(targetSpaceId, targetFileName)
        if (existingTarget) return { remapped: false }

        const targetPath = join(targetFolderPath, targetFileName)
        const contentHash = computeFileHash(targetPath)
        if (!contentHash) return { remapped: false }

        const db = getDb()
        const candidates = db.prepare(`
            SELECT document_id, document_ref, space_id, file_name, content_hash, chunk_count, last_indexed_at, entity_indexed_at, created_at
            FROM memory_file_index
            WHERE content_hash = ?
              AND NOT (space_id = ? AND file_name = ?)
            ORDER BY last_indexed_at DESC
        `).all(contentHash, targetSpaceId, targetFileName) as {
            document_id: string
            document_ref: string
            space_id: string
            file_name: string
            content_hash: string
            chunk_count: number
            last_indexed_at: number
            entity_indexed_at: number
            created_at: number
        }[]

        const candidate = candidates
            .map((row): FileIndexMoveCandidate => ({
                documentId: row.document_id,
                documentRef: row.document_ref,
                spaceId: row.space_id,
                fileName: row.file_name,
                contentHash: row.content_hash,
                chunkCount: row.chunk_count,
                lastIndexedAt: row.last_indexed_at,
                entityIndexedAt: row.entity_indexed_at || 0,
                createdAt: row.created_at,
            }))
            .find((row) => {
                const oldFolderPath = getMemorySpaceFolderPath(row.spaceId)
                return !oldFolderPath || !existsSync(join(oldFolderPath, row.fileName))
            })

        if (!candidate) return { remapped: false }

        const ragStore = getRAGStore()
        const oldFilter = andLanceDbFilters(
            lanceDbEqFilter('spaceId', candidate.spaceId),
            lanceDbEqFilter('sourceFile', candidate.fileName),
        )
        if (oldFilter && candidate.fileName !== targetFileName) {
            await ragStore.updateSourceFile(getActivePermanentMemoryTableName(), oldFilter, targetFileName)
        }

        const newNameFilter = andLanceDbFilters(
            lanceDbEqFilter('spaceId', candidate.spaceId),
            lanceDbEqFilter('sourceFile', targetFileName),
        )
        if (newNameFilter && candidate.spaceId !== targetSpaceId) {
            await ragStore.updateSpaceId(getActivePermanentMemoryTableName(), newNameFilter, targetSpaceId)
        }

        const moveIndex = db.transaction(() => {
            db.prepare('DELETE FROM memory_file_index WHERE space_id = ? AND file_name = ?')
                .run(candidate.spaceId, candidate.fileName)
            db.prepare(`
                INSERT OR REPLACE INTO memory_file_index
                    (document_id, document_ref, space_id, file_name, content_hash, chunk_count, last_indexed_at, entity_indexed_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                candidate.documentId,
                candidate.documentRef,
                targetSpaceId,
                targetFileName,
                candidate.contentHash,
                candidate.chunkCount,
                candidate.lastIndexedAt,
                candidate.entityIndexedAt,
                candidate.createdAt || Date.now(),
            )
        })
        moveIndex()

        moveMemoryGraphSource(candidate.spaceId, candidate.fileName, targetSpaceId, targetFileName)
        cancelMemoryIndexJobsForFile(candidate.spaceId, candidate.fileName)
        return { remapped: true, fromSpaceId: candidate.spaceId, fromFileName: candidate.fileName }
    }

    // -----------------------------------------------------------------------
    // Listing helpers
    // -----------------------------------------------------------------------

    async listSourceFiles(
        spaceId?: string,
        overrideFilter?: string,
    ): Promise<{ sourceFile: string; spaceId?: string; chunkCount: number; createdAt: number }[]> {
        const ragStore = getRAGStore()
        let filter: string | undefined
        if (overrideFilter) {
            filter = overrideFilter
        } else if (spaceId) {
            filter = buildMemorySpaceFilter([{ id: spaceId }])
        }
        const docs = await ragStore.listDocuments(getActivePermanentMemoryTableName(), filter)
        const indexedFiles = this.getIndexedFilePairs()

        const map = new Map<string, { sourceFile: string; spaceId?: string; count: number; latest: number }>()
        for (const doc of docs) {
            if (doc.spaceId && !indexedFiles.has(`${doc.spaceId}\0${doc.sourceFile || ''}`)) continue
            const sourceFile = doc.sourceFile || '(untitled)'
            const key = `${doc.spaceId || ''}\0${sourceFile}`
            const existing = map.get(key)
            if (existing) {
                existing.count++
                if (doc.createdAt > existing.latest) existing.latest = doc.createdAt
            } else {
                map.set(key, { sourceFile, spaceId: doc.spaceId, count: 1, latest: doc.createdAt })
            }
        }

        return Array.from(map.values())
            .map(({ sourceFile, spaceId, count, latest }) => ({ sourceFile, spaceId, chunkCount: count, createdAt: latest }))
            .sort((a, b) => b.createdAt - a.createdAt || a.sourceFile.localeCompare(b.sourceFile))
    }

    private getIndexedFilePairs(): Set<string> {
        try {
            const db = getDb()
            const rows = db
                .prepare('SELECT space_id, file_name FROM memory_file_index')
                .all() as { space_id: string; file_name: string }[]
            return new Set(rows.map((row) => `${row.space_id}\0${row.file_name}`))
        } catch {
            return new Set()
        }
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

    getFileIndex(spaceId: string): Map<string, { contentHash: string; chunkCount: number; lastIndexedAt: number; entityIndexedAt: number }> {
        try {
            const db = getDb()
            const rows = db
                .prepare('SELECT file_name, content_hash, chunk_count, last_indexed_at, entity_indexed_at FROM memory_file_index WHERE space_id = ?')
                .all(spaceId) as { file_name: string; content_hash: string; chunk_count: number; last_indexed_at: number; entity_indexed_at: number }[]
            const map = new Map<string, { contentHash: string; chunkCount: number; lastIndexedAt: number; entityIndexedAt: number }>()
            for (const row of rows) {
                map.set(row.file_name, { contentHash: row.content_hash, chunkCount: row.chunk_count, lastIndexedAt: row.last_indexed_at, entityIndexedAt: row.entity_indexed_at || 0 })
            }
            return map
        } catch {
            return new Map()
        }
    }

    getFileIndexEntry(spaceId: string, fileName: string): { contentHash: string; chunkCount: number; lastIndexedAt: number; entityIndexedAt: number } | undefined {
        try {
            const db = getDb()
            const row = db
                .prepare('SELECT content_hash, chunk_count, last_indexed_at, entity_indexed_at FROM memory_file_index WHERE space_id = ? AND file_name = ?')
                .get(spaceId, fileName) as { content_hash: string; chunk_count: number; last_indexed_at: number; entity_indexed_at: number } | undefined
            if (!row) return undefined
            return { contentHash: row.content_hash, chunkCount: row.chunk_count, lastIndexedAt: row.last_indexed_at, entityIndexedAt: row.entity_indexed_at || 0 }
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
