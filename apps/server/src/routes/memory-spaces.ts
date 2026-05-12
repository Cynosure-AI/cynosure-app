import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getAgentMemory } from '../core/memory/agent-memory.js'
import { getRAGStore } from '../core/memory/rag.js'
import { isParseableDocument, parseDocument } from '../core/utils/document-parser.js'
import {
    ensureFolder,
    listFilesInFolder,
    computeFileHash,
    copyFileToFolder,
    deleteFile as deletePhysicalFile,
} from '../core/memory/memory-file-manager.js'
import { getMemorySpacesRootDir } from '../core/data-dir.js'
import { nanoid } from 'nanoid'
import { join } from 'path'
import { watchMemorySpace, stopWatchingMemorySpace } from '../core/memory/memory-space-watcher.js'

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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToData(row: MemorySpaceRow, fileCount: number): MemorySpaceData {
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        folderPath: row.folder_path,
        sortOrder: row.sort_order,
        isDefault: row.is_default === 1,
        createdAt: row.created_at,
        fileCount,
    }
}

function defaultFolderForNewSpace(id: string): string {
    return join(getMemorySpacesRootDir(), id)
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registerMemorySpacesRoutes(app: FastifyInstance): Promise<void> {

    // GET /api/memory-spaces — list all spaces with file counts
    app.get('/', async () => {
        const db = getDb()
        const rows = db.prepare('SELECT * FROM memory_spaces ORDER BY sort_order ASC, created_at DESC').all() as MemorySpaceRow[]
        return rows.map(row => {
            const files = listFilesInFolder(row.folder_path).filter(f => f.supported)
            return rowToData(row, files.length)
        })
    })

    // POST /api/memory-spaces — create a space
    app.post<{ Body: { name: string; description?: string; folderPath?: string } }>('/', async (req, reply) => {
        const { name, description, folderPath } = req.body
        if (!name?.trim()) return reply.status(400).send({ error: 'name is required' })
        const trimmedName = name.trim()
        const db = getDb()
        const id = nanoid()
        const now = Date.now()
        const resolvedFolder = (folderPath?.trim()) || defaultFolderForNewSpace(id)
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

    // PUT /api/memory-spaces/:id — update name/description/folderPath
    app.put<{ Params: { id: string }; Body: { name?: string; description?: string; folderPath?: string } }>('/:id', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(req.params.id) as MemorySpaceRow | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })

        const name = req.body.name?.trim() || row.name
        const description = req.body.description !== undefined ? req.body.description : row.description
        let folderPath = row.folder_path

        if (req.body.folderPath?.trim() && req.body.folderPath.trim() !== row.folder_path) {
            if (row.is_default) return reply.status(400).send({ error: 'Cannot change the folder of the default memory space.' })
            folderPath = req.body.folderPath.trim()
            ensureFolder(folderPath)
        }

        db.prepare('UPDATE memory_spaces SET name = ?, description = ?, folder_path = ? WHERE id = ?').run(name, description, folderPath, row.id)
        watchMemorySpace(row.id, folderPath)
        const files = listFilesInFolder(folderPath).filter(f => f.supported)
        return rowToData({ ...row, name, description, folder_path: folderPath }, files.length)
    })

    // DELETE /api/memory-spaces/:id — delete space + vectors (files kept on disk)
    app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT id, is_default FROM memory_spaces WHERE id = ?').get(req.params.id) as { id: string; is_default: number } | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        if (row.is_default) {
            return reply.status(400).send({ error: 'Cannot delete the default memory space. It is always available as a fallback for agents without explicit space assignments.' })
        }
        const rag = getRAGStore()
        await rag.deleteByFilter('permanent_memory', `spaceId = '${row.id.replace(/'/g, "''")}'`)
        db.prepare('DELETE FROM memory_file_index WHERE space_id = ?').run(row.id)
        db.prepare('DELETE FROM agent_memory_spaces WHERE space_id = ?').run(row.id)
        db.prepare('DELETE FROM memory_spaces WHERE id = ?').run(row.id)
        stopWatchingMemorySpace(row.id)
        return { success: true }
    })

    // -----------------------------------------------------------------------
    // File browser
    // -----------------------------------------------------------------------

    // GET /api/memory-spaces/:id/files — list files in folder with index status
    app.get<{ Params: { id: string } }>('/:id/files', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(req.params.id) as MemorySpaceRow | undefined
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
            }
        })

        return result
    })

    // POST /api/memory-spaces/:id/files/:fileName/reindex — re-index a specific file
    app.post<{ Params: { id: string; fileName: string } }>('/:id/files/:fileName/reindex', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(req.params.id) as MemorySpaceRow | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        if (!row.folder_path) return reply.status(400).send({ error: 'Space has no folder configured' })

        const mem = getAgentMemory()
        try {
            const count = await mem.reindexFile(row.folder_path, req.params.fileName, row.id)
            return { success: true, chunkCount: count }
        } catch (err) {
            return reply.status(500).send({ error: (err as Error).message || 'Failed to reindex file' })
        }
    })

    // DELETE /api/memory-spaces/:id/files/:fileName — delete a file from the space
    app.delete<{ Params: { id: string; fileName: string } }>('/:id/files/:fileName', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(req.params.id) as MemorySpaceRow | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })

        const mem = getAgentMemory()
        await mem.deleteSourceFile(req.params.fileName, row.id)
        return { success: true }
    })

    // -----------------------------------------------------------------------
    // Ingest / upload
    // -----------------------------------------------------------------------

    // POST /api/memory-spaces/:id/ingest-file — upload a document to a space
    app.post<{ Params: { id: string }; Body: { fileName: string; content: string } }>('/:id/ingest-file', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(req.params.id) as MemorySpaceRow | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        const { fileName, content } = req.body
        if (!fileName || !content) return reply.status(400).send({ error: 'fileName and content are required' })
        if (!row.folder_path) return reply.status(400).send({ error: 'Space has no folder configured' })

        try {
            const mem = getAgentMemory()
            let textContent = content

            if (isParseableDocument(fileName) && content.startsWith('data:')) {
                const base64 = content.split(',')[1]
                if (base64) {
                    const buf = Buffer.from(base64, 'base64')
                    textContent = await parseDocument(buf, fileName)
                }
            }

            const result = await mem.ingestExternalFile(textContent, fileName, row.id, row.folder_path)
            return { success: true, chunksStored: result.chunkCount, fileName: result.fileName }
        } catch (err) {
            return reply.status(500).send({ error: (err as Error).message || 'Failed to ingest file' })
        }
    })

    // POST /api/memory-spaces/:id/reingest-file — re-index an existing file in the space
    app.post<{ Params: { id: string }; Body: { fileName?: string; sourceFile?: string } }>('/:id/reingest-file', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(req.params.id) as MemorySpaceRow | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        if (!row.folder_path) return reply.status(400).send({ error: 'Space has no folder configured' })
        const fileName = req.body.fileName || req.body.sourceFile
        if (!fileName) return reply.status(400).send({ error: 'fileName is required' })

        try {
            const mem = getAgentMemory()
            const count = await mem.reindexFile(row.folder_path, fileName, row.id)
            return { success: true, chunksStored: count, fileName }
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
        const row = db.prepare('SELECT id FROM memory_spaces WHERE id = ?').get(req.params.id) as { id: string } | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        const mem = getAgentMemory()
        return mem.listSourceFiles(row.id)
    })

    // GET /api/memory-spaces/:id/entries — list entries in a space (optionally by fileName)
    app.get<{ Params: { id: string }; Querystring: { sourceFile?: string } }>('/:id/entries', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT id FROM memory_spaces WHERE id = ?').get(req.params.id) as { id: string } | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        const rag = getRAGStore()
        let filter = `spaceId = '${row.id.replace(/'/g, "''")}'`
        if (req.query.sourceFile) {
            filter += ` AND sourceFile = '${req.query.sourceFile.replace(/'/g, "''")}'`
        }
        return rag.listDocuments('permanent_memory', filter)
    })

    // PUT /api/memory-spaces/:id/entries/:entryId — update a single chunk's text and re-embed
    app.put<{ Params: { id: string; entryId: string }; Body: { text: string } }>('/:id/entries/:entryId', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT id FROM memory_spaces WHERE id = ?').get(req.params.id) as { id: string } | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        const { text } = req.body
        if (typeof text !== 'string' || !text.trim()) return reply.status(400).send({ error: 'text is required' })
        try {
            const mem = getAgentMemory()
            await mem.updateChunk(req.params.entryId, text.trim())
            return { success: true }
        } catch (err) {
            return reply.status(500).send({ error: (err as Error).message || 'Failed to update chunk' })
        }
    })

    // POST /api/memory-spaces/:id/delete-groups — delete files from a space
    app.post<{ Params: { id: string }; Body: { sourceFiles: string[] } }>('/:id/delete-groups', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(req.params.id) as MemorySpaceRow | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        const { sourceFiles } = req.body
        if (!sourceFiles?.length) return reply.status(400).send({ error: 'No sourceFiles provided' })
        const mem = getAgentMemory()
        for (const sf of sourceFiles) {
            await mem.deleteSourceFile(sf, row.id)
        }
        return { success: true }
    })

    // POST /api/memory-spaces/:id/move-groups — move files to another space
    app.post<{ Params: { id: string }; Body: { sourceFiles: string[]; targetSpaceId: string } }>('/:id/move-groups', async (req, reply) => {
        const db = getDb()
        const source = db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(req.params.id) as MemorySpaceRow | undefined
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

            // Move physical file if both spaces have folders
            if (source.folder_path && target.folder_path) {
                try {
                    copyFileToFolder(join(source.folder_path, sf), target.folder_path, uniqueName)
                    deletePhysicalFile(source.folder_path, sf)
                } catch { /* file may not exist on disk */ }
            }

            // Update LanceDB sourceFile name if renamed
            if (uniqueName !== sf) {
                const srcFilter = `spaceId = '${source.id.replace(/'/g, "''")}' AND sourceFile = '${sf.replace(/'/g, "''")}'`
                await rag.updateSourceFile('permanent_memory', srcFilter, uniqueName)
            }

            // Move vectors to target space
            const filter = `spaceId = '${source.id.replace(/'/g, "''")}' AND sourceFile = '${sf.replace(/'/g, "''")}'`
            await rag.updateSpaceId('permanent_memory', filter, target.id)

            // Move file index entry
            db.prepare('DELETE FROM memory_file_index WHERE space_id = ? AND file_name = ?').run(source.id, sf)
            const now = Date.now()
            db.prepare(`
                INSERT OR REPLACE INTO memory_file_index (space_id, file_name, content_hash, chunk_count, last_indexed_at, created_at)
                VALUES (?, ?, '', 0, 0, ?)
            `).run(target.id, uniqueName, now)
        }

        return { success: true, moved: sourceFiles.length, renamed: renamedCount }
    })
}
