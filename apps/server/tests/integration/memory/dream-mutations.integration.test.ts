import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../../../src/db/database.js'
import { getAgentMemory } from '../../../src/core/memory/agent-memory.js'
import { getMemoryFolderDirectoryPath } from '../../../src/core/memory/memory-folder-scope.js'
import { makeMemoryRetrieveChunksTool, makeMemoryUpdateTool } from '../../../src/core/tools/builtin/memory-tools.js'

let directory: string
let file: string
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const revisions = new Map<string, string>()
const options = {
    assignedCategories: [{ id: 'uncategorized', name: 'Uncategorized' }],
    onDocumentRead: (id: string, revision: string) => { revisions.set(id, revision) },
    beforeDocumentMutation: (id: string, content: string) => {
        if (revisions.get(id) !== hash(content)) throw new Error('Document changed since read')
    },
}
function setContent(content: string) {
    writeFileSync(file, content)
    getDb().prepare("UPDATE memory_file_index SET content_hash = ? WHERE document_id = 'doc'").run(hash(content))
}
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-dream-mutations-'))
    process.env.CYNOSURE_DATA_DIR = directory
    const db = getDb()
    file = join(getMemoryFolderDirectoryPath('uncategorized')!, 'notes.md')
    db.prepare(`INSERT INTO memory_file_index(document_id, document_ref, category_id, file_name, content_hash, chunk_count, created_at)
        VALUES ('doc', 'notes#abc123', 'uncategorized', 'notes.md', ?, 1, ?)`).run(hash('Unrelated fact.'), Date.now())
    writeFileSync(file, 'Unrelated fact.')
    revisions.clear()
    const memory = getAgentMemory()
    vi.spyOn(memory, 'getChunksByRange').mockImplementation(async () => [{ text: readFileSync(file, 'utf8'), chunkIndex: 0, sourceFile: 'notes.md', categoryId: 'uncategorized' }])
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
async function read() { return makeMemoryRetrieveChunksTool(options).execute({ sourceFile: 'notes.md', minPart: 1, maxPart: 1 }) }
test('Dream can replace a topical memory while preserving unrelated supported content', async () => {
    expect((await read()).success).toBe(true)
    const result = await makeMemoryUpdateTool(options).execute({ documentId: 'notes#abc123', edits: [{ op: 'insert_after', anchor: 'Unrelated fact.', text: 'Prefers concise replies.' }] })
    expect(result.success).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('Unrelated fact.')
    expect(readFileSync(file, 'utf8')).toContain('Prefers concise replies.')
})
test('a concurrent edit is rejected under the document lock until Dream reads again', async () => {
    await read()
    setContent('New human edit.')
    await expect(makeMemoryUpdateTool(options).execute({ documentId: 'notes#abc123', edits: [{ op: 'replace', old: 'New human edit.', new: 'Stale replacement' }] })).rejects.toThrow('Document changed since read')
    expect(readFileSync(file, 'utf8')).toBe('New human edit.')
    await read()
    expect((await makeMemoryUpdateTool(options).execute({ documentId: 'notes#abc123', edits: [{ op: 'replace', old: 'New human edit.', new: 'Fresh replacement' }] })).success).toBe(true)
})
test('an edit during chunk retrieval does not authorize changes using stale content', async () => {
    vi.mocked(getAgentMemory().getChunksByRange).mockImplementationOnce(async () => {
        setContent('Concurrent edit')
        return [{ text: 'Unrelated fact.', chunkIndex: 0, sourceFile: 'notes.md', categoryId: 'uncategorized' }]
    })
    expect((await read()).success).toBe(false)
    expect(revisions.size).toBe(0)
})
test('an aborted write leaves the source untouched', async () => {
    await read()
    const controller = new AbortController()
    controller.abort()
    await expect(makeMemoryUpdateTool(options).execute({ documentId: 'notes#abc123', edits: [{ op: 'replace', old: 'Unrelated fact.', new: 'Do not write' }] }, controller.signal)).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe('Unrelated fact.')
})

test('a failed exact edit batch is atomic and does not reindex', async () => {
    await read()
    const reindex = vi.mocked(getAgentMemory().reindexFile)
    const callsBefore = reindex.mock.calls.length
    const result = await makeMemoryUpdateTool(options).execute({
        documentId: 'notes#abc123',
        edits: [
            { op: 'replace', old: 'Unrelated fact.', new: 'Changed fact.' },
            { op: 'delete', old: 'Text that is not present.' },
        ],
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('exact')
    expect(readFileSync(file, 'utf8')).toBe('Unrelated fact.')
    expect(reindex).toHaveBeenCalledTimes(callsBefore)
})
