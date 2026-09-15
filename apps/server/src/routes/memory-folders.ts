import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getAgentMemory } from '../core/memory/agent-memory.js'
import { getRAGStore } from '../core/memory/rag.js'
import { getActivePermanentMemoryTableName } from '../core/memory/memory-index-manifest.js'
import { andLanceDbFilters, lanceDbEqFilter } from '../core/memory/lancedb-filter.js'
import {
    ensureFolder,
    listFilesInFolder,
    computeFileHash,
    copyFileToFolder,
    deleteFile as deletePhysicalFile,
    readTextFile,
    writeTextFile,
    PLAIN_TEXT_EXTENSIONS,
    resolveUniqueFileName,
} from '../core/memory/memory-file-manager.js'
import { basename, extname, join, sep } from 'path'
import { existsSync, renameSync, writeFileSync } from 'fs'
import { watchMemoryFolder, stopWatchingMemoryFolder } from '../core/memory/memory-folder-watcher.js'
import {
    archiveMemoryFolderDirectory,
    directoryPathForRelative,
    makeChildCategoryPath,
    memoryFolderDirectoryData,
    newMemoryFolderId,
    categoryPathForDirectory,
    renameMemoryFolderDirectory,
    syncMemoryFoldersFromFolders,
    validateRelativePath,
    type MemoryFolderDirectoryData,
} from '../core/memory/memory-folder-directories.js'
import {
    deleteMemoryKnowledgeSource,
    deleteMemoryKnowledgeCategory,
    deepResearchMemoryFile,
    MAX_DEEP_RESEARCH_CHUNKS,
    moveMemoryKnowledgeSource,
    type DeepResearchCheckpoint,
} from '../core/memory/memory-deep-research.js'
import {
    cancelMemoryIndexJob,
    discardMemoryIndexJob,
    dismissMemoryIndexJobFailures,
    getMemoryIndexJob,
    latestResumableMemoryIndexJob,
    listMemoryIndexJobs,
    startMemoryIndexJob,
    cancelMemoryIndexJobsForFile,
    waitForMemoryIndexJob,
} from '../core/memory/memory-index-jobs.js'
import { getMemoryKnowledgeStore, MEMORY_KNOWLEDGE_PIPELINE_VERSION, MEMORY_KNOWLEDGE_PROMPT_VERSION } from '../core/memory/memory-knowledge.js'
import { estimateChunkCountFromFileSize, getMemoryParser } from '../core/memory/parser.js'
import { buildMemoryFolderFilter } from '../core/memory/memory-folder-scope.js'
import { getMemoryDocument, getMemoryRevision, inlineMemoryDiff, listMemoryRevisions, markMemoryCategoriesDeleted, recordMemoryRevision, unifiedMemoryDiff, updateMemoryDocumentLocation } from '../core/memory/memory-revisions.js'

// ---------------------------------------------------------------------------
// Row / response types
// ---------------------------------------------------------------------------

interface MemoryFolderRow {
    id: string
    name: string
    description: string
    directory_path: string
    sort_order: number
    is_uncategorized: number
    created_at: number
}

interface MemoryFolderData {
    id: string
    name: string
    description: string
    directoryPath: string
    categoryPath: string
    depth: number
    parentCategoryPath: string | null
    sortOrder: number
    isUncategorized: boolean
    createdAt: number
    fileCount: number
}

export interface MemoryFileStatus {
    fileName: string
    extension: string
    size: number
    modifiedAt: number
    /** File type can be indexed */
    supported: boolean
    /** No parsing needed — plain text */
    textDirect: boolean
    /** 'indexed' = hash matches DB, 'needs_reindex' = hash mismatch, 'not_indexed' = not in DB, 'unsupported' = file type not supported */
    status: 'indexed' | 'needs_reindex' | 'not_indexed' | 'unsupported'
    chunkCount?: number
    estimatedChunkCount?: number
    lastIndexedAt?: number
    deepResearched: boolean
    analysisStatus: 'not_analyzed' | 'current' | 'needs_refresh'
    deepResearchedAt?: number
    dreamedAt?: number
    tags: string[]
}

export interface MemoryFileSearchResult extends MemoryFileStatus {
    categoryId: string
    categoryName: string
    categoryPath: string
    matchedFields: Array<'fileName' | 'folder' | 'tags' | 'summary' | 'content'>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToData(row: MemoryFolderRow, fileCount: number): MemoryFolderData {
    const folderData: MemoryFolderDirectoryData = memoryFolderDirectoryData(row)
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        directoryPath: folderData.directoryPath,
        categoryPath: folderData.categoryPath,
        depth: folderData.depth,
        parentCategoryPath: folderData.parentCategoryPath,
        sortOrder: row.sort_order,
        isUncategorized: row.is_uncategorized === 1,
        createdAt: row.created_at,
        fileCount,
    }
}

function loadCategoryRow(id: string): MemoryFolderRow | undefined {
    const db = getDb()
    syncMemoryFoldersFromFolders(db)
    return db.prepare('SELECT * FROM memory_folders WHERE id = ?').get(decodeCategoryIdParam(id)) as MemoryFolderRow | undefined
}

function validateEditableFileName(fileName: string): string {
    const cleanName = basename(fileName || '')
    if (!cleanName || cleanName !== fileName) {
        throw new Error('Invalid file name')
    }
    const ext = extname(cleanName).toLowerCase()
    if (!PLAIN_TEXT_EXTENSIONS.has(ext)) {
        throw new Error('Only plain-text memory files can be edited')
    }
    return cleanName
}

function decodeCategoryIdParam(id: string): string {
    try {
        return decodeURIComponent(id)
    } catch {
        return id
    }
}

