import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getAgentMemory } from '../core/memory/agent-memory.js'
import { getRAGStore } from '../core/memory/rag.js'
import { andLanceDbFilters, lanceDbEqFilter } from '../core/memory/lancedb-filter.js'
import {
    ensureFolder,
    listFilesInFolder,
    computeFileHash,
    copyFileToFolder,
    deleteFile as deletePhysicalFile,
    backupToRevisions,
    readTextFile,
    writeTextFile,
    PLAIN_TEXT_EXTENSIONS,
    resolveUniqueFileName,
} from '../core/memory/memory-file-manager.js'
import { basename, extname, join, sep } from 'path'
import { existsSync, renameSync, writeFileSync } from 'fs'
import { watchMemorySpace, stopWatchingMemorySpace } from '../core/memory/memory-space-watcher.js'
import {
    archiveMemorySpaceFolder,
    folderPathForRelative,
    makeSubfolderRelativePath,
    memorySpaceFolderData,
    newMemorySpaceId,
    relativePathForFolder,
    renameMemorySpaceFolder,
    syncMemorySpacesFromFolders,
    validateRelativePath,
    type MemorySpaceFolderData,
} from '../core/memory/memory-space-folders.js'
import {
    deleteMemoryGraphSource,
    indexMemoryFileIntoEntityGraph,
    moveMemoryGraphSource,
} from '../core/memory/memory-entity-indexer.js'
import {
    cancelMemoryIndexJob,
    getMemoryIndexJob,
    listMemoryIndexJobs,
    startMemoryIndexJob,
    cancelMemoryIndexJobsForFile,
} from '../core/memory/memory-index-jobs.js'

// ---------------------------------------------------------------------------
// Row / response types
// ---------------------------------------------------------------------------

interface MemorySpaceRow {
    id: string
    name: string
    description: string
    folder_path: string
    sort_order: number
    is_default: number
    created_at: number
}

interface MemorySpaceData {
    id: string
    name: string
    description: string
    folderPath: string
    relativePath: string
    depth: number
    parentRelativePath: string | null
    sortOrder: number
    isDefault: boolean
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
    lastIndexedAt?: number
    entityIndexed: boolean
    entityIndexedAt?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToData(row: MemorySpaceRow, fileCount: number): MemorySpaceData {
    const folderData: MemorySpaceFolderData = memorySpaceFolderData(row)
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        folderPath: folderData.folderPath,
        relativePath: folderData.relativePath,
        depth: folderData.depth,
        parentRelativePath: folderData.parentRelativePath,
        sortOrder: row.sort_order,
        isDefault: row.is_default === 1,
        createdAt: row.created_at,
        fileCount,
    }
}

