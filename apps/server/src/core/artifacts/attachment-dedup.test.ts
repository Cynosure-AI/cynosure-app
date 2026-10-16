import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../../db/database.js'
import { materializeFileAttachment } from './file-artifacts.js'
import { releaseAttachmentAsset } from './attachment-asset-references.js'
import { buildAttachmentFilter, collectOrphanedAttachmentAssets, indexConversationAttachment, listConversationFileAttachments, persistMessageFileAttachments } from './attachment-rag.js'
import { commitStagedChatAttachments, listStagedChatAttachments, releaseStagedChatAttachments, stageChatAttachment, takeStagedChatAttachments } from './staged-attachments.js'
import { deleteQueuedChatMessage, enqueueChatMessage } from '../chat/message-queue.js'

const mocks = vi.hoisted(() => ({
    chunks: new Map<string, number>(),
    ingest: vi.fn(),
    parse: vi.fn(),
    remove: vi.fn(),
}))
vi.mock('../utils/document-parser.js', () => ({
    isParseableDocument: (name: string) => name.endsWith('.pdf'),
    parseDocument: mocks.parse,
}))
vi.mock('../memory/parser.js', () => ({ getMemoryParser: () => ({ ingest: mocks.ingest }) }))
vi.mock('../memory/rag.js', () => ({ getRAGStore: () => ({
    countBySource: async (_table: string, id: string) => mocks.chunks.get(id) ?? 0,
    deleteByFilter: mocks.remove,
}) }))

let directory = ''
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cynosure-dedup-'))
    process.env.CYNOSURE_DATA_DIR = directory
    const db = getDb()
    for (const id of ['a', 'b', 'c']) {
        db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)').run(id, id)
        db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', '', 1)").run(`m-${id}`, id)
    }
    mocks.chunks.clear()
    mocks.ingest.mockReset().mockImplementation(async (_table, _text, meta, opts) => {
        opts?.onProgress?.(2, 2)
        mocks.chunks.set(meta.sourceFile, 2)
        return 2
    })
    mocks.parse.mockReset().mockResolvedValue('Parsed document')
    mocks.remove.mockReset().mockImplementation(async (_table, filter: string) => {
        for (const id of mocks.chunks.keys()) if (filter.includes(id)) mocks.chunks.delete(id)
    })
})
afterEach(async () => {
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    await rm(directory, { recursive: true, force: true })
})

async function ready(conversationId: string, name = 'notes.txt', content = 'Same contents') {
    const staged = await stageChatAttachment(conversationId, { name, content })
    await vi.waitFor(() => expect(listStagedChatAttachments(conversationId).find(item => item.id === staged.id)?.status).toBe('ready'))
    return takeStagedChatAttachments(conversationId, [staged.id])[0]
}

function commit(conversationId: string, artifact: Awaited<ReturnType<typeof ready>>) {
    persistMessageFileAttachments(getDb(), `m-${conversationId}`, conversationId, [artifact], 1)
    commitStagedChatAttachments(conversationId, [artifact.id])
}

test('a renamed repeat upload links to the same files and embeddings across chats', async () => {
    const first = await ready('a')
    commit('a', first)
    closeDb() // The content lookup must survive application restarts.
    const second = await ready('b', 'renamed.txt', `data:text/plain;base64,${Buffer.from('Same contents').toString('base64')}`)
    commit('b', second)
    expect(second.id).not.toBe(first.id)
    expect(second.assetId).toBe(first.assetId)
    expect(second.originalPath).toBe(first.originalPath)
    expect(mocks.ingest).toHaveBeenCalledTimes(1)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM attachment_assets').get()).toEqual({ n: 1 })
    expect(readdirSync(dirname(first.originalPath))).toHaveLength(2)
    expect(listConversationFileAttachments(getDb(), 'b')[0].name).toBe('renamed.txt')
    expect(buildAttachmentFilter('b')).toContain(first.assetId)
    expect(buildAttachmentFilter('c')).toBe('1 = 0')

    getDb().prepare("DELETE FROM conversations WHERE id = 'a'").run()
    expect(await collectOrphanedAttachmentAssets()).toBe(0)
    expect(existsSync(second.originalPath)).toBe(true)
    getDb().prepare("DELETE FROM conversations WHERE id = 'b'").run()
    expect(await collectOrphanedAttachmentAssets()).toBe(1)
    expect(existsSync(second.originalPath)).toBe(false)
    expect(mocks.chunks.size).toBe(0)
})

test('matching names with changed bytes get independent assets and indexes', async () => {
    const first = await ready('a', 'notes.txt', 'Version one')
    const second = await ready('b', 'notes.txt', 'Version two')
    expect(second.assetId).not.toBe(first.assetId)
    expect(mocks.ingest).toHaveBeenCalledTimes(2)
})

