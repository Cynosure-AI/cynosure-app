import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../../../src/db/database.js'
import { getAgentMemory } from '../../../src/core/memory/agent-memory.js'
import { recordMemoryRevision } from '../../../src/core/memory/memory-revisions.js'
import { getMemoryFolderDirectoryPath } from '../../../src/core/memory/memory-folder-scope.js'
import { makeMemoryDeleteTool, makeMemoryPatchTool, makeMemorySearchTool } from '../../../src/core/tools/builtin/memory-tools.js'

let directory: string
let file: string
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const revisions = new Map<string, string>()
const options = {
    assignedFolders: [{ id: 'uncategorized', name: 'Uncategorized' }],
    onDocumentRead: (id: string, revision: string) => { revisions.set(id, revision) },
    beforeDocumentMutation: (id: string, content: string) => {
        if (revisions.get(id) !== hash(content)) throw new Error('Document changed since read')
    },
}
function setContent(content: string) {
    writeFileSync(file, content)
    getDb().prepare("UPDATE memory_file_index SET content_hash = ? WHERE document_id = 'doc'").run(hash(content))
    recordMemoryRevision({ documentId: 'doc', documentRef: 'notes#abc123', folderId: 'uncategorized', fileName: 'notes.md', content })
}
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-dream-mutations-'))
    process.env.CYNOSURE_DATA_DIR = directory
    const db = getDb()
    file = join(getMemoryFolderDirectoryPath('uncategorized')!, 'notes.md')
    db.prepare(`INSERT INTO memory_file_index(document_id, document_ref, category_id, file_name, content_hash, chunk_count, created_at)
        VALUES ('doc', 'notes#abc123', 'uncategorized', 'notes.md', ?, 1, ?)`).run(hash('Unrelated fact.'), Date.now())
    writeFileSync(file, 'Unrelated fact.')
    recordMemoryRevision({ documentId: 'doc', documentRef: 'notes#abc123', folderId: 'uncategorized', fileName: 'notes.md', content: 'Unrelated fact.' })
    revisions.clear()
    const memory = getAgentMemory()
    vi.spyOn(memory, 'getChunksByRange').mockImplementation(async () => [{ text: readFileSync(file, 'utf8'), chunkIndex: 0, sourceFile: 'notes.md', folderId: 'uncategorized' }])
    vi.spyOn(memory, 'countChunks').mockResolvedValue(1)
    vi.spyOn(memory, 'reindexFile').mockImplementation(async () => {
        setContent(readFileSync(file, 'utf8'))
        return { fileName: 'notes.md', chunkCount: 1 }
    })
})
afterEach(() => {
    vi.restoreAllMocks()
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    rmSync(directory, { recursive: true, force: true })
})
async function read() {
    const ref = getAgentMemory().getDocumentReference('uncategorized', 'notes.md')!
    options.onDocumentRead(ref.documentId, ref.revision)
    return { success: true }
}
test('memory_search returns canonical context and a monotonic revision without chunk coordinates', async () => {
    vi.spyOn(getAgentMemory(), 'recall').mockResolvedValueOnce([{
        id: 'chunk', text: 'Unrelated fact.', source: 'permanent', score: 0.9,
        sourceFile: 'notes.md', folderId: 'uncategorized', chunkIndex: 0,
        contentHash: hash('Unrelated fact.'), sourceStart: 0, sourceEnd: 15,
    }])
    const result = await makeMemorySearchTool(options).execute({ query: 'unrelated' })
    expect(result.success).toBe(true)
    expect(result.structuredContent).toEqual({ results: [expect.objectContaining({
        fileRef: 'notes#abc123', fileName: 'notes.md', revision: 1, content: 'Unrelated fact.',
    })] })
    expect(result.output).not.toContain('chunkIndex')
})
test('Dream can replace a topical memory while preserving unrelated supported content', async () => {
    expect((await read()).success).toBe(true)
    const result = await makeMemoryPatchTool(options).execute({ fileRef: 'notes#abc123', patch: '@@\n Unrelated fact.\n+Prefers concise replies.' })
    expect(result.success).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('Unrelated fact.')
    expect(readFileSync(file, 'utf8')).toContain('Prefers concise replies.')
})
test('a concurrent edit is rejected under the document lock until Dream reads again', async () => {
    await read()
    setContent('New human edit.')
    await expect(makeMemoryPatchTool(options).execute({ fileRef: 'notes#abc123', patch: '@@\n-New human edit.\n+Stale replacement' })).rejects.toThrow('Document changed since read')
    expect(readFileSync(file, 'utf8')).toBe('New human edit.')
    await read()
    expect((await makeMemoryPatchTool(options).execute({ fileRef: 'notes#abc123', patch: '@@\n-New human edit.\n+Fresh replacement' })).success).toBe(true)
})
test('a patch can apply after a concurrent unrelated edit when its context remains unique', async () => {
    setContent('Unrelated fact.\nConcurrent unrelated edit.')
    const result = await makeMemoryPatchTool({ assignedFolders: options.assignedFolders }).execute({
        fileRef: 'notes#abc123', patch: '@@\n-Unrelated fact.\n+Updated fact.',
    })
    expect(result.success).toBe(true)
    expect(result.structuredContent).toMatchObject({ previousRevision: 2, revision: 3 })
    expect(readFileSync(file, 'utf8')).toBe('Updated fact.\nConcurrent unrelated edit.')
})
test('an aborted write leaves the source untouched', async () => {
    await read()
    const controller = new AbortController()
    controller.abort()
    await expect(makeMemoryPatchTool(options).execute({ fileRef: 'notes#abc123', patch: '@@\n-Unrelated fact.\n+Do not write' }, controller.signal)).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe('Unrelated fact.')
})

test('memory_delete archives a searched canonical file and removes its active index', async () => {
    await read()
    const result = await makeMemoryDeleteTool(options).execute({ fileRef: 'notes#abc123' })

    expect(result).toMatchObject({
        success: true,
        structuredContent: {
            status: 'deleted',
            fileRef: 'notes#abc123',
            fileName: 'notes.md',
            folder: 'Uncategorized',
        },
    })
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(join(getMemoryFolderDirectoryPath('uncategorized')!, '.trash')))
        .toEqual([expect.stringMatching(/^notes-.*\.md$/)])
    expect(getAgentMemory().getDocumentReference('uncategorized', 'notes.md')).toBeUndefined()
    expect(getDb().prepare("SELECT status FROM memory_documents WHERE document_id = 'doc'").get())
        .toEqual({ status: 'deleted' })
})

test('a failed exact edit batch is atomic and does not reindex', async () => {
    await read()
    const reindex = vi.mocked(getAgentMemory().reindexFile)
    const callsBefore = reindex.mock.calls.length
    const result = await makeMemoryPatchTool(options).execute({
        fileRef: 'notes#abc123',
        patch: '@@\n-Unrelated fact.\n+Changed fact.\n@@\n-Text that is not present.\n',
    })
    expect(result.success).toBe(false)
    expect(result.structuredContent).toMatchObject({ status: 'conflict', reason: 'expected_context_not_found' })
    expect(readFileSync(file, 'utf8')).toBe('Unrelated fact.')
    expect(reindex).toHaveBeenCalledTimes(callsBefore)
})
