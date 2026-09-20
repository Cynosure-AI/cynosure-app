import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('deleted memory restore', () => {
  let dataDirectory = ''

  beforeEach(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'cynosure-memory-restore-'))
    process.env.CYNOSURE_DATA_DIR = dataDirectory
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    const { stopAllMemoryFolderWatchers } = await import('../../../src/core/memory/memory-folder-watcher.js')
    await stopAllMemoryFolderWatchers()
    const { closeDb } = await import('../../../src/db/database.js')
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    await rm(dataDirectory, { recursive: true, force: true })
  })

  test('restores a document to Uncategorized when its original folder was deleted', async () => {
    const { getDb } = await import('../../../src/db/database.js')
    const { getAgentMemory } = await import('../../../src/core/memory/agent-memory.js')
    const { recordMemoryRevision, markMemoryDocumentDeleted } = await import('../../../src/core/memory/memory-revisions.js')
    const { registerMemoryFoldersRoutes } = await import('../../../src/routes/memory-folders.js')
    const db = getDb()
    const content = '# Restored memory\nStill available.'
    const revision = recordMemoryRevision({
      documentId: 'deleted-document',
      documentRef: 'restored-memory#abc123',
      folderId: 'removed-folder',
      fileName: 'restored-memory.md',
      content,
      context: { source: 'user' },
    })
    markMemoryDocumentDeleted('deleted-document')
    vi.spyOn(getAgentMemory(), 'reindexFile').mockImplementation(async (_directoryPath, fileName, folderId) => {
      recordMemoryRevision({
        documentId: 'deleted-document',
        documentRef: 'restored-memory#abc123',
        folderId,
        fileName,
        content,
        context: { source: 'restore' },
      })
      return { fileName, chunkCount: 1 }
    })

    const app = Fastify()
    await app.register(registerMemoryFoldersRoutes, { prefix: '/api/memory-folders' })
    const response = await app.inject({
      method: 'POST',
      url: `/api/memory-folders/documents/${encodeURIComponent('restored-memory#abc123')}/revisions/${revision.id}/restore`,
      payload: { expectedRevision: '' },
    })

    expect(response.statusCode).toBe(200)
    expect(await readFile(join(dataDirectory, 'data', 'memories', 'restored-memory.md'), 'utf8')).toBe(content)
    expect(db.prepare('SELECT category_id, status FROM memory_documents WHERE document_id = ?').get('deleted-document'))
      .toEqual({ category_id: 'uncategorized', status: 'active' })
    expect(db.prepare('SELECT category_id FROM memory_file_index WHERE document_id = ?').get('deleted-document'))
      .toEqual({ category_id: 'uncategorized' })
    await app.close()
  })

  test('empties deleted history and physical memory trash permanently', async () => {
    const { getDb } = await import('../../../src/db/database.js')
    const { recordMemoryRevision, markMemoryDocumentDeleted } = await import('../../../src/core/memory/memory-revisions.js')
    const { registerMemoryFoldersRoutes } = await import('../../../src/routes/memory-folders.js')
    const db = getDb()
    recordMemoryRevision({
      documentId: 'deleted-document', documentRef: 'deleted#stable', folderId: 'uncategorized',
      fileName: 'deleted.md', content: 'Deleted', context: { source: 'user' },
    })
    markMemoryDocumentDeleted('deleted-document')
    const trashDirectory = join(dataDirectory, 'data', 'memories', '.trash')
    await mkdir(trashDirectory, { recursive: true })
    await writeFile(join(trashDirectory, 'deleted.md'), 'Deleted')

    const app = Fastify()
    await app.register(registerMemoryFoldersRoutes, { prefix: '/api/memory-folders' })
    const response = await app.inject({ method: 'DELETE', url: '/api/memory-folders/deleted' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true, deleted: 1 })
    expect(db.prepare('SELECT COUNT(*) FROM memory_documents').pluck().get()).toBe(0)
    await expect(access(trashDirectory)).rejects.toThrow()
    await app.close()
  })
})
