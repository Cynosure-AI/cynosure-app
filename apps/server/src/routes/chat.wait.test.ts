import Fastify from 'fastify'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../db/database.js'
import { configureChatQueue, getChatQueueState, markQueuedMessagePromoted, type QueuedExecutionRequest } from '../core/chat/message-queue.js'
import { createCronJob, getPendingWait } from '../core/triggers/cron-scheduler.js'
import { registerChatRoutes } from './chat.js'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cynosure-chat-wait-'))
  process.env.CYNOSURE_DATA_DIR = directory
  getDb().prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('conversation', 'Chat', 1, 1)
  createCronJob({ agentId: '', schedule: '0 0 1 1 *', prompt: 'Check the build', oneOff: true, conversationId: 'conversation' })
})

afterEach(() => {
  closeDb()
  delete process.env.CYNOSURE_DATA_DIR
  rmSync(directory, { recursive: true, force: true })
})

test('a regular send to a waiting conversation persists in the queue until steered', async () => {
  const app = Fastify()
  await app.register(async (instance) => registerChatRoutes(instance, () => undefined), { prefix: '/api/chat' })
  const execute = vi.fn(async (conversationId: string, request: QueuedExecutionRequest) => {
    expect(getPendingWait(conversationId)).toBeNull()
    markQueuedMessagePromoted(conversationId, request.messageId!)
    return true
  })
  configureChatQueue(execute, () => undefined)
  try {
    const sent = await app.inject({ method: 'POST', url: '/api/chat/conversations/conversation/send',
      payload: { content: 'Resume now', run: { model: 'saved-model' } } })
    expect(sent.statusCode).toBe(200)
    expect(execute).not.toHaveBeenCalled()
    expect(getPendingWait('conversation')).not.toBeNull()

    const persisted = await app.inject({ method: 'GET', url: '/api/chat/conversations/conversation/queue' })
    const queue = persisted.json()
    expect(queue.paused).toBe(false)
    expect(queue.items).toEqual([expect.objectContaining({ content: 'Resume now', run: { model: 'saved-model' } })])

    const steered = await app.inject({ method: 'POST',
      url: `/api/chat/conversations/conversation/queue/${queue.items[0].id}/steer` })
    expect(steered.statusCode).toBe(200)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    expect(getChatQueueState('conversation').items).toEqual([])
    expect(getPendingWait('conversation')).toBeNull()
  } finally {
    await app.close()
  }
})
