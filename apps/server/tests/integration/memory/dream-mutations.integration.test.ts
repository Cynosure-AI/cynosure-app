import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../../../src/db/database.js'
import { getAgentMemory } from '../../../src/core/memory/agent-memory.js'
import { getMemorySpaceFolderPath } from '../../../src/core/memory/memory-space-scope.js'
import { makeMemoryAppendTool, makeMemoryRetrieveChunksTool } from '../../../src/core/tools/builtin/memory-tools.js'

let directory: string
let file: string
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const revisions = new Map<string, string>()
const options = {
    assignedSpaces: [{ id: 'default', name: 'Default' }],
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
    file = join(getMemorySpaceFolderPath('default')!, 'notes.md')
    db.prepare(`INSERT INTO memory_file_index(document_id, document_ref, space_id, file_name, content_hash, chunk_count, created_at)
        VALUES ('doc', 'notes#abc123', 'default', 'notes.md', ?, 1, ?)`).run(hash('Unrelated fact.'), Date.now())
    writeFileSync(file, 'Unrelated fact.')
    revisions.clear()
    const memory = getAgentMemory()
    vi.spyOn(memory, 'getChunksByRange').mockImplementation(async () => [{ text: readFileSync(file, 'utf8'), chunkIndex: 0, sourceFile: 'notes.md', spaceId: 'default' }])
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
test('Dream can add a sourced correction while preserving existing content', async () => {
    expect((await read()).success).toBe(true)
    const result = await makeMemoryAppendTool(options).execute({ documentRef: 'notes#abc123', content: 'Correction: prefers concise replies. Source: chat / m1.' })
    expect(result.success).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('Unrelated fact.')
    expect(readFileSync(file, 'utf8')).toContain('Source: chat / m1.')
})
test('a concurrent edit is rejected under the document lock until Dream reads again', async () => {
    await read()
    setContent('New human edit.')
    await expect(makeMemoryAppendTool(options).execute({ documentRef: 'notes#abc123', content: 'Stale addition' })).rejects.toThrow('Document changed since read')
    expect(readFileSync(file, 'utf8')).toBe('New human edit.')
    await read()
    expect((await makeMemoryAppendTool(options).execute({ documentRef: 'notes#abc123', content: 'Fresh addition' })).success).toBe(true)
})
test('an edit during chunk retrieval does not authorize changes using stale content', async () => {
    vi.mocked(getAgentMemory().getChunksByRange).mockImplementationOnce(async () => {
        setContent('Concurrent edit')
        return [{ text: 'Unrelated fact.', chunkIndex: 0, sourceFile: 'notes.md', spaceId: 'default' }]
    })
    expect((await read()).success).toBe(false)
    expect(revisions.size).toBe(0)
})
test('an aborted write leaves the source untouched', async () => {
    await read()
    const controller = new AbortController()
    controller.abort()
    await expect(makeMemoryAppendTool(options).execute({ documentRef: 'notes#abc123', content: 'Do not write' }, controller.signal)).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe('Unrelated fact.')
})
