import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('global memory file search', () => {
  let dataDirectory = ''
  let firstFolder = ''
  let secondFolder = ''
  let childFolder = ''

  beforeEach(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'cynosure-memory-file-search-'))
    firstFolder = join(dataDirectory, 'memory-a')
    secondFolder = join(dataDirectory, 'memory-b')
    childFolder = join(firstFolder, 'child')
    await Promise.all([mkdir(childFolder, { recursive: true }), mkdir(secondFolder)])
    process.env.CYNOSURE_DATA_DIR = dataDirectory
  })

  afterEach(async () => {
    const { stopAllMemoryFolderWatchers } = await import('../../../src/core/memory/memory-folder-watcher.js')
    await stopAllMemoryFolderWatchers()
    const { closeDb } = await import('../../../src/db/database.js')
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    await rm(dataDirectory, { recursive: true, force: true })
  })

  test('finds files in every folder by filename and current chunk summary', async () => {
    const { getDb } = await import('../../../src/db/database.js')
    const { computeFileHash } = await import('../../../src/core/memory/memory-file-manager.js')
    const { MemoryKnowledgeStore } = await import('../../../src/core/memory/memory-knowledge.js')
    const { getAgentMemory } = await import('../../../src/core/memory/agent-memory.js')
    const { registerMemoryFoldersRoutes } = await import('../../../src/routes/memory-folders.js')
    await writeFile(join(firstFolder, 'alpha.md'), '# Alpha\nPlain source wording.')
    await writeFile(join(secondFolder, 'roadmap.md'), '# Roadmap\nMilestones.')
    await writeFile(join(childFolder, 'nested-plan.md'), '# Nested plan\nDelivery notes.')
    const db = getDb()
    const now = Date.now()
    db.prepare(`INSERT INTO memory_folders (id, name, description, directory_path, sort_order, created_at) VALUES (?, ?, '', ?, ?, ?)`)
      .run('folder-a', 'Archive', firstFolder, 1, now)
    db.prepare(`INSERT INTO memory_folders (id, name, description, directory_path, sort_order, created_at) VALUES (?, ?, '', ?, ?, ?)`)
      .run('folder-b', 'Projects', secondFolder, 2, now)
    db.prepare(`INSERT INTO memory_folders (id, name, description, directory_path, sort_order, created_at) VALUES (?, ?, '', ?, ?, ?)`)
      .run('folder-c', 'Child', childFolder, 3, now)
    const alphaHash = computeFileHash(join(firstFolder, 'alpha.md'))
    db.prepare(`INSERT INTO memory_file_index (document_id, document_ref, category_id, file_name, content_hash, chunk_count, last_indexed_at, deep_researched_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run('doc-alpha', 'ref-alpha', 'folder-a', 'alpha.md', alphaHash, now, now, now)
    new MemoryKnowledgeStore().publishDocument({
      documentId: 'doc-alpha', contentHash: alphaHash, folderId: 'folder-a', fileName: 'alpha.md',
      sourceId: 'memory:folder-a:alpha.md', relations: [],
      chunks: [{ text: 'Plain source wording.', searchText: 'Plain source wording.', chunkIndex: 0, documentTitle: 'Alpha', sectionPath: 'Alpha', contentHash: 'chunk-alpha' }],
      chunkTags: [{ sourceChunkIndex: 0, tags: ['architecture'] }],
      chunkSummaries: [{ sourceChunkIndex: 0, summary: 'The document explains a quasar indexing strategy.' }],
    })
    db.prepare(`UPDATE memory_file_index SET deep_researched_at = ? WHERE document_id = 'doc-alpha'`).run(Date.now() + 1)

    const app = Fastify()
    await app.register(registerMemoryFoldersRoutes, { prefix: '/api/memory-folders' })
    const summaryResponse = await app.inject({ method: 'GET', url: '/api/memory-folders/file-search?query=quasar' })
    expect(summaryResponse.statusCode).toBe(200)
    expect(summaryResponse.json()).toEqual([expect.objectContaining({ fileName: 'alpha.md', folderId: 'folder-a', matchedFields: ['summary'] })])

    const filenameResponse = await app.inject({ method: 'GET', url: '/api/memory-folders/file-search?query=roadmap' })
    expect(filenameResponse.json()).toEqual([expect.objectContaining({ fileName: 'roadmap.md', folderId: 'folder-b' })])

    const scopedMiss = await app.inject({ method: 'GET', url: '/api/memory-folders/file-search?query=roadmap&folderId=folder-a' })
    expect(scopedMiss.json()).toEqual([])
    const scopedMatch = await app.inject({ method: 'GET', url: '/api/memory-folders/file-search?query=roadmap&folderId=folder-b' })
    expect(scopedMatch.json()).toEqual([expect.objectContaining({ fileName: 'roadmap.md', folderId: 'folder-b' })])
    const recursiveMatch = await app.inject({ method: 'GET', url: '/api/memory-folders/file-search?query=nested-plan&folderId=folder-a' })
    expect(recursiveMatch.json()).toEqual([expect.objectContaining({ fileName: 'nested-plan.md', folderId: 'folder-c' })])

    const { getEmbeddingProvider } = await import('../../../src/core/memory/embedding.js')
    const { getRAGStore } = await import('../../../src/core/memory/rag.js')
    const embed = vi.spyOn(getEmbeddingProvider(), 'embed').mockResolvedValue({ vector: [1, 0], model: 'test', dimensions: 2 })
    const vectorSearch = vi.spyOn(getRAGStore(), 'search').mockResolvedValue([{
      id: 'chunk-alpha', text: 'Plain source wording.', source: 'memory', sourceFile: 'alpha.md',
      folderId: 'folder-a', chunkIndex: 0, score: 0.82, denseScore: 0.82, scoreType: 'dense', createdAt: now,
    }])
    const semanticResponse = await app.inject({
      method: 'GET',
      url: '/api/memory-folders/file-search?query=space%20architecture&folderId=folder-a&semantic=true',
    })
    expect(semanticResponse.statusCode).toBe(200)
    expect(semanticResponse.json()).toEqual([
      expect.objectContaining({ fileName: 'alpha.md', folderId: 'folder-a', matchedFields: ['content'], similarity: 0.82 }),
    ])
    expect(embed).toHaveBeenCalledWith('space architecture')
    expect(vectorSearch).toHaveBeenCalledWith(expect.any(String), [1, 0], 500, expect.stringContaining("'folder-a'"))
    embed.mockRestore()
    vectorSearch.mockRestore()

    const analysisResponse = await app.inject({ method: 'GET', url: '/api/memory-folders/folder-a/files/alpha.md/analysis' })
    expect(analysisResponse.json()).toEqual(expect.objectContaining({
      status: 'current',
      chunks: [expect.objectContaining({
        text: 'Plain source wording.',
        summary: 'The document explains a quasar indexing strategy.',
        tags: ['architecture'],
      })],
    }))

    const roadmapHash = computeFileHash(join(secondFolder, 'roadmap.md'))
    db.prepare(`INSERT INTO memory_file_index (document_id, document_ref, category_id, file_name, content_hash, chunk_count, last_indexed_at, created_at) VALUES (?, ?, ?, ?, ?, 2, ?, ?)`).run(
      'doc-roadmap', 'ref-roadmap', 'folder-b', 'roadmap.md', roadmapHash, now, now,
    )
    const chunksByRange = vi.spyOn(getAgentMemory(), 'getChunksByRange').mockResolvedValue([
      { text: '# Roadmap\nMilestones.', chunkIndex: 0, sourceFile: 'roadmap.md', folderId: 'folder-b' },
      { text: 'Delivery dates.', chunkIndex: 1, sourceFile: 'roadmap.md', folderId: 'folder-b' },
    ])
    const searchableResponse = await app.inject({ method: 'GET', url: '/api/memory-folders/folder-b/files/roadmap.md/analysis' })
    expect(searchableResponse.json()).toEqual({
      status: 'searchable',
      chunks: [
        { chunkIndex: 0, text: '# Roadmap\nMilestones.', sectionPath: '', summary: '', tags: [] },
        { chunkIndex: 1, text: 'Delivery dates.', sectionPath: '', summary: '', tags: [] },
      ],
      items: [],
      itemTotal: 0,
    })
    expect(chunksByRange).toHaveBeenCalledWith('roadmap.md', 0, 1, expect.stringContaining('folder-b'))
    chunksByRange.mockRestore()

    await writeFile(join(firstFolder, 'alpha.md'), '# Alpha\nChanged source wording.')
    const staleAnalysis = await app.inject({ method: 'GET', url: '/api/memory-folders/folder-a/files/alpha.md/analysis' })
    expect(staleAnalysis.json()).toEqual(expect.objectContaining({ status: 'needs_refresh' }))
    const staleSummarySearch = await app.inject({ method: 'GET', url: '/api/memory-folders/file-search?query=quasar' })
    expect(staleSummarySearch.json()).toEqual([])
    await app.close()
  })

  test('persists automatic-memory exclusion for a folder tree', async () => {
    const { getDb } = await import('../../../src/db/database.js')
    const { registerMemoryFoldersRoutes } = await import('../../../src/routes/memory-folders.js')
    const db = getDb()
    const now = Date.now()
    const projectsFolder = join(dataDirectory, 'data', 'memories', 'Projects')
    const projectsChildFolder = join(projectsFolder, 'Child')
    await mkdir(projectsChildFolder, { recursive: true })
    db.prepare(`INSERT INTO memory_folders (id, name, description, directory_path, sort_order, created_at) VALUES (?, ?, '', ?, ?, ?)`)
      .run('folder-a', 'Projects', projectsFolder, 1, now)
    db.prepare(`INSERT INTO memory_folders (id, name, description, directory_path, sort_order, created_at) VALUES (?, ?, '', ?, ?, ?)`)
      .run('folder-c', 'Child', projectsChildFolder, 2, now)

    const app = Fastify()
    await app.register(registerMemoryFoldersRoutes, { prefix: '/api/memory-folders' })
    const response = await app.inject({
      method: 'PUT',
      url: '/api/memory-folders/folder-a',
      payload: { autoMemoryExcluded: true },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: 'folder-a', autoMemoryExcluded: true })
    expect(db.prepare("SELECT auto_memory_excluded FROM memory_folders WHERE id = 'folder-c'").get())
      .toEqual({ auto_memory_excluded: 1 })
    const folders = (await app.inject('/api/memory-folders')).json() as Array<{ id: string; autoMemoryExcluded: boolean }>
    expect(folders.find((folder) => folder.id === 'folder-c')?.autoMemoryExcluded).toBe(true)
    await app.close()
  })
})