function loadSpaceRow(id: string): MemorySpaceRow | undefined {
    const db = getDb()
    syncMemorySpacesFromFolders(db)
    return db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(decodeSpaceIdParam(id)) as MemorySpaceRow | undefined
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

function decodeSpaceIdParam(id: string): string {
    try {
        return decodeURIComponent(id)
    } catch {
        return id
    }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registerMemorySpacesRoutes(app: FastifyInstance): Promise<void> {

    // GET /api/memory-spaces/jobs — list recent background indexing jobs
    app.get('/jobs', async () => {
        return listMemoryIndexJobs()
    })

    // GET /api/memory-spaces/jobs/:jobId — inspect one background indexing job
    app.get<{ Params: { jobId: string } }>('/jobs/:jobId', async (req, reply) => {
        const job = getMemoryIndexJob(req.params.jobId)
        if (!job) return reply.status(404).send({ error: 'Job not found' })
        return job
    })

    // POST /api/memory-spaces/jobs/:jobId/cancel — cancel one background indexing job
    app.post<{ Params: { jobId: string } }>('/jobs/:jobId/cancel', async (req, reply) => {
        const job = cancelMemoryIndexJob(req.params.jobId)
        if (!job) return reply.status(404).send({ error: 'Job not found' })
        return job
    })

    // GET /api/memory-spaces — list all spaces with file counts
    app.get('/', async () => {
        const db = getDb()
        syncMemorySpacesFromFolders(db)
        const rows = db.prepare('SELECT * FROM memory_spaces ORDER BY is_default DESC, folder_path ASC').all() as MemorySpaceRow[]
        return rows.map(row => {
            const files = listFilesInFolder(row.folder_path).filter(f => f.supported)
            return rowToData(row, files.length)
        })
    })

    // POST /api/memory-spaces — create a subfolder-backed space
    app.post<{ Body: { name: string; description?: string; parentRelativePath?: string } }>('/', async (req, reply) => {
        const { name, description, parentRelativePath } = req.body
        if (!name?.trim()) return reply.status(400).send({ error: 'name is required' })
        const trimmedName = name.trim()
        const db = getDb()
        syncMemorySpacesFromFolders(db)
        let relativePath: string
        try {
            relativePath = makeSubfolderRelativePath(trimmedName, parentRelativePath || '')
        } catch (err) {
            return reply.status(400).send({ error: (err as Error).message })
        }
        const resolvedFolder = folderPathForRelative(relativePath)
        const existing = db.prepare('SELECT id FROM memory_spaces WHERE folder_path = ?').get(resolvedFolder) as { id: string } | undefined
        if (existing) return reply.status(409).send({ error: 'A memory folder with that path already exists.' })

        const id = newMemorySpaceId()
        const now = Date.now()
        ensureFolder(resolvedFolder)
        db.prepare('INSERT INTO memory_spaces (id, name, description, folder_path, sort_order, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(id, trimmedName, description || '', resolvedFolder, 0, 0, now)
        watchMemorySpace(id, resolvedFolder)
        return rowToData({ id, name: trimmedName, description: description || '', folder_path: resolvedFolder, sort_order: 0, is_default: 0, created_at: now }, 0)
    })

    // PUT /api/memory-spaces/reorder — update sort order
    app.put<{ Body: { ids: string[] } }>('/reorder', async (req, reply) => {
        const { ids } = req.body
        if (!Array.isArray(ids)) return reply.status(400).send({ error: 'ids must be an array' })
        const db = getDb()
        const stmt = db.prepare('UPDATE memory_spaces SET sort_order = ? WHERE id = ?')
        const runAll = db.transaction(() => {
            for (let i = 0; i < ids.length; i++) stmt.run(i, ids[i])
        })
        runAll()
        return { success: true }
    })

    // PUT /api/memory-spaces/:id — update name/description/relativePath
    app.put<{ Params: { id: string }; Body: { name?: string; description?: string; relativePath?: string } }>('/:id', async (req, reply) => {
        const db = getDb()
        syncMemorySpacesFromFolders(db)
        const spaceId = decodeSpaceIdParam(req.params.id)
        const row = db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(spaceId) as MemorySpaceRow | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })

        const name = req.body.name?.trim() || row.name
        const description = req.body.description !== undefined ? req.body.description : row.description
        let folderPath = row.folder_path
        let nextName = name

        if (row.is_default === 1 && req.body.relativePath !== undefined && validateRelativePath(req.body.relativePath) !== '') {
            return reply.status(400).send({ error: 'Cannot move the default memory folder.' })
        }

        if (row.is_default === 0) {
            const currentRelativePath = relativePathForFolder(row.folder_path)
            const requestedRelativePath = req.body.relativePath !== undefined
                ? req.body.relativePath
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
                    const oldFolderPath = row.folder_path
                    const descendants = db.prepare('SELECT * FROM memory_spaces WHERE id != ? AND folder_path LIKE ?').all(row.id, `${oldFolderPath}${oldFolderPath.endsWith(sep) ? '' : sep}%`) as MemorySpaceRow[]
                    const renamed = renameMemorySpaceFolder(row, nextRelativePath)
                    folderPath = renamed.folder_path
                    nextName = renamed.name
                    for (const child of descendants) {
                        const childFolderPath = `${folderPath}${child.folder_path.slice(oldFolderPath.length)}`
                        db.prepare('UPDATE memory_spaces SET folder_path = ? WHERE id = ?').run(childFolderPath, child.id)
                        watchMemorySpace(child.id, childFolderPath)
                    }
                } catch (err) {
                    return reply.status(409).send({ error: (err as Error).message })
                }
            }
        }

        db.prepare('UPDATE memory_spaces SET name = ?, description = ?, folder_path = ? WHERE id = ?').run(nextName, description, folderPath, row.id)
        watchMemorySpace(row.id, folderPath)
        const files = listFilesInFolder(folderPath).filter(f => f.supported)
        return rowToData({ ...row, name: nextName, description, folder_path: folderPath }, files.length)
    })

    // DELETE /api/memory-spaces/:id — archive folder + delete vectors/index
    app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
        const db = getDb()
        syncMemorySpacesFromFolders(db)
        const spaceId = decodeSpaceIdParam(req.params.id)
        const row = db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(spaceId) as MemorySpaceRow | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        if (row.is_default) {
            return reply.status(400).send({ error: 'Cannot delete the default memory folder.' })
        }
        const rag = getRAGStore()
        const relativePath = relativePathForFolder(row.folder_path)
        const descendants = db.prepare('SELECT * FROM memory_spaces WHERE id != ? AND folder_path LIKE ?').all(row.id, `${row.folder_path}${row.folder_path.endsWith(sep) ? '' : sep}%`) as MemorySpaceRow[]
        const rowsToDelete = [row, ...descendants]
        for (const target of rowsToDelete) {
            await rag.deleteByFilter('permanent_memory', lanceDbEqFilter('spaceId', target.id))
            stopWatchingMemorySpace(target.id)
        }
        archiveMemorySpaceFolder(row)
        const deleteRows = db.transaction(() => {
            for (const target of rowsToDelete) {
                db.prepare('DELETE FROM memory_file_index WHERE space_id = ?').run(target.id)
                db.prepare('DELETE FROM agent_memory_spaces WHERE space_id = ?').run(target.id)
                db.prepare('DELETE FROM memory_spaces WHERE id = ?').run(target.id)
            }
        })
        deleteRows()
        return { success: true, archived: relativePath }
    })

    // -----------------------------------------------------------------------
    // File browser
    // -----------------------------------------------------------------------

    // GET /api/memory-spaces/:id/jobs — list recent indexing jobs for a space
    app.get<{ Params: { id: string } }>('/:id/jobs', async (req, reply) => {
        const row = loadSpaceRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        return listMemoryIndexJobs(row.id)
    })

    // GET /api/memory-spaces/:id/files — list files in folder with index status
    app.get<{ Params: { id: string } }>('/:id/files', async (req, reply) => {
        const row = loadSpaceRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        if (!row.folder_path) return reply.status(400).send({ error: 'Space has no folder configured' })

        const mem = getAgentMemory()
        const fileIndex = mem.getFileIndex(row.id)
        const filesOnDisk = listFilesInFolder(row.folder_path)

        const result: MemoryFileStatus[] = filesOnDisk.map(f => {
            if (!f.supported) {
                return {
                    fileName: f.fileName,
                    extension: f.extension,
                    size: f.size,
                    modifiedAt: f.modifiedAt,
                    supported: false,
                    textDirect: false,
                    status: 'unsupported' as const,
                    entityIndexed: false,
                }
            }
            const indexed = fileIndex.get(f.fileName)
            if (!indexed) {
                return {
                    fileName: f.fileName,
                    extension: f.extension,
                    size: f.size,
                    modifiedAt: f.modifiedAt,
                    supported: true,
                    textDirect: f.textDirect,
                    status: 'not_indexed' as const,
                    entityIndexed: false,
                }
            }
            const currentHash = computeFileHash(f.filePath)
            const status = currentHash === indexed.contentHash ? 'indexed' as const : 'needs_reindex' as const
            return {
                fileName: f.fileName,
                extension: f.extension,
                size: f.size,
                modifiedAt: f.modifiedAt,
                supported: true,
                textDirect: f.textDirect,
                status,
                chunkCount: indexed.chunkCount,
                lastIndexedAt: indexed.lastIndexedAt,
                entityIndexed: status === 'indexed' && indexed.entityIndexedAt > 0,
                entityIndexedAt: indexed.entityIndexedAt || undefined,
            }
        })

        return result.sort((a, b) => b.modifiedAt - a.modifiedAt || a.fileName.localeCompare(b.fileName))
    })

    // POST /api/memory-spaces/:id/files/:fileName/reindex — re-index a specific file
    app.post<{ Params: { id: string; fileName: string } }>('/:id/files/:fileName/reindex', async (req, reply) => {
        const row = loadSpaceRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        if (!row.folder_path) return reply.status(400).send({ error: 'Space has no folder configured' })

        const mem = getAgentMemory()
        try {
            const result = await mem.reindexFile(row.folder_path, req.params.fileName, row.id)
            return { success: true, chunkCount: result.chunkCount, fileName: result.fileName }
        } catch (err) {
            return reply.status(500).send({ error: (err as Error).message || 'Failed to reindex file' })
        }
    })

    // POST /api/memory-spaces/:id/files/:fileName/reindex-job — start a background re-index job
    app.post<{ Params: { id: string; fileName: string } }>('/:id/files/:fileName/reindex-job', async (req, reply) => {
        const row = loadSpaceRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        if (!row.folder_path) return reply.status(400).send({ error: 'Space has no folder configured' })

        const mem = getAgentMemory()
        return startMemoryIndexJob({
            kind: 'reindex',
            spaceId: row.id,
            fileName: req.params.fileName,
            run: async (signal) => {
                const result = await mem.reindexFile(row.folder_path, req.params.fileName, row.id, { signal })
                return { success: true, chunksStored: result.chunkCount, fileName: result.fileName }
            },
        })
    })

    // POST /api/memory-spaces/:id/files/:fileName/entity-index — integrate one indexed document into the entity graph
    app.post<{ Params: { id: string; fileName: string } }>('/:id/files/:fileName/entity-index', async (req, reply) => {
        const row = loadSpaceRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        if (!row.folder_path) return reply.status(400).send({ error: 'Space has no folder configured' })

        const mem = getAgentMemory()
        const status = mem.checkFileStatus(row.id, req.params.fileName, row.folder_path)
        if (status !== 'current') {
            return reply.status(409).send({ error: status === 'not_indexed' ? 'File must be indexed before entity indexing.' : 'File must be re-indexed before entity indexing.' })
        }

        try {
            return {
                success: true,
                ...(await indexMemoryFileIntoEntityGraph({
                    folderPath: row.folder_path,
                    spaceId: row.id,
                    fileName: req.params.fileName,
                    replaceExisting: true,
                })),
            }
        } catch (err) {
            return reply.status(500).send({ error: (err as Error).message || 'Failed to entity-index file' })
        }
    })

    // POST /api/memory-spaces/:id/files/:fileName/entity-index-job — start a background entity graph indexing job
    app.post<{ Params: { id: string; fileName: string } }>('/:id/files/:fileName/entity-index-job', async (req, reply) => {
        const row = loadSpaceRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        if (!row.folder_path) return reply.status(400).send({ error: 'Space has no folder configured' })

        const mem = getAgentMemory()
        const status = mem.checkFileStatus(row.id, req.params.fileName, row.folder_path)
        if (status !== 'current') {
            return reply.status(409).send({ error: status === 'not_indexed' ? 'File must be indexed before entity indexing.' : 'File must be re-indexed before entity indexing.' })
        }

        return startMemoryIndexJob({
            kind: 'entity-index',
            spaceId: row.id,
            fileName: req.params.fileName,
            run: async (signal) => ({
                success: true,
                ...(await indexMemoryFileIntoEntityGraph({
                    folderPath: row.folder_path,
                    spaceId: row.id,
                    fileName: req.params.fileName,
                    replaceExisting: true,
                    signal,
                })),
            }),
        })
    })

    // DELETE /api/memory-spaces/:id/files/:fileName — delete a file from the space
    app.delete<{ Params: { id: string; fileName: string } }>('/:id/files/:fileName', async (req, reply) => {
        const row = loadSpaceRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Space not found' })

        const mem = getAgentMemory()
        await mem.deleteSourceFile(req.params.fileName, row.id)
        deleteMemoryGraphSource(row.id, req.params.fileName)
        return { success: true }
    })

    // GET /api/memory-spaces/:id/files/:fileName/content — read editable file content
    app.get<{ Params: { id: string; fileName: string } }>('/:id/files/:fileName/content', async (req, reply) => {
        const row = loadSpaceRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        if (!row.folder_path) return reply.status(400).send({ error: 'Space has no folder configured' })

        let fileName: string
        try {
            fileName = validateEditableFileName(req.params.fileName)
        } catch (err) {
            return reply.status(400).send({ error: (err as Error).message })
        }

        try {
            return { fileName, content: readTextFile(row.folder_path, fileName) }
        } catch {
            return reply.status(404).send({ error: 'File not found' })
        }
    })

    // PUT /api/memory-spaces/:id/files/:fileName/content — update editable file content and refresh vectors
    app.put<{ Params: { id: string; fileName: string }; Body: { content: string } }>('/:id/files/:fileName/content', async (req, reply) => {
        const row = loadSpaceRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        if (!row.folder_path) return reply.status(400).send({ error: 'Space has no folder configured' })
        if (typeof req.body.content !== 'string') return reply.status(400).send({ error: 'content is required' })

        let fileName: string
        try {
            fileName = validateEditableFileName(req.params.fileName)
        } catch (err) {
            return reply.status(400).send({ error: (err as Error).message })
        }

        try {
            backupToRevisions(row.folder_path, fileName)
            writeTextFile(row.folder_path, fileName, req.body.content)
            deleteMemoryGraphSource(row.id, fileName)
            const result = await getAgentMemory().reindexFile(row.folder_path, fileName, row.id)
            return { success: true, fileName: result.fileName, chunksStored: result.chunkCount }
        } catch (err) {
            return reply.status(500).send({ error: (err as Error).message || 'Failed to update file' })
        }
    })

    // PUT /api/memory-spaces/:id/files/:fileName/name — rename an editable memory file
    app.put<{ Params: { id: string; fileName: string }; Body: { fileName?: string } }>('/:id/files/:fileName/name', async (req, reply) => {
        const row = loadSpaceRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        if (!row.folder_path) return reply.status(400).send({ error: 'Space has no folder configured' })

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

        const sourcePath = join(row.folder_path, currentFileName)
        const targetPath = join(row.folder_path, nextFileName)
        if (!existsSync(sourcePath)) return reply.status(404).send({ error: 'File not found' })
        if (existsSync(targetPath)) return reply.status(409).send({ error: 'A memory file with that name already exists' })

        try {
            renameSync(sourcePath, targetPath)
            cancelMemoryIndexJobsForFile(row.id, currentFileName)

            const rag = getRAGStore()
            const filter = andLanceDbFilters(
                lanceDbEqFilter('spaceId', row.id),
                lanceDbEqFilter('sourceFile', currentFileName),
            )
            if (filter) await rag.updateSourceFile('permanent_memory', filter, nextFileName)

            getDb().prepare('UPDATE memory_file_index SET file_name = ? WHERE space_id = ? AND file_name = ?')
                .run(nextFileName, row.id, currentFileName)
            moveMemoryGraphSource(row.id, currentFileName, row.id, nextFileName)

            return { success: true, fileName: nextFileName }
        } catch (err) {
            return reply.status(500).send({ error: (err as Error).message || 'Failed to rename file' })
        }
    })

    // -----------------------------------------------------------------------
    // Ingest / upload
    // -----------------------------------------------------------------------

    // POST /api/memory-spaces/:id/ingest-file — upload a document to a space without indexing it
    app.post<{ Params: { id: string }; Body: { fileName: string; content: string } }>('/:id/ingest-file', async (req, reply) => {
        const row = loadSpaceRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        const { fileName, content } = req.body
        if (!fileName || content == null) return reply.status(400).send({ error: 'fileName and content are required' })
        if (!row.folder_path) return reply.status(400).send({ error: 'Space has no folder configured' })

        try {
            ensureFolder(row.folder_path)
            const safeFileName = basename(fileName)
            if (!safeFileName) return reply.status(400).send({ error: 'Invalid fileName' })
            const uniqueName = resolveUniqueFileName(row.folder_path, safeFileName)
            const targetPath = join(row.folder_path, uniqueName)

            if (content.startsWith('data:')) {
                const base64 = content.split(',')[1]
                if (!base64) return reply.status(400).send({ error: 'Invalid file content' })
                writeFileSync(targetPath, Buffer.from(base64, 'base64'))
            } else {
                writeTextFile(row.folder_path, uniqueName, content)
            }

            const mem = getAgentMemory()
            const job = startMemoryIndexJob({
                kind: 'reindex',
                spaceId: row.id,
                fileName: uniqueName,
                run: async (signal) => {
                    const result = await mem.reindexFile(row.folder_path, uniqueName, row.id, { signal })
                    return { success: true, chunksStored: result.chunkCount, fileName: result.fileName }
                },
            })

            return { success: true, chunksStored: 0, fileName: uniqueName, job }
        } catch (err) {
            return reply.status(500).send({ error: (err as Error).message || 'Failed to ingest file' })
        }
    })

    // POST /api/memory-spaces/:id/reingest-file — re-index an existing file in the space
    app.post<{ Params: { id: string }; Body: { fileName?: string; sourceFile?: string } }>('/:id/reingest-file', async (req, reply) => {
        const row = loadSpaceRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        if (!row.folder_path) return reply.status(400).send({ error: 'Space has no folder configured' })
        const fileName = req.body.fileName || req.body.sourceFile
        if (!fileName) return reply.status(400).send({ error: 'fileName is required' })

        try {
            const mem = getAgentMemory()
            const result = await mem.reindexFile(row.folder_path, fileName, row.id)
            return { success: true, chunksStored: result.chunkCount, fileName: result.fileName }
        } catch (err) {
            return reply.status(500).send({ error: (err as Error).message || 'Failed to reingest file' })
        }
    })

    // -----------------------------------------------------------------------
    // Legacy: group/entries API (for backwards compat)
    // -----------------------------------------------------------------------

    // GET /api/memory-spaces/:id/groups — list documents in a space (from LanceDB index)
    app.get<{ Params: { id: string } }>('/:id/groups', async (req, reply) => {
        const db = getDb()
        syncMemorySpacesFromFolders(db)
        const spaceId = decodeSpaceIdParam(req.params.id)
        const row = db.prepare('SELECT id FROM memory_spaces WHERE id = ?').get(spaceId) as { id: string } | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        const mem = getAgentMemory()
        return mem.listSourceFiles(row.id)
    })

    // GET /api/memory-spaces/:id/entries — list entries in a space (optionally by fileName)
    app.get<{ Params: { id: string }; Querystring: { sourceFile?: string } }>('/:id/entries', async (req, reply) => {
        const db = getDb()
        syncMemorySpacesFromFolders(db)
        const spaceId = decodeSpaceIdParam(req.params.id)
        const row = db.prepare('SELECT id FROM memory_spaces WHERE id = ?').get(spaceId) as { id: string } | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        const rag = getRAGStore()
        let filter = lanceDbEqFilter('spaceId', row.id)
        if (req.query.sourceFile) {
            filter = andLanceDbFilters(filter, lanceDbEqFilter('sourceFile', req.query.sourceFile)) || filter
        }
        return rag.listDocuments('permanent_memory', filter)
    })

    // PUT /api/memory-spaces/:id/entries/:entryId — legacy vector-only edits are disabled.
    // Memory files are the source of truth; updates must go through file-backed writes.
    app.put<{ Params: { id: string; entryId: string }; Body: { text: string } }>('/:id/entries/:entryId', async (req, reply) => {
        return reply.status(409).send({
            error: 'Chunk-level vector edits are disabled because memory files are the source of truth. Edit the Markdown file and reindex it instead.',
        })
    })

    // POST /api/memory-spaces/:id/delete-groups — delete files from a space
    app.post<{ Params: { id: string }; Body: { sourceFiles: string[] } }>('/:id/delete-groups', async (req, reply) => {
        const row = loadSpaceRow(req.params.id)
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        const { sourceFiles } = req.body
        if (!sourceFiles?.length) return reply.status(400).send({ error: 'No sourceFiles provided' })
        const mem = getAgentMemory()
        for (const sf of sourceFiles) {
            await mem.deleteSourceFile(sf, row.id)
            deleteMemoryGraphSource(row.id, sf)
        }
        return { success: true }
    })

    // POST /api/memory-spaces/:id/move-groups — move files to another space
    app.post<{ Params: { id: string }; Body: { sourceFiles: string[]; targetSpaceId: string } }>('/:id/move-groups', async (req, reply) => {
        const db = getDb()
        syncMemorySpacesFromFolders(db)
        const spaceId = decodeSpaceIdParam(req.params.id)
        const source = db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(spaceId) as MemorySpaceRow | undefined
        if (!source) return reply.status(404).send({ error: 'Source space not found' })
        const { sourceFiles, targetSpaceId } = req.body
        if (!sourceFiles?.length) return reply.status(400).send({ error: 'No sourceFiles provided' })
        if (!targetSpaceId) return reply.status(400).send({ error: 'targetSpaceId is required' })
        if (targetSpaceId === source.id) return reply.status(400).send({ error: 'Target space must be different from source' })

        const target = db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(targetSpaceId) as MemorySpaceRow | undefined
        if (!target) return reply.status(404).send({ error: 'Target space not found' })

        const rag = getRAGStore()
        const mem = getAgentMemory()
        let renamedCount = 0

        for (const sf of sourceFiles) {
            const uniqueName = await mem.resolveUniqueSourceFile(sf, target.id)
            if (uniqueName !== sf) renamedCount++
            const existingIndex = db.prepare('SELECT content_hash, chunk_count, last_indexed_at, entity_indexed_at, created_at FROM memory_file_index WHERE space_id = ? AND file_name = ?')
                .get(source.id, sf) as { content_hash: string; chunk_count: number; last_indexed_at: number; entity_indexed_at: number; created_at: number } | undefined

            // Move physical file if both spaces have folders
            if (source.folder_path && target.folder_path) {
                try {
                    copyFileToFolder(join(source.folder_path, sf), target.folder_path, uniqueName)
                    deletePhysicalFile(source.folder_path, sf)
                } catch { /* file may not exist on disk */ }
            }

            // Update LanceDB sourceFile name if renamed
            if (uniqueName !== sf) {
                const srcFilter = andLanceDbFilters(
                    lanceDbEqFilter('spaceId', source.id),
                    lanceDbEqFilter('sourceFile', sf),
                )
                if (srcFilter) await rag.updateSourceFile('permanent_memory', srcFilter, uniqueName)
            }

            // Move vectors to target space
            const filter = andLanceDbFilters(
                lanceDbEqFilter('spaceId', source.id),
                lanceDbEqFilter('sourceFile', uniqueName),
            )
            if (!filter) continue
            await rag.updateSpaceId('permanent_memory', filter, target.id)

            // Move file index entry
            if (existingIndex) {
                db.prepare('DELETE FROM memory_file_index WHERE space_id = ? AND file_name = ?').run(source.id, sf)
                db.prepare(`
                    INSERT OR REPLACE INTO memory_file_index (space_id, file_name, content_hash, chunk_count, last_indexed_at, entity_indexed_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(
                    target.id,
                    uniqueName,
                    existingIndex.content_hash,
                    existingIndex.chunk_count,
                    existingIndex.last_indexed_at,
                    existingIndex.entity_indexed_at,
                    existingIndex.created_at,
                )
            }
            moveMemoryGraphSource(source.id, sf, target.id, uniqueName)
        }

        return { success: true, moved: sourceFiles.length, renamed: renamedCount }
    })
}
