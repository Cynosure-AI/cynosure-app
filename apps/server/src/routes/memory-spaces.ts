import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/database.js'
import { getAgentMemory } from '../core/memory/agent-memory.js'
import { getRAGStore } from '../core/memory/rag.js'
import { isParseableDocument, parseDocument } from '../core/utils/document-parser.js'
import { nanoid } from 'nanoid'

interface MemorySpaceRow {
    id: string
    name: string
    description: string
    sort_order: number
    is_default: number
    created_at: number
}

interface MemorySpaceData {
    id: string
    name: string
    description: string
    sortOrder: number
    isDefault: boolean
    createdAt: number
    documentCount: number
}

function rowToData(row: MemorySpaceRow, documentCount: number): MemorySpaceData {
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        sortOrder: row.sort_order,
        isDefault: row.is_default === 1,
        createdAt: row.created_at,
        documentCount,
    }
}

export async function registerMemorySpacesRoutes(app: FastifyInstance): Promise<void> {
    // GET /api/memory-spaces — list all spaces with document counts
    app.get('/', async () => {
        const db = getDb()
        const rows = db.prepare('SELECT * FROM memory_spaces ORDER BY sort_order ASC, created_at DESC').all() as MemorySpaceRow[]
        const mem = getAgentMemory()
        const results: MemorySpaceData[] = []
        for (const row of rows) {
            const docs = await mem.listSourceFiles(row.id)
            results.push(rowToData(row, docs.length))
        }
        return results
    })

    // POST /api/memory-spaces — create a space
    app.post<{ Body: { name: string; description?: string } }>('/', async (req, reply) => {
        const { name, description } = req.body
        if (!name?.trim()) return reply.status(400).send({ error: 'name is required' })
        const db = getDb()
        const id = nanoid()
        const now = Date.now()
        db.prepare('INSERT INTO memory_spaces (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(id, name.trim(), description || '', now)
        return rowToData({ id, name: name.trim(), description: description || '', sort_order: 0, is_default: 0, created_at: now }, 0)
    })

    // PUT /api/memory-spaces/reorder — update sort order
    app.put<{ Body: { ids: string[] } }>('/reorder', async (req, reply) => {
        const { ids } = req.body
        if (!Array.isArray(ids)) return reply.status(400).send({ error: 'ids must be an array' })
        const db = getDb()
        const defaultRow = db.prepare('SELECT id FROM memory_spaces WHERE is_default = 1 ORDER BY created_at ASC LIMIT 1').get() as { id: string } | undefined
        const orderedIds = defaultRow
            ? [defaultRow.id, ...ids.filter(id => id !== defaultRow.id)]
            : ids

        const stmt = db.prepare('UPDATE memory_spaces SET sort_order = ? WHERE id = ?')
        const runAll = db.transaction(() => {
            for (let i = 0; i < orderedIds.length; i++) {
                stmt.run(i, orderedIds[i])
            }
        })
        runAll()
        return { success: true }
    })

    // PUT /api/memory-spaces/:id — update name/description
    app.put<{ Params: { id: string }; Body: { name?: string; description?: string } }>('/:id', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(req.params.id) as MemorySpaceRow | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        const name = req.body.name?.trim() || row.name
        const description = req.body.description !== undefined ? req.body.description : row.description
        db.prepare('UPDATE memory_spaces SET name = ?, description = ? WHERE id = ?').run(name, description, row.id)
        const mem = getAgentMemory()
        const docs = await mem.listSourceFiles(row.id)
        return rowToData({ ...row, name, description }, docs.length)
    })

    // DELETE /api/memory-spaces/:id — delete space + all its documents
    app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT id, is_default FROM memory_spaces WHERE id = ?').get(req.params.id) as { id: string; is_default: number } | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })

        // Prevent deletion of default memory space
        if (row.is_default) {
            return reply.status(400).send({ error: 'Cannot delete the default memory space. It is always available as a fallback for agents without explicit space assignments.' })
        }

        // Delete all documents in this space from LanceDB
        const rag = getRAGStore()
        await rag.deleteByFilter('permanent_memory', `spaceId = '${row.id.replace(/'/g, "''")}'`)
        // Remove join table references + space itself
        db.prepare('DELETE FROM agent_memory_spaces WHERE space_id = ?').run(row.id)
        db.prepare('DELETE FROM memory_spaces WHERE id = ?').run(row.id)
        return { success: true }
    })

    // GET /api/memory-spaces/:id/groups — list documents in a space
    app.get<{ Params: { id: string } }>('/:id/groups', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT id FROM memory_spaces WHERE id = ?').get(req.params.id) as { id: string } | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        const mem = getAgentMemory()
        return mem.listSourceFiles(row.id)
    })

    // GET /api/memory-spaces/:id/entries — list entries in a space (optionally by sourceFile)
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

    // POST /api/memory-spaces/:id/ingest-file — upload a document to a space
    app.post<{ Params: { id: string }; Body: { fileName: string; content: string } }>('/:id/ingest-file', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT id FROM memory_spaces WHERE id = ?').get(req.params.id) as { id: string } | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        const { fileName, content } = req.body
        if (!fileName || !content) return reply.status(400).send({ error: 'fileName and content are required' })
        try {
            const mem = getAgentMemory()
            let textContent = content
            // Parse document files (docx, pdf, xlsx, etc.) from base64 data URLs
            if (isParseableDocument(fileName) && content.startsWith('data:')) {
                const base64 = content.split(',')[1]
                if (base64) {
                    const buf = Buffer.from(base64, 'base64')
                    textContent = await parseDocument(buf, fileName)
                }
            }
            const uniqueName = await mem.resolveUniqueSourceFile(fileName, row.id)
            const count = await mem.store(textContent, uniqueName, row.id)
            return { success: true, chunksStored: count, fileName: uniqueName }
        } catch (err) {
            const message = (err as Error).message || 'Failed to ingest file'
            return reply.status(500).send({ error: message })
        }
    })

    // POST /api/memory-spaces/:id/reingest-file — re-ingest a document in a space
    app.post<{ Params: { id: string }; Body: { sourceFile: string; content: string } }>('/:id/reingest-file', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT id FROM memory_spaces WHERE id = ?').get(req.params.id) as { id: string } | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        const { sourceFile, content } = req.body
        if (!sourceFile || !content) return reply.status(400).send({ error: 'sourceFile and content are required' })
        try {
            const rag = getRAGStore()
            const mem = getAgentMemory()
            let textContent = content
            // Parse document files (docx, pdf, xlsx, etc.) from base64 data URLs
            if (isParseableDocument(sourceFile) && content.startsWith('data:')) {
                const base64 = content.split(',')[1]
                if (base64) {
                    const buf = Buffer.from(base64, 'base64')
                    textContent = await parseDocument(buf, sourceFile)
                }
            }
            await rag.deleteBySource('permanent_memory', sourceFile, `spaceId = '${row.id.replace(/'/g, "''")}'`)
            const count = await mem.store(textContent, sourceFile, row.id)
            return { success: true, chunksStored: count, fileName: sourceFile }
        } catch (err) {
            const message = (err as Error).message || 'Failed to reingest file'
            return reply.status(500).send({ error: message })
        }
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
            const message = (err as Error).message || 'Failed to update chunk'
            return reply.status(500).send({ error: message })
        }
    })

    // POST /api/memory-spaces/:id/delete-groups — delete documents from a space
    app.post<{ Params: { id: string }; Body: { sourceFiles: string[] } }>('/:id/delete-groups', async (req, reply) => {
        const db = getDb()
        const row = db.prepare('SELECT id FROM memory_spaces WHERE id = ?').get(req.params.id) as { id: string } | undefined
        if (!row) return reply.status(404).send({ error: 'Space not found' })
        const { sourceFiles } = req.body
        if (!sourceFiles?.length) return reply.status(400).send({ error: 'No sourceFiles provided' })
        const rag = getRAGStore()
        const spaceFilter = `spaceId = '${row.id.replace(/'/g, "''")}'`
        await rag.deleteBySources('permanent_memory', sourceFiles, spaceFilter)
        return { success: true }
    })

    // POST /api/memory-spaces/:id/move-groups — move documents to another space
    app.post<{ Params: { id: string }; Body: { sourceFiles: string[]; targetSpaceId: string } }>('/:id/move-groups', async (req, reply) => {
        const db = getDb()
        const source = db.prepare('SELECT id FROM memory_spaces WHERE id = ?').get(req.params.id) as { id: string } | undefined
        if (!source) return reply.status(404).send({ error: 'Source space not found' })
        const { sourceFiles, targetSpaceId } = req.body
        if (!sourceFiles?.length) return reply.status(400).send({ error: 'No sourceFiles provided' })
        if (!targetSpaceId) return reply.status(400).send({ error: 'targetSpaceId is required' })
        if (targetSpaceId === source.id) return reply.status(400).send({ error: 'Target space must be different from source' })
        const target = db.prepare('SELECT id FROM memory_spaces WHERE id = ?').get(targetSpaceId) as { id: string } | undefined
        if (!target) return reply.status(404).send({ error: 'Target space not found' })

        const rag = getRAGStore()
        const escaped = sourceFiles.map(sf => `'${sf.replace(/'/g, "''")}'`).join(', ')
        const filter = `spaceId = '${source.id.replace(/'/g, "''")}' AND sourceFile IN (${escaped})`
        await rag.updateSpaceId('permanent_memory', filter, target.id)
        return { success: true, moved: sourceFiles.length }
    })
}