function listMemoryFiles(row: MemoryFolderRow, candidateNames?: Set<string>): MemoryFileStatus[] {
    if (!row.directory_path) return []
    const mem = getAgentMemory()
    const fileIndex = mem.getFileIndex(row.id)
    const filesOnDisk = listFilesInFolder(row.directory_path).filter((file) => !candidateNames || candidateNames.has(file.fileName))
    const chunkingConfig = getMemoryParser().getConfig()
    const currentKnowledgeFiles = new Map((getDb().prepare(`
        SELECT file_name, activated_at FROM memory_knowledge_index_runs
        WHERE category_id = ? AND pipeline_version = ? AND prompt_version = ? AND status = 'active'
    `).all(row.id, MEMORY_KNOWLEDGE_PIPELINE_VERSION, MEMORY_KNOWLEDGE_PROMPT_VERSION) as Array<{ file_name: string; activated_at: number }>).map((item) => [item.file_name, item.activated_at]))

    return filesOnDisk.map(f => {
        if (!f.supported) {
            return {
                fileName: f.fileName, extension: f.extension, size: f.size, modifiedAt: f.modifiedAt,
                supported: false, textDirect: false, status: 'unsupported' as const,
                deepResearched: false, analysisStatus: 'not_analyzed' as const, tags: [],
            }
        }
        const indexed = fileIndex.get(f.fileName)
        if (!indexed) {
            return {
                fileName: f.fileName, extension: f.extension, size: f.size, modifiedAt: f.modifiedAt,
                supported: true, textDirect: f.textDirect, status: 'not_indexed' as const,
                estimatedChunkCount: estimateChunkCountFromFileSize(f.size, chunkingConfig),
                deepResearched: false, analysisStatus: 'not_analyzed' as const, tags: [],
            }
        }
        const currentHash = computeFileHash(f.filePath)
        const status = currentHash === indexed.contentHash ? 'indexed' as const : 'needs_reindex' as const
        const hasAnyAnalysis = indexed.deepResearchedAt > 0
        const currentRunActivatedAt = currentKnowledgeFiles.get(f.fileName)
        const currentAnalysis = status === 'indexed' && hasAnyAnalysis && currentRunActivatedAt !== undefined
            && indexed.deepResearchedAt >= currentRunActivatedAt
        return {
            fileName: f.fileName, extension: f.extension, size: f.size, modifiedAt: f.modifiedAt,
            supported: true, textDirect: f.textDirect, status,
            chunkCount: indexed.chunkCount,
            estimatedChunkCount: status === 'needs_reindex' ? estimateChunkCountFromFileSize(f.size, chunkingConfig) : undefined,
            lastIndexedAt: indexed.lastIndexedAt,
            deepResearched: currentAnalysis,
            analysisStatus: currentAnalysis ? 'current' as const : hasAnyAnalysis ? 'needs_refresh' as const : 'not_analyzed' as const,
            deepResearchedAt: indexed.deepResearchedAt || undefined,
            dreamedAt: indexed.dreamedAt || undefined,
            tags: currentAnalysis ? indexed.tags : [],
        }
    }).sort((a, b) => b.modifiedAt - a.modifiedAt || a.fileName.localeCompare(b.fileName))
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registerMemoryFoldersRoutes(app: FastifyInstance): Promise<void> {

    app.get<{ Querystring: { query?: string; categoryId?: string; semantic?: string } }>('/file-search', async (req, reply) => {
        const query = (req.query.query || '').normalize('NFKC').trim().toLocaleLowerCase().slice(0, 200)
        if (!query) return []
        const terms = query.split(/\s+/).filter(Boolean)
        syncMemoryFoldersFromFolders(getDb())
        const allRows = getDb().prepare('SELECT * FROM memory_folders ORDER BY sort_order, name').all() as MemoryFolderRow[]
        const requestedCategoryId = req.query.categoryId ? decodeCategoryIdParam(req.query.categoryId) : ''
        const rows = requestedCategoryId ? allRows.filter((row) => row.id === requestedCategoryId) : allRows
        if (requestedCategoryId && rows.length === 0) return reply.status(404).send({ error: 'Memory folder not found' })

        if (req.query.semantic === 'true') {
            const filter = buildMemoryFolderFilter(rows)
            const chunks = await getAgentMemory().recall(query, 100, filter)
            const rankByFile = new Map<string, number>()
            for (const chunk of chunks) {
                if (!chunk.categoryId || !chunk.sourceFile) continue
                const key = `${chunk.categoryId}\0${chunk.sourceFile}`
                if (!rankByFile.has(key)) rankByFile.set(key, rankByFile.size)
            }
            const results: Array<MemoryFileSearchResult & { rank: number }> = []
            for (const row of rows) {
                const folderData = memoryFolderDirectoryData(row)
                const candidateNames = new Set([...rankByFile.keys()]
                    .filter((key) => key.startsWith(`${row.id}\0`))
                    .map((key) => key.slice(row.id.length + 1)))
                for (const file of listMemoryFiles(row, candidateNames)) {
                    results.push({
                        ...file,
                        categoryId: row.id,
                        categoryName: row.name,
                        categoryPath: folderData.categoryPath,
                        matchedFields: ['content'],
                        rank: rankByFile.get(`${row.id}\0${file.fileName}`) ?? Number.MAX_SAFE_INTEGER,
                    })
                }
            }
            return results.sort((a, b) => a.rank - b.rank).map(({ rank: _rank, ...result }) => result)
        }
        const summaries = getDb().prepare(`
            SELECT r.category_id, r.file_name, GROUP_CONCAT(tu.summary, ' ') AS summaries
            FROM memory_knowledge_index_runs r
            JOIN memory_knowledge_text_units tu ON tu.run_id = r.id
            WHERE r.status = 'active' AND r.pipeline_version = ? AND r.prompt_version = ? AND tu.summary != ''
            GROUP BY r.category_id, r.file_name
        `).all(MEMORY_KNOWLEDGE_PIPELINE_VERSION, MEMORY_KNOWLEDGE_PROMPT_VERSION) as Array<{ category_id: string; file_name: string; summaries: string }>
        const summaryByFile = new Map(summaries.map((item) => [`${item.category_id}\0${item.file_name}`, item.summaries.normalize('NFKC').toLocaleLowerCase()]))
        const tagRows = getDb().prepare(`
            SELECT m.category_id, m.file_name, m.tags_json
            FROM memory_file_index m
            WHERE EXISTS (
                SELECT 1 FROM memory_knowledge_index_runs r
                WHERE r.document_id = m.document_id AND r.content_hash = m.content_hash
                  AND r.status = 'active' AND r.pipeline_version = ? AND r.prompt_version = ?
            )
        `).all(MEMORY_KNOWLEDGE_PIPELINE_VERSION, MEMORY_KNOWLEDGE_PROMPT_VERSION) as Array<{ category_id: string; file_name: string; tags_json: string }>
        const tagsByFile = new Map(tagRows.map((item) => [`${item.category_id}\0${item.file_name}`, item.tags_json]))
        const results: Array<MemoryFileSearchResult & { rank: number }> = []
        for (const row of rows) {
            const folderData = memoryFolderDirectoryData(row)
            const folderSurface = `${row.name} ${folderData.categoryPath}`.normalize('NFKC').toLocaleLowerCase()
            const candidateNames = new Set(listFilesInFolder(row.directory_path).filter((file) => {
                const key = `${row.id}\0${file.fileName}`
                const surface = [file.fileName, folderSurface, tagsByFile.get(key) || '', summaryByFile.get(key) || '']
                    .join(' ').normalize('NFKC').toLocaleLowerCase()
                return terms.every((term) => surface.includes(term))
            }).map((file) => file.fileName))
            for (const file of listMemoryFiles(row, candidateNames)) {
                const currentSummary = file.analysisStatus === 'current' ? summaryByFile.get(`${row.id}\0${file.fileName}`) || '' : ''
                const fields = {
                    fileName: file.fileName.normalize('NFKC').toLocaleLowerCase(),
                    folder: folderSurface,
                    tags: file.tags.join(' ').normalize('NFKC').toLocaleLowerCase(),
                    summary: currentSummary,
                }
                const combined = Object.values(fields).join(' ')
                if (!terms.every((term) => combined.includes(term))) continue
                const matchedFields = (Object.entries(fields) as Array<[MemoryFileSearchResult['matchedFields'][number], string]>)
                    .filter(([, value]) => terms.some((term) => value.includes(term)))
                    .map(([field]) => field)
                const rank = fields.fileName === query ? 0
                    : fields.fileName.startsWith(query) ? 1
                        : terms.every((term) => fields.fileName.includes(term)) ? 2
                            : terms.some((term) => fields.tags.includes(term)) ? 3
                                : terms.some((term) => fields.summary.includes(term)) ? 4 : 5
                results.push({
                    ...file,
                    categoryId: row.id,
                    categoryName: row.name,
                    categoryPath: folderData.categoryPath,
                    matchedFields,
                    rank,
                })
            }
        }
        return results
            .sort((a, b) => a.rank - b.rank || b.modifiedAt - a.modifiedAt || a.fileName.localeCompare(b.fileName))
            .map(({ rank: _rank, ...result }) => result)
    })

    app.get<{ Params: { documentRef: string } }>('/documents/:documentRef/revisions', async (req, reply) => {
        const document = getMemoryDocument(req.params.documentRef)
        if (!document) return reply.status(404).send({ error: 'Memory document not found' })
        return listMemoryRevisions(req.params.documentRef)
    })

    app.get<{ Params: { documentRef: string; revisionId: string } }>('/documents/:documentRef/revisions/:revisionId', async (req, reply) => {
        const revision = getMemoryRevision(req.params.documentRef, req.params.revisionId)
        return revision ?? reply.status(404).send({ error: 'Memory revision not found' })
    })

    app.get<{ Params: { documentRef: string }; Querystring: { from?: string; to?: string } }>('/documents/:documentRef/diff', async (req, reply) => {
        if (!req.query.from || !req.query.to) return reply.status(400).send({ error: 'from and to revision IDs are required' })
        const diff = unifiedMemoryDiff(req.params.documentRef, req.query.from, req.query.to)
        const segments = inlineMemoryDiff(req.params.documentRef, req.query.from, req.query.to)
        return diff === undefined || segments === undefined
            ? reply.status(404).send({ error: 'Memory revision not found' })
            : { format: 'unified', diff, segments }
    })

    app.post<{ Params: { documentRef: string; revisionId: string }; Body: { expectedRevision?: string } }>('/documents/:documentRef/revisions/:revisionId/restore', async (req, reply) => {
        const document = getMemoryDocument(req.params.documentRef)
        const revision = getMemoryRevision(req.params.documentRef, req.params.revisionId)
        if (!document || !revision) return reply.status(404).send({ error: 'Memory revision not found' })
        const category = loadCategoryRow(document.category_id)
        if (!category?.directory_path) return reply.status(409).send({ error: 'Memory folder is unavailable' })
        const filePath = join(category.directory_path, document.file_name)
        const currentHash = existsSync(filePath) ? computeFileHash(filePath) : ''
        if (req.body.expectedRevision !== undefined && req.body.expectedRevision !== currentHash) {
            return reply.status(409).send({ error: 'Memory changed since it was opened. Reload before restoring.', revision: currentHash })
        }
        writeTextFile(category.directory_path, document.file_name, revision.content)
        getDb().prepare(`
          INSERT OR REPLACE INTO memory_file_index(document_id, document_ref, category_id, file_name, content_hash, chunk_count, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?)
        `).run(document.document_id, document.document_ref, document.category_id, document.file_name, revision.contentHash, Date.now())
        const result = await getAgentMemory().reindexFile(category.directory_path, document.file_name, document.category_id, { revisionContext: { source: 'restore' } })
        return { success: true, documentRef: document.document_ref, revision: getAgentMemory().getDocumentReference(document.category_id, document.file_name)?.revision, chunksStored: result.chunkCount }
    })

    app.get('/deleted', async () => getDb().prepare(`
      SELECT document_ref AS documentRef, category_id AS categoryId, file_name AS fileName, current_hash AS revision, deleted_at AS deletedAt
      FROM memory_documents WHERE status = 'deleted' ORDER BY deleted_at DESC
    `).all())

    // GET /api/memory-folders/jobs — list recent background indexing jobs
    app.get('/jobs', async () => {
        return listMemoryIndexJobs()
    })

    // DELETE /api/memory-folders/jobs/failures — dismiss every failed job.
    // Registered before the parameterized route so "failures" is not read as a job id.
    app.delete<{ Querystring: { categoryId?: string } }>('/jobs/failures', async (req) => {
        return { success: true, dismissed: dismissMemoryIndexJobFailures(req.query.categoryId) }
    })

    // GET /api/memory-folders/jobs/:jobId — inspect one background indexing job
    app.get<{ Params: { jobId: string } }>('/jobs/:jobId', async (req, reply) => {
        const job = getMemoryIndexJob(req.params.jobId)
        if (!job) return reply.status(404).send({ error: 'Job not found' })
        return job
    })

    // POST /api/memory-folders/jobs/:jobId/cancel — cancel one background indexing job
    app.post<{ Params: { jobId: string } }>('/jobs/:jobId/cancel', async (req, reply) => {
        const job = cancelMemoryIndexJob(req.params.jobId)
        if (!job) return reply.status(404).send({ error: 'Job not found' })
        return job
    })

    // DELETE /api/memory-folders/jobs/:jobId — discard a paused extraction checkpoint.
    app.delete<{ Params: { jobId: string } }>('/jobs/:jobId', async (req, reply) => {
        await waitForMemoryIndexJob(req.params.jobId)
        if (!discardMemoryIndexJob(req.params.jobId)) {
            return reply.status(409).send({ error: 'Only finished or cancelled jobs can be discarded' })
        }
        return { success: true }
    })

    // GET /api/memory-folders — list all categories with file counts
    app.get('/', async () => {
        const db = getDb()
        syncMemoryFoldersFromFolders(db)
        const rows = db.prepare('SELECT * FROM memory_folders ORDER BY is_uncategorized DESC, directory_path ASC').all() as MemoryFolderRow[]
        return rows.map(row => {
            const files = listFilesInFolder(row.directory_path).filter(f => f.supported)
            return rowToData(row, files.length)
        })
    })

    // POST /api/memory-folders — create a directory-backed category
    app.post<{ Body: { name: string; description?: string; parentCategoryPath?: string } }>('/', async (req, reply) => {
        const { name, description, parentCategoryPath } = req.body
        if (!name?.trim()) return reply.status(400).send({ error: 'name is required' })
        const trimmedName = name.trim()
        const db = getDb()
        syncMemoryFoldersFromFolders(db)
        let categoryPath: string
        try {
            categoryPath = makeChildCategoryPath(trimmedName, parentCategoryPath || '')
        } catch (err) {
            return reply.status(400).send({ error: (err as Error).message })
        }
        const resolvedFolder = directoryPathForRelative(categoryPath)
        const existing = db.prepare('SELECT id FROM memory_folders WHERE directory_path = ?').get(resolvedFolder) as { id: string } | undefined
        if (existing) return reply.status(409).send({ error: 'A memory folder with that path already exists.' })

        const id = newMemoryFolderId()
        const now = Date.now()
        ensureFolder(resolvedFolder)
        db.prepare('INSERT INTO memory_folders (id, name, description, directory_path, sort_order, is_uncategorized, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(id, trimmedName, description || '', resolvedFolder, 0, 0, now)
        watchMemoryFolder(id, resolvedFolder)
        return rowToData({ id, name: trimmedName, description: description || '', directory_path: resolvedFolder, sort_order: 0, is_uncategorized: 0, created_at: now }, 0)
    })

    // PUT /api/memory-folders/reorder — update sort order
    app.put<{ Body: { ids: string[] } }>('/reorder', async (req, reply) => {
        const { ids } = req.body
        if (!Array.isArray(ids)) return reply.status(400).send({ error: 'ids must be an array' })
        const db = getDb()
        const stmt = db.prepare('UPDATE memory_folders SET sort_order = ? WHERE id = ?')
        const runAll = db.transaction(() => {
            for (let i = 0; i < ids.length; i++) stmt.run(i, ids[i])
        })
        runAll()
        return { success: true }
    })

    // PUT /api/memory-folders/:id — update name/description/categoryPath
    app.put<{ Params: { id: string }; Body: { name?: string; description?: string; categoryPath?: string } }>('/:id', async (req, reply) => {
        const db = getDb()
        syncMemoryFoldersFromFolders(db)
        const categoryId = decodeCategoryIdParam(req.params.id)
        const row = db.prepare('SELECT * FROM memory_folders WHERE id = ?').get(categoryId) as MemoryFolderRow | undefined
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })

        const name = req.body.name?.trim() || row.name
        const description = req.body.description !== undefined ? req.body.description : row.description
        let directoryPath = row.directory_path
        let nextName = name

        if (row.is_uncategorized === 1 && req.body.categoryPath !== undefined && validateRelativePath(req.body.categoryPath) !== '') {
            return reply.status(400).send({ error: 'Cannot move the Uncategorized memory folder.' })
        }

        if (row.is_uncategorized === 0) {
            const currentRelativePath = categoryPathForDirectory(row.directory_path)
            const requestedRelativePath = req.body.categoryPath !== undefined
                ? req.body.categoryPath
                : (() => {
                    const parent = currentRelativePath.includes('/') ? currentRelativePath.slice(0, currentRelativePath.lastIndexOf('/')) : ''
                    return parent ? `${parent}/${name}` : name
                })()
            let nextRelativePath: string
            try {
                nextRelativePath = validateRelativePath(requestedRelativePath)
            } catch (err) {
                return reply.status(400).send({ error: (err as Error).message })
            }
            if (nextRelativePath !== currentRelativePath) {
                try {
                    const oldFolderPath = row.directory_path
                    const descendants = db.prepare('SELECT * FROM memory_folders WHERE id != ? AND directory_path LIKE ?').all(row.id, `${oldFolderPath}${oldFolderPath.endsWith(sep) ? '' : sep}%`) as MemoryFolderRow[]
                    const renamed = renameMemoryFolderDirectory(row, nextRelativePath)
                    directoryPath = renamed.directory_path
                    nextName = renamed.name
                    for (const child of descendants) {
                        const childFolderPath = `${directoryPath}${child.directory_path.slice(oldFolderPath.length)}`
                        db.prepare('UPDATE memory_folders SET directory_path = ? WHERE id = ?').run(childFolderPath, child.id)
                        watchMemoryFolder(child.id, childFolderPath)
                    }
                } catch (err) {
                    return reply.status(409).send({ error: (err as Error).message })
                }
            }
        }

        db.prepare('UPDATE memory_folders SET name = ?, description = ?, directory_path = ? WHERE id = ?').run(nextName, description, directoryPath, row.id)
        watchMemoryFolder(row.id, directoryPath)
        const files = listFilesInFolder(directoryPath).filter(f => f.supported)
        return rowToData({ ...row, name: nextName, description, directory_path: directoryPath }, files.length)
    })

    // DELETE /api/memory-folders/:id — archive folder + delete vectors/index
    app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
        const db = getDb()
        syncMemoryFoldersFromFolders(db)
        const categoryId = decodeCategoryIdParam(req.params.id)
        const row = db.prepare('SELECT * FROM memory_folders WHERE id = ?').get(categoryId) as MemoryFolderRow | undefined
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        if (row.is_uncategorized) {
            return reply.status(400).send({ error: 'Cannot delete the Uncategorized memory folder.' })
        }
        const rag = getRAGStore()
        const categoryPath = categoryPathForDirectory(row.directory_path)
        const descendants = db.prepare('SELECT * FROM memory_folders WHERE id != ? AND directory_path LIKE ?').all(row.id, `${row.directory_path}${row.directory_path.endsWith(sep) ? '' : sep}%`) as MemoryFolderRow[]
        const rowsToDelete = [row, ...descendants]
        for (const target of rowsToDelete) {
            await rag.deleteByFilter(getActivePermanentMemoryTableName(), lanceDbEqFilter('categoryId', target.id))
            stopWatchingMemoryFolder(target.id)
            // Retire the knowledge derived from this category.
            deleteMemoryKnowledgeCategory(target.id)
        }
        archiveMemoryFolderDirectory(row)
        const deleteRows = db.transaction(() => {
            markMemoryCategoriesDeleted(rowsToDelete.map(target => target.id))
            for (const target of rowsToDelete) {
                db.prepare('DELETE FROM memory_file_index WHERE category_id = ?').run(target.id)
                db.prepare('DELETE FROM agent_memory_folders WHERE category_id = ?').run(target.id)
                db.prepare('DELETE FROM memory_folders WHERE id = ?').run(target.id)
            }
        })
        deleteRows()
        return { success: true, archived: categoryPath }
    })

    // -----------------------------------------------------------------------
    // File browser
    // -----------------------------------------------------------------------

    // GET /api/memory-folders/:id/jobs — list recent indexing jobs for a category
    app.get<{ Params: { id: string } }>('/:id/jobs', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        return listMemoryIndexJobs(row.id)
    })

    // POST /api/memory-folders/:id/knowledge/rebuild — migrate every current
    // source document in a category into the versioned knowledge projection.
    // Jobs are durable, bounded by the shared worker pool, and independently
    // retryable; source files and their current RAG index remain untouched.
    app.post<{ Params: { id: string } }>('/:id/knowledge/rebuild', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        if (!row.directory_path) return reply.status(400).send({ error: 'Memory folder has no backing directory' })
        const mem = getAgentMemory()
        const indexedFiles = mem.getFileIndex(row.id)
        const jobs = []
        const skipped: Array<{ fileName: string; reason: string }> = []
        for (const [fileName] of indexedFiles) {
            const status = mem.checkFileStatus(row.id, fileName, row.directory_path)
            if (status !== 'current') {
                skipped.push({ fileName, reason: status })
                continue
            }
            const chunkCount = mem.getFileIndexEntry(row.id, fileName)?.chunkCount || 0
            if (chunkCount > MAX_DEEP_RESEARCH_CHUNKS) {
                skipped.push({ fileName, reason: `analysis_limit_${MAX_DEEP_RESEARCH_CHUNKS}_chunks` })
                continue
            }
            jobs.push(startMemoryIndexJob({
                kind: 'deep-research',
                categoryId: row.id,
                fileName,
                run: async (signal, reportProgress) => ({
                    success: true,
                    ...(await deepResearchMemoryFile({
                        directoryPath: row.directory_path,
                        categoryId: row.id,
                        fileName,
                        replaceExisting: true,
                        signal,
                        onDeepResearchProgress: reportProgress,
                    })),
                }),
            }))
        }
        return { success: true, scheduled: jobs.length, jobs, skipped }
    })

    // GET /api/memory-folders/:id/files — list files in folder with index status
    app.get<{ Params: { id: string } }>('/:id/files', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        if (!row.directory_path) return reply.status(400).send({ error: 'Memory folder has no backing directory' })
        return listMemoryFiles(row)
    })

    // GET /api/memory-folders/:id/files/:fileName/knowledge-preview — a small,
    // source-specific summary for the document list hover popover.
    app.get<{ Params: { id: string; fileName: string } }>('/:id/files/:fileName/knowledge-preview', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        return getMemoryKnowledgeStore().documentDeepResearchPreview(row.id, req.params.fileName, 15)
    })

    // GET /api/memory-folders/:id/files/:fileName/analysis — current or stale
    // derived summaries and knowledge for the read-only editor sidebar.
    app.get<{ Params: { id: string; fileName: string } }>('/:id/files/:fileName/analysis', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        const chunkCount = getAgentMemory().getFileIndexEntry(row.id, req.params.fileName)?.chunkCount || 0
        if (chunkCount > MAX_DEEP_RESEARCH_CHUNKS) {
            return { status: 'too_large' as const, chunkCount, maxChunks: MAX_DEEP_RESEARCH_CHUNKS, chunks: [], items: [], itemTotal: 0 }
        }
        const analysis = getMemoryKnowledgeStore().documentAnalysis(row.id, req.params.fileName)
        if (!analysis) return { status: 'not_analyzed' as const, chunks: [], items: [], itemTotal: 0 }
        const filePath = join(row.directory_path, req.params.fileName)
        const currentHash = existsSync(filePath) ? computeFileHash(filePath) : ''
        const indexed = getAgentMemory().getFileIndexEntry(row.id, req.params.fileName)
        const status = analysis.contentHash === currentHash
            && analysis.pipelineVersion === MEMORY_KNOWLEDGE_PIPELINE_VERSION
            && analysis.promptVersion === MEMORY_KNOWLEDGE_PROMPT_VERSION
            && Boolean(indexed?.deepResearchedAt && indexed.deepResearchedAt >= analysis.activatedAt)
            ? 'current' as const
            : 'needs_refresh' as const
        return {
            status,
            pipelineVersion: analysis.pipelineVersion,
            promptVersion: analysis.promptVersion,
            chunks: analysis.chunks,
            items: analysis.items,
            itemTotal: analysis.items.length,
        }
    })

    // POST /api/memory-folders/:id/files/:fileName/reindex — re-index a specific file
    app.post<{ Params: { id: string; fileName: string } }>('/:id/files/:fileName/reindex', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        if (!row.directory_path) return reply.status(400).send({ error: 'Memory folder has no backing directory' })

        const mem = getAgentMemory()
        try {
            const result = await mem.reindexFile(row.directory_path, req.params.fileName, row.id)
            return { success: true, chunkCount: result.chunkCount, fileName: result.fileName }
        } catch (err) {
            return reply.status(500).send({ error: (err as Error).message || 'Failed to reindex file' })
        }
    })

    // POST /api/memory-folders/:id/files/:fileName/reindex-job — start a background re-index job
    app.post<{ Params: { id: string; fileName: string } }>('/:id/files/:fileName/reindex-job', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        if (!row.directory_path) return reply.status(400).send({ error: 'Memory folder has no backing directory' })

        const mem = getAgentMemory()
        return startMemoryIndexJob({
            kind: 'reindex',
            categoryId: row.id,
            fileName: req.params.fileName,
            run: async (signal) => {
                const result = await mem.reindexFile(row.directory_path, req.params.fileName, row.id, { signal })
                return { success: true, chunksStored: result.chunkCount, fileName: result.fileName }
            },
        })
    })

    // Extract one indexed document into governed knowledge.
    app.post<{ Params: { id: string; fileName: string } }>('/:id/files/:fileName/deep-research', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        if (!row.directory_path) return reply.status(400).send({ error: 'Memory folder has no backing directory' })

        const mem = getAgentMemory()
        const status = mem.checkFileStatus(row.id, req.params.fileName, row.directory_path)
        if (status !== 'current') {
            return reply.status(409).send({ error: status === 'not_indexed' ? 'File must be indexed before Deep Research.' : 'File must be re-indexed before Deep Research.' })
        }
        const chunkCount = mem.getFileIndexEntry(row.id, req.params.fileName)?.chunkCount || 0
        if (chunkCount > MAX_DEEP_RESEARCH_CHUNKS) {
            return reply.status(422).send({ error: `Analysis supports at most ${MAX_DEEP_RESEARCH_CHUNKS} chunks; this document has ${chunkCount}.` })
        }

        try {
            return {
                success: true,
                ...(await deepResearchMemoryFile({
                    directoryPath: row.directory_path,
                    categoryId: row.id,
                    fileName: req.params.fileName,
                    replaceExisting: true,
                })),
            }
        } catch (err) {
            return reply.status(500).send({ error: (err as Error).message || 'Failed to run Deep Research from file' })
        }
    })

    // Start a background deep-research job.
    app.post<{ Params: { id: string; fileName: string } }>('/:id/files/:fileName/deep-research-job', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        if (!row.directory_path) return reply.status(400).send({ error: 'Memory folder has no backing directory' })

        const mem = getAgentMemory()
        const status = mem.checkFileStatus(row.id, req.params.fileName, row.directory_path)
        if (status !== 'current') {
            return reply.status(409).send({ error: status === 'not_indexed' ? 'File must be indexed before Deep Research.' : 'File must be re-indexed before Deep Research.' })
        }
        const chunkCount = mem.getFileIndexEntry(row.id, req.params.fileName)?.chunkCount || 0
        if (chunkCount > MAX_DEEP_RESEARCH_CHUNKS) {
            return reply.status(422).send({ error: `Analysis supports at most ${MAX_DEEP_RESEARCH_CHUNKS} chunks; this document has ${chunkCount}.` })
        }

        const resumableJob = latestResumableMemoryIndexJob(row.id, req.params.fileName)
        const resumeCheckpoint = (resumableJob?.result as { resumeCheckpoint?: DeepResearchCheckpoint } | undefined)?.resumeCheckpoint
        return startMemoryIndexJob({
            kind: 'deep-research',
            categoryId: row.id,
            fileName: req.params.fileName,
            resume: resumableJob && resumeCheckpoint ? {
                current: resumableJob.progressCurrent || 0,
                total: resumableJob.progressTotal || 0,
                checkpoint: resumeCheckpoint,
            } : undefined,
            run: async (signal, reportProgress) => ({
                success: true,
                ...(await deepResearchMemoryFile({
                    directoryPath: row.directory_path,
                    categoryId: row.id,
                    fileName: req.params.fileName,
                    replaceExisting: true,
                    signal,
                    resumeCheckpoint,
                    onDeepResearchCheckpoint: (checkpoint, current, total) => reportProgress(current, total, checkpoint),
                })),
            }),
        })
    })

    // DELETE /api/memory-folders/:id/files/:fileName — archive a file and remove its indexes
    app.delete<{ Params: { id: string; fileName: string } }>('/:id/files/:fileName', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })

        const mem = getAgentMemory()
        await mem.deleteSourceFile(req.params.fileName, row.id)
        deleteMemoryKnowledgeSource(row.id, req.params.fileName)
        return { success: true }
    })

    // GET /api/memory-folders/:id/files/:fileName/content — read editable file content
    app.get<{ Params: { id: string; fileName: string } }>('/:id/files/:fileName/content', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        if (!row.directory_path) return reply.status(400).send({ error: 'Memory folder has no backing directory' })

        let fileName: string
        try {
            fileName = validateEditableFileName(req.params.fileName)
        } catch (err) {
            return reply.status(400).send({ error: (err as Error).message })
        }

        try {
            const documentRef = getAgentMemory().getDocumentReference(row.id, fileName)?.documentRef
            return {
                fileName,
                content: readTextFile(row.directory_path, fileName),
                revision: computeFileHash(join(row.directory_path, fileName)),
                documentRef,
            }
        } catch {
            return reply.status(404).send({ error: 'File not found' })
        }
    })

    // PUT /api/memory-folders/:id/files/:fileName/content — persist editable content, then refresh vectors in the background
    app.put<{ Params: { id: string; fileName: string }; Body: { content: string; expectedRevision?: string } }>('/:id/files/:fileName/content', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        if (!row.directory_path) return reply.status(400).send({ error: 'Memory folder has no backing directory' })
        if (typeof req.body.content !== 'string') return reply.status(400).send({ error: 'content is required' })

        let fileName: string
        try {
            fileName = validateEditableFileName(req.params.fileName)
        } catch (err) {
            return reply.status(400).send({ error: (err as Error).message })
        }

        const currentRevision = computeFileHash(join(row.directory_path, fileName))
        if (req.body.expectedRevision && req.body.expectedRevision !== currentRevision) {
            return reply.status(409).send({
                error: 'Memory changed since it was opened. Reload it before saving your changes.',
                revision: currentRevision,
            })
        }
        try {
            writeTextFile(row.directory_path, fileName, req.body.content)
            const revision = computeFileHash(join(row.directory_path, fileName))
            const identity = getAgentMemory().getDocumentReference(row.id, fileName)
            if (identity) {
                recordMemoryRevision({
                    documentId: identity.documentId,
                    documentRef: identity.documentRef,
                    categoryId: row.id,
                    fileName,
                    content: req.body.content,
                    context: { source: 'user' },
                    indexingStatus: 'pending',
                })
            }
            return {
                success: true,
                fileName,
                revision,
            }
        } catch (err) {
            return reply.status(500).send({ error: (err as Error).message || 'Failed to update file' })
        }
    })

    // PUT /api/memory-folders/:id/files/:fileName/name — rename an editable memory file
    app.put<{ Params: { id: string; fileName: string }; Body: { fileName?: string } }>('/:id/files/:fileName/name', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        if (!row.directory_path) return reply.status(400).send({ error: 'Memory folder has no backing directory' })

        let currentFileName: string
        let nextFileName: string
        try {
            currentFileName = validateEditableFileName(req.params.fileName)
            nextFileName = validateEditableFileName(req.body.fileName || '')
        } catch (err) {
            return reply.status(400).send({ error: (err as Error).message })
        }

        if (currentFileName === nextFileName) {
            return { success: true, fileName: nextFileName }
        }

        const sourcePath = join(row.directory_path, currentFileName)
        const targetPath = join(row.directory_path, nextFileName)
        if (!existsSync(sourcePath)) return reply.status(404).send({ error: 'File not found' })
        if (existsSync(targetPath)) return reply.status(409).send({ error: 'A memory file with that name already exists' })

        try {
            renameSync(sourcePath, targetPath)
            cancelMemoryIndexJobsForFile(row.id, currentFileName)

            const rag = getRAGStore()
            const filter = andLanceDbFilters(
                lanceDbEqFilter('categoryId', row.id),
                lanceDbEqFilter('sourceFile', currentFileName),
            )
            if (filter) await rag.updateSourceFile(getActivePermanentMemoryTableName(), filter, nextFileName)

            getDb().prepare('UPDATE memory_file_index SET file_name = ? WHERE category_id = ? AND file_name = ?')
                .run(nextFileName, row.id, currentFileName)
            const identity = getAgentMemory().getDocumentReference(row.id, nextFileName)
            if (identity) updateMemoryDocumentLocation(identity.documentId, row.id, nextFileName)
            moveMemoryKnowledgeSource(row.id, currentFileName, row.id, nextFileName)

            return { success: true, fileName: nextFileName }
        } catch (err) {
            return reply.status(500).send({ error: (err as Error).message || 'Failed to rename file' })
        }
    })

    // -----------------------------------------------------------------------
    // Ingest / upload
    // -----------------------------------------------------------------------

    // POST /api/memory-folders/:id/ingest-file — upload a document to a category without indexing it
    app.post<{ Params: { id: string }; Body: { fileName: string; content: string } }>('/:id/ingest-file', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        const { fileName, content } = req.body
        if (!fileName || content == null) return reply.status(400).send({ error: 'fileName and content are required' })
        if (!row.directory_path) return reply.status(400).send({ error: 'Memory folder has no backing directory' })

        try {
            ensureFolder(row.directory_path)
            const safeFileName = basename(fileName)
            if (!safeFileName) return reply.status(400).send({ error: 'Invalid fileName' })
            const uniqueName = resolveUniqueFileName(row.directory_path, safeFileName)
            const targetPath = join(row.directory_path, uniqueName)

            if (content.startsWith('data:')) {
                const base64 = content.split(',')[1]
                if (!base64) return reply.status(400).send({ error: 'Invalid file content' })
                writeFileSync(targetPath, Buffer.from(base64, 'base64'))
            } else {
                writeTextFile(row.directory_path, uniqueName, content)
            }

            return { success: true, chunksStored: 0, fileName: uniqueName }
        } catch (err) {
            return reply.status(500).send({ error: (err as Error).message || 'Failed to ingest file' })
        }
    })

    // POST /api/memory-folders/:id/reingest-file — re-index an existing file in the category
    app.post<{ Params: { id: string }; Body: { fileName?: string; sourceFile?: string } }>('/:id/reingest-file', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        if (!row.directory_path) return reply.status(400).send({ error: 'Memory folder has no backing directory' })
        const fileName = req.body.fileName || req.body.sourceFile
        if (!fileName) return reply.status(400).send({ error: 'fileName is required' })

        try {
            const mem = getAgentMemory()
            const result = await mem.reindexFile(row.directory_path, fileName, row.id)
            return { success: true, chunksStored: result.chunkCount, fileName: result.fileName }
        } catch (err) {
            return reply.status(500).send({ error: (err as Error).message || 'Failed to reingest file' })
        }
    })

    // POST /api/memory-folders/:id/delete-documents — archive documents and remove their indexes
    app.post<{ Params: { id: string }; Body: { sourceFiles: string[] } }>('/:id/delete-documents', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        const { sourceFiles } = req.body
        if (!sourceFiles?.length) return reply.status(400).send({ error: 'No sourceFiles provided' })
        const mem = getAgentMemory()
        for (const sf of sourceFiles) {
            await mem.deleteSourceFile(sf, row.id)
            deleteMemoryKnowledgeSource(row.id, sf)
        }
        return { success: true }
    })

    // POST /api/memory-folders/:id/drop-indexes — forget derived vectors and
    // extracted facts while preserving the source documents unchanged.
    app.post<{ Params: { id: string }; Body: { sourceFiles: string[] } }>('/:id/drop-indexes', async (req, reply) => {
        const row = loadCategoryRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Memory folder not found' })
        const sourceFiles = Array.from(new Set(
            (req.body.sourceFiles || []).filter((sourceFile): sourceFile is string =>
                typeof sourceFile === 'string' && sourceFile.length > 0
            )
        ))
        if (sourceFiles.length === 0) return reply.status(400).send({ error: 'No sourceFiles provided' })

        const chunksDeleted = await getAgentMemory().dropSourceIndexes(sourceFiles, row.id)
        let graphEdgesDeleted = 0
        for (const sourceFile of sourceFiles) {
            graphEdgesDeleted += deleteMemoryKnowledgeSource(row.id, sourceFile).edgesDeleted
        }

        return {
            success: true,
            filesReset: sourceFiles.length,
            chunksDeleted,
            graphEdgesDeleted,
        }
    })

    // POST /api/memory-folders/:id/move-documents — move files to another category
    app.post<{ Params: { id: string }; Body: { sourceFiles: string[]; targetCategoryId: string } }>('/:id/move-documents', async (req, reply) => {
        const db = getDb()
        syncMemoryFoldersFromFolders(db)
        const categoryId = decodeCategoryIdParam(req.params.id)
        const source = db.prepare('SELECT * FROM memory_folders WHERE id = ?').get(categoryId) as MemoryFolderRow | undefined
        if (!source) return reply.status(404).send({ error: 'Source memory folder not found' })
        const { sourceFiles, targetCategoryId } = req.body
        if (!sourceFiles?.length) return reply.status(400).send({ error: 'No sourceFiles provided' })
        if (!targetCategoryId) return reply.status(400).send({ error: 'targetCategoryId is required' })
        if (targetCategoryId === source.id) return reply.status(400).send({ error: 'Target memory folder must be different from source' })

        const target = db.prepare('SELECT * FROM memory_folders WHERE id = ?').get(targetCategoryId) as MemoryFolderRow | undefined
        if (!target) return reply.status(404).send({ error: 'Target memory folder not found' })

        const rag = getRAGStore()
        const mem = getAgentMemory()
        let renamedCount = 0

        for (const sf of sourceFiles) {
            const uniqueName = await mem.resolveUniqueSourceFile(sf, target.id)
            if (uniqueName !== sf) renamedCount++
            const existingIndex = db.prepare('SELECT document_id, document_ref, content_hash, chunk_count, last_indexed_at, deep_researched_at, dreamed_at, created_at FROM memory_file_index WHERE category_id = ? AND file_name = ?')
                .get(source.id, sf) as { document_id: string; document_ref: string; content_hash: string; chunk_count: number; last_indexed_at: number; deep_researched_at: number; dreamed_at: number; created_at: number } | undefined

            // Move the physical file between category directories
            if (source.directory_path && target.directory_path) {
                try {
                    copyFileToFolder(join(source.directory_path, sf), target.directory_path, uniqueName)
                    deletePhysicalFile(source.directory_path, sf)
                } catch { /* file may not exist on disk */ }
            }

            // Update LanceDB sourceFile name if renamed
            if (uniqueName !== sf) {
                const srcFilter = andLanceDbFilters(
                    lanceDbEqFilter('categoryId', source.id),
                    lanceDbEqFilter('sourceFile', sf),
                )
                if (srcFilter) await rag.updateSourceFile(getActivePermanentMemoryTableName(), srcFilter, uniqueName)
            }

            // Move vectors to the target category
            const filter = andLanceDbFilters(
                lanceDbEqFilter('categoryId', source.id),
                lanceDbEqFilter('sourceFile', uniqueName),
            )
            if (!filter) continue
            await rag.updateCategoryId(getActivePermanentMemoryTableName(), filter, target.id)

            // Move file index entry
            if (existingIndex) {
                db.prepare('DELETE FROM memory_file_index WHERE category_id = ? AND file_name = ?').run(source.id, sf)
                db.prepare(`
                    INSERT OR REPLACE INTO memory_file_index (document_id, document_ref, category_id, file_name, content_hash, chunk_count, last_indexed_at, deep_researched_at, dreamed_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    existingIndex.document_id,
                    existingIndex.document_ref,
                    target.id,
                    uniqueName,
                    existingIndex.content_hash,
                    existingIndex.chunk_count,
                    existingIndex.last_indexed_at,
                    existingIndex.deep_researched_at,
                    existingIndex.dreamed_at,
                    existingIndex.created_at,
                )
                updateMemoryDocumentLocation(existingIndex.document_id, target.id, uniqueName)
            }
            moveMemoryKnowledgeSource(source.id, sf, target.id, uniqueName)
        }

        return { success: true, moved: sourceFiles.length, renamed: renamedCount }
    })
}
