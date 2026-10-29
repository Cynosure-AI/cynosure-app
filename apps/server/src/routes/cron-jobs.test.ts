import Fastify from 'fastify'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../db/database.js'
import { registerCronJobRoutes } from './cron-jobs.js'

const activeRuns = vi.hoisted(() => vi.fn(() => [] as Array<{ conversationId: string }>))
vi.mock('../core/triggers/cron-scheduler.js', async importOriginal => ({
  ...await importOriginal<object>(),
  getActiveCronRuns: activeRuns,
}))

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cynosure-cron-results-'))
  vi.stubEnv('CYNOSURE_DATA_DIR', directory)
  activeRuns.mockReturnValue([])
})
afterEach(() => {
  closeDb()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

function conversation(id: string, completedAt: number, origin = 'cron'): void {
  getDb().prepare(`INSERT INTO conversations (id, title, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run(id, `Task ${id}`, origin, completedAt - 1, completedAt)
  message(id, `${id}-final`, 'Final result', completedAt)
}

function message(conversationId: string, id: string, content: string, createdAt: number): void {
  getDb().prepare(`INSERT INTO messages (id, conversation_id, role, content, created_at)
    VALUES (?, ?, 'assistant', ?, ?)`).run(id, conversationId, content, createdAt)
}

async function recentResults() {
  const app = Fastify()
  await app.register(registerCronJobRoutes, { prefix: '/api/cron-jobs' })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/cron-jobs/recent-results' })
    expect(response.statusCode).toBe(200)
    return response.json()
  } finally {
    await app.close()
  }
}

test('returns the three latest cron replies ordered by reply time, including jobs without a saved schedule', async () => {
  for (let index = 1; index <= 4; index++) conversation(`cron-${index}`, index * 10)
  conversation('chat', 100, 'chat')
  conversation('channel', 100, 'channel')
  // Reading/renaming an old conversation must not make its run recent again.
  getDb().prepare("UPDATE conversations SET updated_at = 1000 WHERE id = 'cron-1'").run()
  message('cron-4', 'delegated', 'Sub-agent detail', 50)
  getDb().prepare("UPDATE messages SET ma_invocation_id = 'delegate' WHERE id = 'delegated'").run()
  message('cron-3', 'tool-result', 'Tool details', 60)
  getDb().prepare("UPDATE messages SET role = 'tool' WHERE id = 'tool-result'").run()

  expect(await recentResults()).toEqual([
    { conversationId: 'cron-4', title: 'Task cron-4', agentId: null, content: 'Final result', completedAt: 40 },
    { conversationId: 'cron-3', title: 'Task cron-3', agentId: null, content: 'Final result', completedAt: 30 },
    { conversationId: 'cron-2', title: 'Task cron-2', agentId: null, content: 'Final result', completedAt: 20 },
  ])
})

test('excludes active, empty, stopped, error and tool-calling replies before limiting the results', async () => {
  conversation('finished', 1)
  for (const id of ['active', 'empty', 'stopped', 'error', 'calling', 'temporary']) conversation(id, 10)
  activeRuns.mockReturnValue([{ conversationId: 'active' }])
  getDb().prepare("UPDATE messages SET content = '  ' WHERE conversation_id = 'empty'").run()
  getDb().prepare("UPDATE messages SET stopped = 1 WHERE conversation_id = 'stopped'").run()
  getDb().prepare("UPDATE messages SET is_error = 1 WHERE conversation_id = 'error'").run()
  getDb().prepare(`UPDATE messages SET tool_calls_json = '[{"id":"call"}]' WHERE conversation_id = 'calling'`).run()
  getDb().prepare("UPDATE conversations SET temporary = 1 WHERE id = 'temporary'").run()

  expect((await recentResults()).map((result: { conversationId: string }) => result.conversationId)).toEqual(['finished'])
})

test('returns an empty list without history and bounds long response payloads', async () => {
  expect(await recentResults()).toEqual([])
  conversation('long', 1)
  getDb().prepare("UPDATE messages SET content = ? WHERE conversation_id = 'long'").run('x'.repeat(100_000))
  expect((await recentResults())[0].content).toHaveLength(4000)
})
