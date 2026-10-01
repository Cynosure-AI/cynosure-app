import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../db/database.js'
import { saveDeepResearchConfig } from '../core/memory/memory-deep-research.js'
import { ensureMemoryFolderPath } from '../core/memory/memory-folder-directories.js'
import { resolveMemoryFolderOverrides } from '../core/chat/run-config.js'
import { getCronJob, listCronJobs, getActiveCronRuns, startCronScheduler, stopCronScheduler } from '../core/triggers/cron-scheduler.js'
import { registerMemoryRoutes } from './memory.js'

const { runTriggerExecution, getProvider } = vi.hoisted(() => ({
  runTriggerExecution: vi.fn(),
  getProvider: vi.fn(),
}))
vi.mock('../core/triggers/trigger-runner.js', () => ({ runTriggerExecution }))
vi.mock('../core/gateway/gateway.js', () => ({ getGateway: () => ({ getProvider }) }))

let directory: string
let app: FastifyInstance
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'cynosure-housekeeping-'))
  process.env.CYNOSURE_DATA_DIR = directory
  getDb()
  getProvider.mockReturnValue({})
  runTriggerExecution.mockImplementation(({ signal, onConversationCreated }) => {
    onConversationCreated('housekeeping-chat')
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  app = Fastify()
  await app.register(async (instance) => registerMemoryRoutes(instance, () => undefined), { prefix: '/api/memory' })
})
afterEach(async () => {
  await stopCronScheduler()
  await app.close()
  vi.clearAllMocks()
  closeDb()
  delete process.env.CYNOSURE_DATA_DIR
  rmSync(directory, { recursive: true, force: true })
})

test('requires the configured Deep Research model before creating a job', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/memory/knowledge/housekeeping' })
  expect(response.statusCode).toBe(400)
  expect(response.json().error).toContain('Deep Research Model')
  expect(listCronJobs()).toHaveLength(0)
})

test('rejects a missing Deep Research provider without creating a job', async () => {
  saveDeepResearchConfig({ providerId: 'research-provider', model: 'research-model' })
  getProvider.mockReturnValue(undefined)
  const response = await app.inject({ method: 'POST', url: '/api/memory/knowledge/housekeeping' })
  expect(response.statusCode).toBe(400)
  expect(listCronJobs()).toHaveLength(0)
})

test('starts a named Free Chat cron with every memory tool and excludes opted-out descendants', async () => {
  const db = getDb()
  const included = ensureMemoryFolderPath(db, 'Work')
  const nested = ensureMemoryFolderPath(db, 'Work/Public')
  const excluded = ensureMemoryFolderPath(db, 'Work/Private')
  db.prepare('UPDATE memory_folders SET auto_memory_excluded = 1 WHERE id = ?').run(excluded.id)
  saveDeepResearchConfig({ providerId: 'research-provider', model: 'research-model' })
  startCronScheduler(() => undefined)

  const response = await app.inject({ method: 'POST', url: '/api/memory/knowledge/housekeeping' })
  expect(response.statusCode).toBe(200)
  const { jobId, conversationId } = response.json()
  expect(conversationId).toBe('housekeeping-chat')
  const job = getCronJob(jobId)!
  expect(job).toMatchObject({ name: 'Knowledge Graph Housekeeping', agentId: '', enabled: false, oneOff: true })
  expect(job.executionConfig).toMatchObject({
    providerId: 'research-provider', model: 'research-model',
    autoToolRouting: false, autoMemory: false, subAgents: [],
    allowedTools: [
      'builtin:memory::memory_search', 'builtin:memory::memory_create',
      'builtin:memory::memory_patch', 'builtin:memory::memory_delete',
      'builtin:memory::knowledge_search', 'builtin:memory::knowledge_assert',
      'builtin:memory::knowledge_delete', 'builtin:memory::knowledge_entity_merge',
    ],
  })
  const scope = resolveMemoryFolderOverrides(db, job.executionConfig!.memoryFolderIds)!
  expect(scope.map(folder => folder.id)).toEqual(expect.arrayContaining([included.id, nested.id]))
  expect(scope.map(folder => folder.id)).not.toContain(excluded.id)
  expect(runTriggerExecution).toHaveBeenCalledWith(expect.objectContaining({
    agent: null, executionConfig: job.executionConfig,
    origin: 'cron', title: 'Knowledge Graph Housekeeping',
  }))
  expect(getActiveCronRuns()).toEqual([expect.objectContaining({ jobId, conversationId })])
})

test('removes the unstarted job when the scheduler is unavailable', async () => {
  ensureMemoryFolderPath(getDb(), 'Work')
  saveDeepResearchConfig({ providerId: 'research-provider', model: 'research-model' })
  const response = await app.inject({ method: 'POST', url: '/api/memory/knowledge/housekeeping' })
  expect(response.statusCode).toBe(503)
  expect(listCronJobs()).toHaveLength(0)
})
