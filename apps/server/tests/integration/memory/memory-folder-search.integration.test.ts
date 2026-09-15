import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('global memory file search', () => {
  let dataDirectory = ''
  let firstFolder = ''
  let secondFolder = ''

  beforeEach(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'cynosure-memory-file-search-'))
    firstFolder = join(dataDirectory, 'memory-a')
    secondFolder = join(dataDirectory, 'memory-b')
    await Promise.all([mkdir(firstFolder), mkdir(secondFolder)])
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
    const { registerMemoryFoldersRoutes } = await import('../../../src/routes/memory-folders.js')
    await writeFile(join(firstFolder, 'alpha.md'), '# Alpha\nPlain source wording.')
    await writeFile(join(secondFolder, 'roadmap.md'), '# Roadmap\nMilestones.')
    const db = getDb()
    const now = Date.now()
    db.prepare(`INSERT INTO memory_folders (id, name, description, directory_path, sort_order, created_at) VALUES (?, ?, '', ?, ?, ?)`)
      .run('folder-a', 'Archive', firstFolder, 1, now)
    db.prepare(`INSERT INTO memory_folders (id, name, description, directory_path, sort_order, created_at) VALUES (?, ?, '', ?, ?, ?)`)
      .run('folder-b', 'Projects', secondFolder, 2, now)
    const alphaHash = computeFileHash(join(firstFolder, 'alpha.md'))
    db.prepare(`INSERT INTO memory_file_index (document_id, document_ref, category_id, file_name, content_hash, chunk_count, last_indexed_at, deep_researched_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run('doc-alpha', 'ref-alpha', 'folder-a', 'alpha.md', alphaHash, now, now, now)
    new MemoryKnowledgeStore().publishDocument({
      documentId: 'doc-alpha', contentHash: alphaHash, categoryId: 'folder-a', fileName: 'alpha.md',
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
    expect(summaryResponse.json()).toEqual([expect.objectContaining({ fileName: 'alpha.md', categoryId: 'folder-a', matchedFields: ['summary'] })])

    const filenameResponse = await app.inject({ method: 'GET', url: '/api/memory-folders/file-search?query=roadmap' })
    expect(filenameResponse.json()).toEqual([expect.objectContaining({ fileName: 'roadmap.md', categoryId: 'folder-b' })])

    const scopedMiss = await app.inject({ method: 'GET', url: '/api/memory-folders/file-search?query=roadmap&categoryId=folder-a' })
    expect(scopedMiss.json()).toEqual([])
    const scopedMatch = await app.inject({ method: 'GET', url: '/api/memory-folders/file-search?query=roadmap&categoryId=folder-b' })
    expect(scopedMatch.json()).toEqual([expect.objectContaining({ fileName: 'roadmap.md', categoryId: 'folder-b' })])

    const { getAgentMemory } = await import('../../../src/core/memory/agent-memory.js')
    const recall = vi.spyOn(getAgentMemory(), 'recall').mockResolvedValue([{
      id: 'chunk-alpha', text: 'Plain source wording.', source: 'permanent', score: 0.9,
      sourceFile: 'alpha.md', categoryId: 'folder-a', chunkIndex: 0,
    }])
    const semanticResponse = await app.inject({ method: 'GET', url: '/api/memory-folders/file-search?query=architecture&categoryId=folder-a&semantic=true' })
    expect(semanticResponse.json()).toEqual([expect.objectContaining({
      fileName: 'alpha.md', categoryId: 'folder-a', matchedFields: ['content'],
    })])
    expect(recall).toHaveBeenCalledWith('architecture', 100, expect.any(String))
    recall.mockRestore()

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
      { text: '# Roadmap\nMilestones.', chunkIndex: 0, sourceFile: 'roadmap.md', categoryId: 'folder-b' },
      { text: 'Delivery dates.', chunkIndex: 1, sourceFile: 'roadmap.md', categoryId: 'folder-b' },
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
})
