import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../../../src/db/database.js'
import { getAgentMemory } from '../../../src/core/memory/agent-memory.js'
import { recordMemoryRevision } from '../../../src/core/memory/memory-revisions.js'
import { getMemoryFolderDirectoryPath } from '../../../src/core/memory/memory-folder-scope.js'
import { makeMemoryPatchTool, makeMemoryReadTool, makeMemorySearchTool } from '../../../src/core/tools/builtin/memory-tools.js'

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
    recordMemoryRevision({ documentId: 'doc', documentRef: 'notes#abc123', categoryId: 'uncategorized', fileName: 'notes.md', content })
}
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-dream-mutations-'))
    process.env.CYNOSURE_DATA_DIR = directory
    const db = getDb()
    file = join(getMemoryFolderDirectoryPath('uncategorized')!, 'notes.md')
    db.prepare(`INSERT INTO memory_file_index(document_id, document_ref, category_id, file_name, content_hash, chunk_count, created_at)
        VALUES ('doc', 'notes#abc123', 'uncategorized', 'notes.md', ?, 1, ?)`).run(hash('Unrelated fact.'), Date.now())
    writeFileSync(file, 'Unrelated fact.')
    recordMemoryRevision({ documentId: 'doc', documentRef: 'notes#abc123', categoryId: 'uncategorized', fileName: 'notes.md', content: 'Unrelated fact.' })
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
async function read() {
    const ref = getAgentMemory().getDocumentReference('uncategorized', 'notes.md')!
    options.onDocumentRead(ref.documentId, ref.revision)
    return { success: true }
}
test('memory_search returns canonical context and a monotonic revision without chunk coordinates', async () => {
    vi.spyOn(getAgentMemory(), 'recall').mockResolvedValueOnce([{
        id: 'chunk', text: 'Unrelated fact.', source: 'permanent', score: 0.9,
        sourceFile: 'notes.md', categoryId: 'uncategorized', chunkIndex: 0,
        contentHash: hash('Unrelated fact.'), sourceStart: 0, sourceEnd: 15,
    }])
    const result = await makeMemorySearchTool(options).execute({ query: 'unrelated' })
    expect(result.success).toBe(true)
    expect(result.structuredContent).toEqual({ results: [expect.objectContaining({
        fileRef: 'notes#abc123', fileName: 'notes.md', revision: 1, content: 'Unrelated fact.',
    })] })
    expect(result.output).not.toContain('chunkIndex')
})
test('memory_read targets canonical sections, anchors, and line windows', async () => {
    setContent([
        '# Profile',
        '',
        'Introduction.',
        '',
        '## Development',
        'Uses Vue 3.',
        '### Tools',
        'Uses Electron.',
        '## Current Projects',
        'Builds Cynosure.',
    ].join('\n'))
    const tool = makeMemoryReadTool(options)

    const section = await tool.execute({ fileRef: 'notes#abc123', section: 'Development' })
    expect(section.structuredContent).toMatchObject({
        status: 'success', revision: 2,
        content: '## Development\nUses Vue 3.\n### Tools\nUses Electron.\n',
        range: { startLine: 5, endLine: 8, hasMoreBefore: true, hasMoreAfter: true },
    })

    const anchor = await tool.execute({ fileRef: 'notes#abc123', anchor: 'Uses Vue 3.', beforeLines: 1, afterLines: 1 })
    expect(anchor.structuredContent).toMatchObject({
        content: '## Development\nUses Vue 3.\n### Tools\n',
        range: { startLine: 5, endLine: 7 },
    })

    const lines = await tool.execute({ fileRef: 'notes#abc123', startLine: 9, lineCount: 2 })
    expect(lines.structuredContent).toMatchObject({ content: '## Current Projects\nBuilds Cynosure.', range: { startLine: 9, endLine: 10 } })
})
test('memory_read rejects missing and ambiguous canonical locators', async () => {
    setContent('## Repeated\nOne\n## Repeated\nTwo')
    const tool = makeMemoryReadTool(options)
    expect((await tool.execute({ fileRef: 'notes#abc123', section: 'Missing' })).structuredContent).toMatchObject({ reason: 'section_not_found' })
    expect((await tool.execute({ fileRef: 'notes#abc123', section: 'Repeated' })).structuredContent).toMatchObject({ reason: 'ambiguous_context' })
    expect((await tool.execute({ fileRef: 'notes#abc123', section: 'Repeated', startLine: 1 })).structuredContent).toMatchObject({ reason: 'invalid_request' })
})
test('Dream can replace a topical memory while preserving unrelated supported content', async () => {
    expect((await read()).success).toBe(true)
    const result = await makeMemoryPatchTool(options).execute({ fileRef: 'notes#abc123', expectedRevision: 1, patch: '@@\n Unrelated fact.\n+Prefers concise replies.' })
    expect(result.success).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('Unrelated fact.')
    expect(readFileSync(file, 'utf8')).toContain('Prefers concise replies.')
})
test('a concurrent edit is rejected under the document lock until Dream reads again', async () => {
    await read()
    setContent('New human edit.')
    await expect(makeMemoryPatchTool(options).execute({ fileRef: 'notes#abc123', expectedRevision: 1, patch: '@@\n-New human edit.\n+Stale replacement' })).rejects.toThrow('Document changed since read')
    expect(readFileSync(file, 'utf8')).toBe('New human edit.')
    await read()
    expect((await makeMemoryPatchTool(options).execute({ fileRef: 'notes#abc123', expectedRevision: 1, patch: '@@\n-New human edit.\n+Fresh replacement' })).success).toBe(true)
})
test('a stale revision can apply when its context remains unique', async () => {
    setContent('Unrelated fact.\nConcurrent unrelated edit.')
    const result = await makeMemoryPatchTool({ assignedCategories: options.assignedCategories }).execute({
        fileRef: 'notes#abc123', expectedRevision: 1, patch: '@@\n-Unrelated fact.\n+Updated fact.',
    })
    expect(result.success).toBe(true)
    expect(result.structuredContent).toMatchObject({ previousRevision: 2, revision: 3 })
    expect(readFileSync(file, 'utf8')).toBe('Updated fact.\nConcurrent unrelated edit.')
})
test('an aborted write leaves the source untouched', async () => {
    await read()
    const controller = new AbortController()
    controller.abort()
    await expect(makeMemoryPatchTool(options).execute({ fileRef: 'notes#abc123', expectedRevision: 1, patch: '@@\n-Unrelated fact.\n+Do not write' }, controller.signal)).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe('Unrelated fact.')
})

test('a failed exact edit batch is atomic and does not reindex', async () => {
    await read()
    const reindex = vi.mocked(getAgentMemory().reindexFile)
    const callsBefore = reindex.mock.calls.length
    const result = await makeMemoryPatchTool(options).execute({
        fileRef: 'notes#abc123', expectedRevision: 1,
        patch: '@@\n-Unrelated fact.\n+Changed fact.\n@@\n-Text that is not present.\n',
    })
    expect(result.success).toBe(false)
    expect(result.structuredContent).toMatchObject({ status: 'conflict', reason: 'expected_context_not_found' })
    expect(readFileSync(file, 'utf8')).toBe('Unrelated fact.')
    expect(reindex).toHaveBeenCalledTimes(callsBefore)
})
