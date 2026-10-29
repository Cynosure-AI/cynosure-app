import Database from 'better-sqlite3'
import { materializeImageArtifacts } from '../artifacts/image-artifacts.js'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as Database.Database | null, waiting: false, active: false }))
vi.mock('../triggers/cron-scheduler.js', () => ({
  getPendingWait: () => state.waiting ? { jobId: 'wait' } : null,
  cancelConversationWait: vi.fn(() => { state.waiting = false }),
}))
vi.mock('../../db/database.js', () => ({ getDb: () => state.db }))
vi.mock('./active-executions.js', () => ({ getChatExecutionIdsByConversation: () => state.active ? ['execution'] : [] }))
vi.mock('../artifacts/image-artifacts.js', () => ({
  artifactFileUrlToDataUrl: (url: string) => url,
  extractFilePathFromFileUrl: () => null,
  materializeAudioArtifacts: async () => [],
  materializeImageArtifacts: vi.fn(async () => []),
}))
vi.mock('../artifacts/file-artifacts.js', () => ({
  materializeFileAttachments: async () => [],
  readFileAttachmentText: () => null,
}))
vi.mock('../artifacts/attachment-store.js', () => ({
  persistMessageFileAttachments: () => {},
}))

import {
  beginChatQueueTurn,
  configureChatQueue,
  enqueueChatMessage,
  getChatQueueState,
  markQueuedMessagePromoted,
  pauseAllChatQueuesOnStartup,
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
    state.waiting = false
    state.active = false
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
        content TEXT NOT NULL, content_blocks_json TEXT, created_at INTEGER NOT NULL
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

    state.waiting = true // A tool can schedule a wait before the steering is consumed.
    const messages = await takeSteeringMessages('conversation', 'stream')

    expect(state.waiting).toBe(false)
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

  test('keeps messages pending throughout a scheduled wait and drains them on resume', async () => {
    state.waiting = true
    const executed: string[] = []
    configureChatQueue(async (conversationId, queued) => {
      executed.push(queued.content)
      markQueuedMessagePromoted(conversationId, queued.messageId!)
      return true
    }, () => {})
    await enqueueChatMessage('conversation', request('after the wait'))
    expect(getChatQueueState('conversation').paused).toBe(false)
    await runNextQueuedMessage('conversation')
    expect(executed).toEqual([])

    state.waiting = false
    await runNextQueuedMessage('conversation')
    expect(executed).toEqual(['after the wait'])
  })

  test('holds the rest of a queue when a completed turn schedules another wait', async () => {
    const executed: string[] = []
    configureChatQueue(async (conversationId, queued) => {
      executed.push(queued.content)
      markQueuedMessagePromoted(conversationId, queued.messageId!)
      state.waiting = true
      return true
    }, () => {})
    state.active = true
    await enqueueChatMessage('conversation', request('first'))
    await enqueueChatMessage('conversation', request('second'))
    state.active = false
    await runNextQueuedMessage('conversation')
    expect(executed).toEqual(['first'])
    expect(getChatQueueState('conversation').items.map(item => item.content)).toEqual(['second'])
  })

  test.each(['new', 'existing'])('steering a %s message cancels an idle wait and runs immediately', async (kind) => {
    state.waiting = true
    const execute = vi.fn(async (conversationId: string, queued: { messageId?: string }) => {
      expect(state.waiting).toBe(false)
      markQueuedMessagePromoted(conversationId, queued.messageId!)
      return true
    })
    configureChatQueue(execute, () => {})
    if (kind === 'new') {
      await enqueueChatMessage('conversation', { ...request('resume now'), delivery: 'steer' })
    } else {
      const item = await enqueueChatMessage('conversation', request('resume now'))
      promoteQueuedMessageToSteering('conversation', item.id)
    }
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    expect(state.waiting).toBe(false)
    expect(getChatQueueState('conversation').items).toEqual([])
  })

  test('pauses items left pending by a restart so they are offered for resume', async () => {
    await enqueueChatMessage('conversation', request('first'))
    state.db!.prepare("UPDATE queued_chat_messages SET status = 'pending'").run()
    expect(getChatQueueState('conversation').paused).toBe(false)

    pauseAllChatQueuesOnStartup()

    expect(getChatQueueState('conversation').paused).toBe(true)
    expect(getChatQueueState('conversation').items.map(item => item.content)).toEqual(['first'])
  })

  describe('queue turn lifecycle without a chat view or websocket subscriber', () => {
    test('sends after a background turn has persisted its final response, in FIFO order', async () => {
      const finish = beginChatQueueTurn('conversation')
      const executed: string[] = []
      configureChatQueue(async (conversationId, queued) => {
        executed.push(queued.content)
        markQueuedMessagePromoted(conversationId, queued.messageId!)
        return true
      }, () => {})
      await enqueueChatMessage('conversation', request('first'))
      await enqueueChatMessage('conversation', request('second'))
      await runNextQueuedMessage('conversation')
      expect(executed).toEqual([])
      finish(true)
      await vi.waitFor(() => expect(executed).toEqual(['first', 'second']))
      expect(getChatQueueState('conversation').items).toEqual([])
    })

    test.each([true, false])('handles attachment staging finishing after the turn (completed=%s)', async (completed) => {
      const finish = beginChatQueueTurn('conversation')
      const execute = vi.fn(async (conversationId: string, queued: { messageId?: string }) => {
        markQueuedMessagePromoted(conversationId, queued.messageId!)
        return true
      })
      configureChatQueue(execute, () => {})
      let release!: () => void
      vi.mocked(materializeImageArtifacts).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return []
      })
      const enqueue = enqueueChatMessage('conversation', { ...request('with attachment'), imageDataUrls: ['data:image/png;base64,AA=='] })
      finish(completed)
      release()
      await enqueue
      if (completed) {
        await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
        expect(getChatQueueState('conversation').items).toEqual([])
      } else {
        expect(execute).not.toHaveBeenCalled()
        expect(getChatQueueState('conversation').paused).toBe(true)
      }
    })

    test('errors and cancellation pause queued messages', async () => {
      const finish = beginChatQueueTurn('conversation')
      const execute = vi.fn(async () => true)
      configureChatQueue(execute, () => {})
      await enqueueChatMessage('conversation', request('keep for later'))
      finish(false)
      await runNextQueuedMessage('conversation')
      expect(execute).not.toHaveBeenCalled()
      expect(getChatQueueState('conversation').paused).toBe(true)
    })
  })

})
