import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const dbHolder = vi.hoisted(() => ({ current: null as unknown as Database.Database }))
vi.mock('../../db/database.js', () => ({
  getDb: () => dbHolder.current,
}))

import { AgentExecutor } from './agent-executor.js'
import { applyTodoUpdate, createPlanningRun, getPlanningState } from './planning-state.js'
import { makePlanningTools } from '../tools/builtin/planning-tools.js'
import type { LLMGateway } from '../gateway/gateway.js'
import type { StreamChunk, ToolDefinition } from '../gateway/providers/base.provider.js'

describe('AgentExecutor planning recovery', () => {
  beforeEach(() => {
    dbHolder.current = new Database(':memory:')
    dbHolder.current.exec(`
      CREATE TABLE run_plans (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        objective TEXT NOT NULL DEFAULT '',
        items_json TEXT NOT NULL DEFAULT '[]',
        current_item_id TEXT,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      )
    `)
  })

  afterEach(() => dbHolder.current.close())

  test('allows more than one consecutive continuation before the plan resumes', async () => {
    const run = createPlanningRun('planning-retries', 'Finish the task')
    applyTodoUpdate(run.runId, { tasks: [{ title: 'Finish it', status: 'in_progress' }] })
    let call = 0
    const streamComplete = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {
      call++
      if (call === 3) {
        yield {
          toolCalls: [{
            id: 'finish-plan',
            type: 'function',
            function: { name: 'todo_update', arguments: '{"tasks":[{"title":"Finish it","status":"completed"}]}' },
          }],
          done: true,
        }
        return
      }
      yield { content: call === 4 ? 'finished' : 'stopped early', done: true }
    })())
    const executor = new AgentExecutor({
      gateway: { streamComplete } as unknown as LLMGateway,
      tools: makePlanningTools(run.runId),
      conversationId: 'planning-retries',
      broadcast: vi.fn(),
      model: 'test',
      saveMessages: false,
      emitEvents: false,
      planningRunId: run.runId,
      isPrimaryExecutor: true,
    })

    await expect(executor.run([{ role: 'user', content: 'go' }])).resolves.toMatchObject({ content: 'finished' })
    expect(streamComplete).toHaveBeenCalledTimes(4)
    expect(getPlanningState(run.runId)?.items[0].status).toBe('completed')
  })

  test('ends the turn without continuation once a wait is scheduled', async () => {
    const run = createPlanningRun('planning-wait', 'Deploy and verify')
    applyTodoUpdate(run.runId, { tasks: [{ title: 'Wait for the deploy', status: 'in_progress' }] })
    const wait: ToolDefinition = {
      name: 'schedule_wait',
      description: 'Pauses the conversation',
      parameters: { type: 'object', properties: {} },
      timeout: 1_000,
      execute: async () => ({ success: true, output: '{"jobId":"wait"}' }),
    }
    let call = 0
    const streamComplete = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {
      call++
      if (call === 1) {
        yield { toolCalls: [{ id: 'wait', type: 'function', function: { name: 'schedule_wait', arguments: '{}' } }], done: true }
        return
      }
      yield { content: 'Waiting for the deploy.', done: true }
    })())
    const executor = new AgentExecutor({
      gateway: { streamComplete } as unknown as LLMGateway,
      tools: [wait, ...makePlanningTools(run.runId)],
      conversationId: 'planning-wait',
      broadcast: vi.fn(),
      model: 'test',
      saveMessages: false,
      emitEvents: false,
      planningRunId: run.runId,
      isPrimaryExecutor: true,
    })

    await expect(executor.run([{ role: 'user', content: 'go' }])).resolves.toMatchObject({ content: 'Waiting for the deploy.' })
    expect(streamComplete).toHaveBeenCalledTimes(2)
    expect(getPlanningState(run.runId)?.items[0].status).toBe('in_progress')
  })

  test('refreshes the continuation budget after resumed tool work', async () => {
    const run = createPlanningRun('planning-reset', 'Finish both tasks')
    applyTodoUpdate(run.runId, { tasks: [{ title: 'Look up data' }, { title: 'Close the plan' }] })
    const lookup: ToolDefinition = {
      name: 'lookup',
      description: 'Looks up data',
      parameters: { type: 'object', properties: {} },
      timeout: 1_000,
      execute: async () => ({ success: true, output: 'found' }),
    }
    let call = 0
    const streamComplete = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {
      call++
      if (call === 3) {
        yield { toolCalls: [{ id: 'lookup', type: 'function', function: { name: 'lookup', arguments: '{}' } }], done: true }
        return
      }
      if (call === 6) {
        expect(getPlanningState(run.runId)?.items.map(({ status }) => status)).toEqual(['in_progress', 'pending'])
        yield {
          toolCalls: [{
            id: 'finish-plan',
            type: 'function',
            function: { name: 'todo_update', arguments: '{"tasks":[{"title":"Look up data","status":"completed"},{"title":"Close the plan","status":"completed"}]}' },
          }],
          done: true,
        }
        return
      }
      yield { content: call === 7 ? 'finished' : 'stopped early', done: true }
    })())
    const executor = new AgentExecutor({
      gateway: { streamComplete } as unknown as LLMGateway,
      tools: [lookup, ...makePlanningTools(run.runId)],
      conversationId: 'planning-reset',
      broadcast: vi.fn(),
      model: 'test',
      saveMessages: false,
      emitEvents: false,
      planningRunId: run.runId,
      isPrimaryExecutor: true,
    })

    await expect(executor.run([{ role: 'user', content: 'go' }])).resolves.toMatchObject({ content: 'finished' })
    expect(streamComplete).toHaveBeenCalledTimes(7)
    expect(getPlanningState(run.runId)?.items.every((item) => item.status === 'completed')).toBe(true)
  })
})
