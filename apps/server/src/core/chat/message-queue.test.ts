import Database from 'better-sqlite3'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as Database.Database | null }))
vi.mock('../../db/database.js', () => ({ getDb: () => state.db }))
vi.mock('./active-executions.js', () => ({ getChatExecutionIdsByConversation: () => [] }))
vi.mock('../artifacts/image-artifacts.js', () => ({
  artifactFileUrlToDataUrl: (url: string) => url,
  extractFilePathFromFileUrl: () => null,
  materializeAudioArtifacts: async () => [],
  materializeImageArtifacts: async () => [],
}))
vi.mock('../artifacts/file-artifacts.js', () => ({
  materializeFileAttachments: async () => [],
  readFileAttachmentText: () => null,
}))
vi.mock('../artifacts/attachment-rag.js', () => ({
  indexConversationAttachment: async () => 0,
  persistMessageFileAttachments: () => {},
}))

import {
  configureChatQueue,
  enqueueChatMessage,
  getChatQueueState,
  markQueuedMessagePromoted,
  promoteQueuedMessageToSteering,
  registerChatSteeringHandler,
  runNextQueuedMessage,
  takeSteeringMessages,
} from './message-queue.js'

function request(content: string) {
  return { content, delivery: 'next' as const, run: { model: 'model' } }
}

describe('persistent chat queue', () => {
  beforeEach(() => {
    state.db?.close()
    state.db = new Database(':memory:')
    state.db.exec(`
      CREATE TABLE queued_chat_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, content TEXT NOT NULL,
        delivery TEXT NOT NULL, status TEXT NOT NULL, position INTEGER NOT NULL,
        run_json TEXT NOT NULL, image_urls_json TEXT, audio_urls_json TEXT,
        file_artifacts_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, image_urls_json TEXT, audio_urls_json TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE conversations (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL);
      INSERT INTO conversations VALUES ('conversation', 0);
    `)
  })

  test('persists separate FIFO items and snapshots their run configuration', async () => {
    await enqueueChatMessage('conversation', request('first'))
    await enqueueChatMessage('conversation', request('second'))

    const queue = getChatQueueState('conversation')
    expect(queue.paused).toBe(true)
    expect(queue.items.map(item => item.content)).toEqual(['first', 'second'])
    expect(queue.items.map(item => item.position)).toEqual([1, 2])
    expect(queue.items[0].run).toEqual({ model: 'model' })
  })

  test('atomically promotes steering into user history and removes it from the queue', async () => {
    const handler = vi.fn()
    const unregister = registerChatSteeringHandler('conversation', handler)
    const queued = await enqueueChatMessage('conversation', request('change direction'))
    expect(promoteQueuedMessageToSteering('conversation', queued.id)).toBe(true)
    expect(handler).toHaveBeenCalled()

    const messages = await takeSteeringMessages('conversation', 'stream')

    expect(messages).toEqual([{ role: 'user', content: 'change direction' }])
    expect(getChatQueueState('conversation').items).toEqual([])
    expect(state.db!.prepare('SELECT role, content FROM messages').get()).toEqual({
      role: 'user', content: 'change direction',
    })
    unregister()
  })

  test('drains successful next-turn items as separate FIFO executions', async () => {
    const executed: string[] = []
    configureChatQueue(async (conversationId, queued) => {
      executed.push(queued.content)
      markQueuedMessagePromoted(conversationId, queued.messageId!)
      return true
    }, () => {})
    await enqueueChatMessage('conversation', request('first'))
    await enqueueChatMessage('conversation', request('second'))
    state.db!.prepare("UPDATE queued_chat_messages SET status = 'pending'").run()

    await runNextQueuedMessage('conversation')

    expect(executed).toEqual(['first', 'second'])
    expect(getChatQueueState('conversation').items).toEqual([])
  })
})
