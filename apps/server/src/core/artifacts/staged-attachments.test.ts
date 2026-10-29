import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../../db/database.js'
import { discardStagedChatAttachments, listStagedChatAttachments, releaseStagedChatAttachments, stageChatAttachment, takeStagedChatAttachments } from './staged-attachments.js'

const mocks = vi.hoisted(() => ({
  materialize: vi.fn(),
}))

vi.mock('./file-artifacts.js', () => ({
  materializeFileAttachment: mocks.materialize,
}))

describe('staged attachment jobs', () => {
  let dataDir = ''

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'cynosure-staged-attachment-'))
    process.env.CYNOSURE_DATA_DIR = dataDir
    getDb().prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conversation-1', 'Chat', 1, 1)`).run()
    mocks.materialize.mockReset().mockResolvedValue({
      id: 'attachment-1', name: 'large.txt', originalPath: '/tmp/large.txt',
      textPath: '/tmp/large.txt.parsed.md', sizeBytes: 100, textBytes: 100,
    })
  })

  afterEach(async () => {
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    await rm(dataDir, { recursive: true, force: true })
  })

  test('a parsed upload is ready to send at once, with its client id', async () => {
    const staged = await stageChatAttachment('conversation-1', {
      name: 'large.txt', content: 'large text', clientId: 'client-1',
    })
    expect(listStagedChatAttachments('conversation-1')[0]).toMatchObject({ id: staged.id, clientId: 'client-1', status: 'ready' })
    expect(takeStagedChatAttachments('conversation-1', [staged.id])).toHaveLength(1)
  })

  test('uploads left processing by an earlier version become ready', () => {
    getDb().prepare(`INSERT INTO staged_chat_attachments (id, conversation_id, client_id, artifact_json, status, progress_current, progress_total, error, created_at, updated_at)
      VALUES ('old', 'conversation-1', NULL, ?, 'processing', 3, 8, NULL, 1, 1)`).run(JSON.stringify({ id: 'old', name: 'old.txt' }))
    expect(listStagedChatAttachments('conversation-1').map((item) => item.status)).toEqual(['ready'])
  })

  test('releasing a draft deletes its files', async () => {
    const path = join(dataDir, 'upload.txt')
    writeFileSync(path, 'draft')
    mocks.materialize.mockResolvedValue({ id: 'attachment-1', name: 'upload.txt', originalPath: path, textPath: path, sizeBytes: 5, textBytes: 5 })
    const state = await stageChatAttachment('conversation-1', { name: 'upload.txt', content: 'draft' })
    await releaseStagedChatAttachments('conversation-1', [state.id])
    expect(existsSync(path)).toBe(false)
    expect(listStagedChatAttachments('conversation-1')).toEqual([])
  })

  test('discard includes an upload still being materialized', async () => {
    let finish!: (artifact: unknown) => void
    mocks.materialize.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const stage = stageChatAttachment('conversation-1', { name: 'draft.txt', content: 'draft' })
    const discard = discardStagedChatAttachments('conversation-1')
    const late = join(dataDir, 'late.txt')
    writeFileSync(late, 'draft')
    finish({ id: 'late-upload', name: 'draft.txt', originalPath: late, textPath: join(dataDir, 'missing-text'), sizeBytes: 5, textBytes: 5 })
    await stage
    await discard
    expect(listStagedChatAttachments('conversation-1')).toEqual([])
    expect(existsSync(late)).toBe(false)
  })

  test('rejects stale or foreign staged IDs instead of silently dropping files', () => {
    expect(() => takeStagedChatAttachments('conversation-1', ['missing'])).toThrow('no longer available')
  })
})
