import Fastify from 'fastify'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { closeDb, getDb } from '../db/database.js'
import { registerActiveChatExecution, unregisterActiveChatExecution } from '../core/chat/active-executions.js'
import { registerChatRoutes } from './chat.js'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cynosure-chat-cancel-'))
  process.env.CYNOSURE_DATA_DIR = directory
  getDb().prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('conversation', 'Chat', 1, 1)
})
afterEach(() => {
  unregisterActiveChatExecution('execution')
  closeDb()
  delete process.env.CYNOSURE_DATA_DIR
  rmSync(directory, { recursive: true, force: true })
})

test('chat cancel aborts the active execution by conversation even with a stale stream id', async () => {
  const controller = new AbortController()
  registerActiveChatExecution({ id: 'execution', conversationId: 'conversation', agentId: null,
    model: null, startedAt: Date.now() }, controller)
  const app = Fastify()
  await app.register(async (instance) => registerChatRoutes(instance, () => undefined), { prefix: '/api/chat' })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/chat/cancel',
      payload: { streamId: 'stale-stream', conversationId: 'conversation' } })
    expect(response.statusCode).toBe(200)
    expect(response.json().executionIds).toContain('execution')
    expect(controller.signal.aborted).toBe(true)
  } finally {
    await app.close()
  }
})

test('chat cancel stops an execution whose send request has not registered yet', async () => {
  const app = Fastify()
  await app.register(async (instance) => registerChatRoutes(instance, () => undefined), { prefix: '/api/chat' })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/chat/cancel',
      payload: { streamId: 'early-execution', conversationId: 'conversation' } })
    expect(response.statusCode).toBe(200)
    expect(response.json().executionIds).toContain('early-execution')

    const controller = new AbortController()
    registerActiveChatExecution({ id: 'early-execution', conversationId: 'conversation', agentId: null,
      model: null, startedAt: Date.now() }, controller)
    expect(controller.signal.aborted).toBe(true)
  } finally {
    unregisterActiveChatExecution('early-execution')
    await app.close()
  }
})

test('early cancellation is scoped to its conversation', async () => {
  const app = Fastify()
  await app.register(async (instance) => registerChatRoutes(instance, () => undefined), { prefix: '/api/chat' })
  try {
    await app.inject({ method: 'POST', url: '/api/chat/cancel',
      payload: { streamId: 'scoped-execution', conversationId: 'conversation' } })
    const controller = new AbortController()
    registerActiveChatExecution({ id: 'scoped-execution', conversationId: 'another-conversation',
      agentId: null, model: null, startedAt: Date.now() }, controller)
    expect(controller.signal.aborted).toBe(false)
  } finally {
    unregisterActiveChatExecution('scoped-execution')
    await app.close()
  }
})