test('concurrent duplicate uploads parse and embed once, and discarding one keeps the shared job alive', async () => {
    let finishParsing!: (text: string) => void
    let finishIndexing!: () => void
    let signal!: AbortSignal
    mocks.parse.mockImplementation(() => new Promise<string>(resolve => { finishParsing = resolve }))
    mocks.ingest.mockImplementation(async (_table, _text, meta, opts) => {
        signal = opts.signal
        opts.onProgress(0, 2)
        await new Promise<void>(resolve => { finishIndexing = resolve })
        signal.throwIfAborted()
        mocks.chunks.set(meta.sourceFile, 2)
        return 2
    })
    const file = { name: 'report.pdf', content: 'data:application/pdf;base64,cGRm' }
    const uploads = [stageChatAttachment('a', file), stageChatAttachment('b', file)]
    expect(mocks.parse).toHaveBeenCalledTimes(1)
    finishParsing('Extracted report')
    const [first, second] = await Promise.all(uploads)
    await vi.waitFor(() => expect(finishIndexing).toBeTypeOf('function'))
    await releaseStagedChatAttachments('a', [first.id])
    expect(signal.aborted).toBe(false)
    expect(existsSync(second.artifact.originalPath)).toBe(true)
    finishIndexing()
    await vi.waitFor(() => expect(listStagedChatAttachments('b')[0].status).toBe('ready'))
    expect(mocks.ingest).toHaveBeenCalledTimes(1)
    await releaseStagedChatAttachments('b', [second.id])
    expect(existsSync(second.artifact.originalPath)).toBe(false)
})

test('discarding a duplicate draft preserves the committed file and its index', async () => {
    const first = await ready('a')
    commit('a', first)
    const second = await ready('b')
    mocks.remove.mockClear()
    await releaseStagedChatAttachments('b', [second.id])
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(existsSync(first.originalPath)).toBe(true)
    expect(mocks.chunks.get(first.assetId!)).toBe(2)
})

test('discarding the last duplicate cancels every waiter on a shared indexing job', async () => {
    let signal!: AbortSignal
    mocks.ingest.mockImplementation(async (_table, _text, _meta, opts) => {
        signal = opts.signal
        await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    })
    const [first, second] = await Promise.all([
        stageChatAttachment('a', { name: 'notes.txt', content: 'Shared job' }),
        stageChatAttachment('b', { name: 'notes.txt', content: 'Shared job' }),
    ])
    await vi.waitFor(() => expect(mocks.ingest).toHaveBeenCalledTimes(1))
    await releaseStagedChatAttachments('a', [first.id])
    expect(signal.aborted).toBe(false)
    await releaseStagedChatAttachments('b', [second.id])
    expect(signal.aborted).toBe(true)
    expect(existsSync(first.artifact.originalPath)).toBe(false)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM attachment_assets').get()).toEqual({ n: 0 })
})

test('failed indexing can be retried by uploading the same file again', async () => {
    mocks.ingest.mockRejectedValueOnce(new Error('Embedding service unavailable'))
    const failed = await stageChatAttachment('a', { name: 'notes.txt', content: 'Retry me' })
    await vi.waitFor(() => expect(listStagedChatAttachments('a')[0].status).toBe('failed'))
    const retried = await ready('b', 'notes.txt', 'Retry me')
    expect(retried.assetId).toBe(failed.artifact.assetId)
    expect(mocks.ingest).toHaveBeenCalledTimes(2)
    await releaseStagedChatAttachments('a', [failed.id])
    expect(existsSync(retried.originalPath)).toBe(true)
})

test('orphan collection protects drafts and uploads awaiting durable ownership', async () => {
    const upload = await materializeFileAttachment({ name: 'direct.txt', content: 'Uploading' }, 'a')
    expect(await collectOrphanedAttachmentAssets()).toBe(0)
    const draft = await ready('b')
    releaseAttachmentAsset(upload)
    expect(await collectOrphanedAttachmentAssets()).toBe(1)
    expect(existsSync(draft.originalPath)).toBe(true)
    await releaseStagedChatAttachments('b', [draft.id])
})

test('legacy assets without hashes are discovered and reused', async () => {
    const first = await ready('a')
    commit('a', first)
    getDb().prepare('UPDATE attachment_assets SET content_hash = NULL').run()
    const second = await ready('b')
    expect(second.assetId).toBe(first.assetId)
    expect(mocks.ingest).toHaveBeenCalledTimes(1)
    expect(getDb().prepare('SELECT content_hash FROM attachment_assets').get()).toEqual({ content_hash: expect.stringMatching(/^[a-f0-9]{64}$/) })
})

test('missing stored files are replaced and a missing vector index is rebuilt', async () => {
    const first = await ready('a')
    commit('a', first)
    mocks.chunks.clear()
    await indexConversationAttachment('a', first)
    expect(mocks.ingest).toHaveBeenCalledTimes(2)
    rmSync(first.originalPath)
    const second = await ready('b')
    expect(second.assetId).not.toBe(first.assetId)
    expect(readFileSync(second.originalPath, 'utf8')).toBe('Same contents')
})

test('queued attachments retain shared assets until the last queue or chat releases them', async () => {
    const first = await ready('a')
    const queuedA = await enqueueChatMessage('a', { content: 'Later', delivery: 'next', run: {}, files: [{ name: first.name, stagedId: first.id }] })
    const second = await ready('b')
    const queuedB = await enqueueChatMessage('b', { content: 'Later too', delivery: 'next', run: {}, files: [{ name: second.name, stagedId: second.id }] })
    expect(await collectOrphanedAttachmentAssets()).toBe(0)
    expect(deleteQueuedChatMessage('a', queuedA.id)).toBe(true)
    expect(existsSync(second.originalPath)).toBe(true)
    expect(deleteQueuedChatMessage('b', queuedB.id)).toBe(true)
    await vi.waitFor(() => expect(existsSync(second.originalPath)).toBe(false))
    expect(mocks.chunks.size).toBe(0)
})
