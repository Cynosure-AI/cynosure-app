import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../../db/database.js'
import { listStagedChatAttachments, stageChatAttachment, takeStagedChatAttachments } from './staged-attachments.js'

const mocks = vi.hoisted(() => ({
  index: vi.fn(),
  removeChunks: vi.fn(),
  materialize: vi.fn(),
}))

vi.mock('./attachment-rag.js', () => ({
  indexConversationAttachment: mocks.index,
  deleteConversationAttachmentChunks: mocks.removeChunks,
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
    mocks.removeChunks.mockReset().mockResolvedValue(undefined)
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

  test('persists authoritative chunk progress and makes only completed jobs consumable', async () => {
    let finish!: () => void
    mocks.index.mockImplementation(async (_conversationId, _artifact, opts) => {
      opts.onProgress(3, 8)
      await new Promise<void>((resolve) => { finish = resolve })
      opts.onProgress(8, 8)
      return 8
    })

    const staged = await stageChatAttachment('conversation-1', {
      name: 'large.txt', content: 'large text', clientId: 'client-1',
    })
    await vi.waitFor(() => expect(listStagedChatAttachments('conversation-1')[0]).toMatchObject({
      id: staged.id, status: 'processing', progressCurrent: 3, progressTotal: 8,
    }))
    expect(takeStagedChatAttachments('conversation-1', [staged.id])).toEqual([])

    finish()
    await vi.waitFor(() => expect(listStagedChatAttachments('conversation-1')[0]).toMatchObject({
      status: 'ready', progressCurrent: 8, progressTotal: 8, chunkCount: 8,
    }))
    expect(takeStagedChatAttachments('conversation-1', [staged.id])).toHaveLength(1)
  })
})
