import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../../db/database.js'
import { materializeFileAttachment } from './file-artifacts.js'
import { releaseAttachmentAsset } from './attachment-asset-references.js'
import { collectOrphanedAttachmentAssets, listConversationFileAttachments, persistMessageFileAttachments } from './attachment-store.js'
import { commitStagedChatAttachments, listStagedChatAttachments, releaseStagedChatAttachments, stageChatAttachment, takeStagedChatAttachments } from './staged-attachments.js'
import { deleteQueuedChatMessage, enqueueChatMessage } from '../chat/message-queue.js'

const mocks = vi.hoisted(() => ({
    parse: vi.fn(),
}))
vi.mock('../utils/document-parser.js', () => ({
    isParseableDocument: (name: string) => name.endsWith('.pdf'),
    parseDocument: mocks.parse,
}))

let directory = ''
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cynosure-dedup-'))
    process.env.CYNOSURE_DATA_DIR = directory
    const db = getDb()
    for (const id of ['a', 'b', 'c']) {
        db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)').run(id, id)
        db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', '', 1)").run(`m-${id}`, id)
    }
    mocks.parse.mockReset().mockResolvedValue('Parsed document')
})
afterEach(async () => {
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    await rm(directory, { recursive: true, force: true })
})

async function ready(conversationId: string, name = 'notes.txt', content = 'Same contents') {
    const staged = await stageChatAttachment(conversationId, { name, content })
    expect(listStagedChatAttachments(conversationId).find(item => item.id === staged.id)?.status).toBe('ready')
    return takeStagedChatAttachments(conversationId, [staged.id])[0]
}

function commit(conversationId: string, artifact: Awaited<ReturnType<typeof ready>>) {
    persistMessageFileAttachments(getDb(), `m-${conversationId}`, conversationId, [artifact], 1)
    commitStagedChatAttachments(conversationId, [artifact.id])
}

test('a renamed repeat upload links to the same files across chats', async () => {
    const first = await ready('a')
    commit('a', first)
    closeDb() // The content lookup must survive application restarts.
    const second = await ready('b', 'renamed.txt', `data:text/plain;base64,${Buffer.from('Same contents').toString('base64')}`)
    commit('b', second)
    expect(second.id).not.toBe(first.id)
    expect(second.assetId).toBe(first.assetId)
    expect(second.originalPath).toBe(first.originalPath)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM attachment_assets').get()).toEqual({ n: 1 })
    expect(readdirSync(dirname(first.originalPath))).toHaveLength(2)
    expect(listConversationFileAttachments(getDb(), 'b')[0].name).toBe('renamed.txt')
    expect(listConversationFileAttachments(getDb(), 'b')[0].assetId).toBe(first.assetId)
    expect(listConversationFileAttachments(getDb(), 'c')).toEqual([])

    getDb().prepare("DELETE FROM conversations WHERE id = 'a'").run()
    expect(await collectOrphanedAttachmentAssets()).toBe(0)
    expect(existsSync(second.originalPath)).toBe(true)
    getDb().prepare("DELETE FROM conversations WHERE id = 'b'").run()
    expect(await collectOrphanedAttachmentAssets()).toBe(1)
    expect(existsSync(second.originalPath)).toBe(false)
})

test('matching names with changed bytes get independent assets', async () => {
    const first = await ready('a', 'notes.txt', 'Version one')
    const second = await ready('b', 'notes.txt', 'Version two')
    expect(second.assetId).not.toBe(first.assetId)
})

test('concurrent duplicate uploads parse once, and discarding one keeps the shared files', async () => {
    let finishParsing!: (text: string) => void
    mocks.parse.mockImplementation(() => new Promise<string>(resolve => { finishParsing = resolve }))
    const file = { name: 'report.pdf', content: 'data:application/pdf;base64,cGRm' }
    const uploads = [stageChatAttachment('a', file), stageChatAttachment('b', file)]
    expect(mocks.parse).toHaveBeenCalledTimes(1)
    finishParsing('Extracted report')
    const [first, second] = await Promise.all(uploads)
    expect(second.artifact.assetId).toBe(first.artifact.assetId)
    await releaseStagedChatAttachments('a', [first.id])
    expect(existsSync(second.artifact.originalPath)).toBe(true)
    await releaseStagedChatAttachments('b', [second.id])
    expect(existsSync(second.artifact.originalPath)).toBe(false)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM attachment_assets').get()).toEqual({ n: 0 })
})

test('discarding a duplicate draft preserves the committed file', async () => {
    const first = await ready('a')
    commit('a', first)
    const second = await ready('b')
    await releaseStagedChatAttachments('b', [second.id])
    expect(existsSync(first.originalPath)).toBe(true)
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
    expect(getDb().prepare('SELECT content_hash FROM attachment_assets').get()).toEqual({ content_hash: expect.stringMatching(/^[a-f0-9]{64}$/) })
})

test('missing stored files are replaced', async () => {
    const first = await ready('a')
    commit('a', first)
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
})
