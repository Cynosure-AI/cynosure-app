import Fastify from 'fastify'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../db/database.js'

const runTriggerExecution = vi.hoisted(() => vi.fn())
vi.mock('../core/triggers/trigger-runner.js', () => ({ runTriggerExecution }))

import {
  createCronJob, getActiveCronRuns, startCronScheduler, stopCronScheduler, triggerCronJobNow,
} from '../core/triggers/cron-scheduler.js'
import { registerChatRoutes } from './chat.js'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cynosure-cron-stop-'))
  process.env.CYNOSURE_DATA_DIR = directory
  getDb().prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('cron-conversation', 'Cron', 1, 1)
})
afterEach(async () => {
  await stopCronScheduler()
  runTriggerExecution.mockReset()
  closeDb()
  delete process.env.CYNOSURE_DATA_DIR
  rmSync(directory, { recursive: true, force: true })
})

test('chat Stop aborts the cron run behind its conversation', async () => {
  let runSignal: AbortSignal | undefined
  runTriggerExecution.mockImplementation(({ signal, onConversationCreated }) => {
    runSignal = signal
    onConversationCreated?.('cron-conversation')
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })

  const job = createCronJob({ agentId: '', schedule: '0 0 1 1 *', prompt: 'Run task',
    executionConfig: {
      providerId: 'test-provider', model: 'test-model', allowedTools: [], subAgents: [],
      memoryFolderIds: [], systemPrompt: '', thinkingEnabled: false, reasoningEffort: 'medium',
      autoToolRouting: false, autoMemory: false,
    } })
  startCronScheduler(() => undefined)
  triggerCronJobNow(job.id)
  expect(getActiveCronRuns()).toEqual([expect.objectContaining({
    jobId: job.id, conversationId: 'cron-conversation',
  })])

  const app = Fastify()
  await app.register(async (instance) => registerChatRoutes(instance, () => undefined), { prefix: '/api/chat' })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/chat/cancel',
      payload: { streamId: 'cron-round-stream', conversationId: 'cron-conversation' } })
    expect(response.statusCode).toBe(200)
    expect(runSignal?.aborted).toBe(true)
    await vi.waitFor(() => expect(getActiveCronRuns()).toHaveLength(0))
  } finally {
    await app.close()
  }
})
