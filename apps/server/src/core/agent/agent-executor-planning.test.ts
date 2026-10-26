import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const dbHolder = vi.hoisted(() => ({ current: null as unknown as Database.Database }))
vi.mock('../../db/database.js', () => ({
  getDb: () => dbHolder.current,
}))

import {
  AgentExecutor,
  MAIN_AGENT_MAX_ROUNDS,
  MaxToolRoundsExceededError,
  OPEN_PLAN_MAX_TOOL_ROUND_CONTINUATIONS,
  type AgentExecutorConfig,
} from './agent-executor.js'
import { applyTodoUpdate, createPlanningRun, getPlanningState } from './planning-state.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { makePlanningTools } from '../tools/builtin/planning-tools.js'
import type { LLMGateway } from '../gateway/gateway.js'
import type { CompletionRequest, StreamChunk, ToolDefinition } from '../gateway/providers/base.provider.js'

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

  describe('tool-round limit continuations', () => {
    function setup(overrides: Partial<AgentExecutorConfig> = {}) {
      const run = createPlanningRun('planning-cap', 'Finish the task')
      applyTodoUpdate(run.runId, { tasks: [{ title: 'Finish it', status: 'in_progress' }] })
      const execute = vi.fn(async () => ({ success: true, output: 'work done' }))
      const work: ToolDefinition = {
        name: 'work', description: 'Work on the task', parameters: { type: 'object', properties: {} }, timeout: 1_000,
        execute,
      }
      const streamComplete = vi.fn((_request: CompletionRequest) => (async function* (): AsyncIterable<StreamChunk> {
        yield { toolCalls: [{ id: `work-${streamComplete.mock.calls.length}`, type: 'function', function: { name: 'work', arguments: '{}' } }], done: true }
      })())
      const broadcast = vi.fn()
      const events = vi.spyOn(getEventBus(), 'emit')
      const executor = new AgentExecutor({
        gateway: { streamComplete } as unknown as LLMGateway,
        tools: [work, ...makePlanningTools(run.runId)],
        conversationId: run.conversationId,
        broadcast,
        model: 'test',
        maxRounds: 1,
        saveMessages: false,
        planningRunId: run.runId,
        isPrimaryExecutor: true,
        ...overrides,
      })
      const capContinuations = () => events.mock.calls.filter(([event, payload]) =>
        event === 'step:status' && (payload as { message?: string }).message?.includes('tool-round limit reached'))
      return { run, executor, execute, streamComplete, broadcast, capContinuations }
    }

    test.each(['single', 'per-round'] as const)('continues past the default cap with open tasks (%s streams)', async (streamMode) => {
      const { run, executor, execute, streamComplete, capContinuations } = setup({ maxRounds: MAIN_AGENT_MAX_ROUNDS, streamMode })
      streamComplete.mockImplementation((request) => (async function* (): AsyncIterable<StreamChunk> {
        const call = streamComplete.mock.calls.length
        if (call === MAIN_AGENT_MAX_ROUNDS + 1) {
          // The pending update must execute in the continuation, with prior results intact.
          expect(request.messages.filter(({ role }) => role === 'tool')).toHaveLength(MAIN_AGENT_MAX_ROUNDS)
          yield {
            toolCalls: [{ id: 'finish', type: 'function', function: {
              name: 'todo_update', arguments: '{"tasks":[{"title":"Finish it","status":"completed"}]}',
            } }], done: true,
          }
        } else if (call > MAIN_AGENT_MAX_ROUNDS + 1) {
          yield { content: 'finished', done: true }
        } else {
          yield { toolCalls: [{ id: `work-${call}`, type: 'function', function: { name: 'work', arguments: '{}' } }], done: true }
        }
      })())

      await expect(executor.run([{ role: 'user', content: 'go' }])).resolves.toMatchObject({
        content: 'finished', toolRounds: MAIN_AGENT_MAX_ROUNDS + 1,
      })
      expect(execute).toHaveBeenCalledTimes(MAIN_AGENT_MAX_ROUNDS)
      expect(streamComplete).toHaveBeenCalledTimes(MAIN_AGENT_MAX_ROUNDS + 2)
      expect(getPlanningState(run.runId)?.items[0].status).toBe('completed')
      expect(capContinuations()).toHaveLength(1)
    })

    test.each(['completed', 'blocked', 'cancelled', 'empty', 'missing', 'empty-goal', 'non-primary'] as const)(
      'preserves the cap error for a %s plan', async (plan) => {
        const { run, executor, execute, streamComplete, broadcast, capContinuations } = setup({
          ...(plan === 'missing' ? { planningRunId: undefined } : {}),
          ...(plan === 'empty-goal' ? { planningGoal: true } : {}),
          ...(plan === 'non-primary' ? { isPrimaryExecutor: false } : {}),
        })
        if (plan === 'empty' || plan === 'empty-goal') applyTodoUpdate(run.runId, { tasks: [] })
        if (plan === 'completed' || plan === 'blocked' || plan === 'cancelled') {
          // Check the list after the last allowed tool round, not just at run start.
          execute.mockImplementation(async () => {
            applyTodoUpdate(run.runId, { tasks: [{ title: 'Finish it', status: plan }] })
            return { success: true, output: 'closed' }
          })
        }

        await expect(executor.run([{ role: 'user', content: 'go' }])).rejects.toThrow(
          'Agent exceeded the maximum of 1 tool-calling rounds before producing a final response.',
        )
        expect(execute).toHaveBeenCalledTimes(1)
        expect(streamComplete).toHaveBeenCalledTimes(2)
        expect(capContinuations()).toHaveLength(0)
        expect(broadcast).toHaveBeenCalledWith('chat:event', expect.objectContaining({
          payload: expect.objectContaining({ type: 'stream-end' }),
        }))
      },
    )

    test.each([false, true])('never refreshes the cap continuation bound after tool work (model recovery: %s)', async (recoverModel) => {
      const { executor, execute, streamComplete, capContinuations } = setup({ maxRounds: 2 })
      if (recoverModel) {
        streamComplete.mockImplementation(() => (async function* (): AsyncIterable<StreamChunk> {
          if (streamComplete.mock.calls.length % 2 === 0) yield { content: 'stopped early', done: true }
          else yield { toolCalls: [{ id: `work-${streamComplete.mock.calls.length}`, type: 'function', function: { name: 'work', arguments: '{}' } }], done: true }
        })())
      }

      await expect(executor.run([{ role: 'user', content: 'go' }])).rejects.toBeInstanceOf(MaxToolRoundsExceededError)
      const totalRounds = 2 * (1 + OPEN_PLAN_MAX_TOOL_ROUND_CONTINUATIONS)
      expect(execute).toHaveBeenCalledTimes(totalRounds)
      expect(streamComplete).toHaveBeenCalledTimes(1 + totalRounds * (recoverModel ? 2 : 1))
      expect(capContinuations()).toHaveLength(OPEN_PLAN_MAX_TOOL_ROUND_CONTINUATIONS)
    })

    test('allows the plan to finish on the last permitted continuation round', async () => {
      const { run, executor, execute, streamComplete, capContinuations } = setup()
      execute.mockImplementation(async () => {
        if (execute.mock.calls.length === 1 + OPEN_PLAN_MAX_TOOL_ROUND_CONTINUATIONS) {
          applyTodoUpdate(run.runId, { tasks: [{ title: 'Finish it', status: 'completed' }] })
        }
        return { success: true, output: 'worked' }
      })
      streamComplete.mockImplementation(() => (async function* (): AsyncIterable<StreamChunk> {
        if (getPlanningState(run.runId)?.items[0].status === 'completed') yield { content: 'finished', done: true }
        else yield { toolCalls: [{ id: `work-${streamComplete.mock.calls.length}`, type: 'function', function: { name: 'work', arguments: '{}' } }], done: true }
      })())

      await expect(executor.run([{ role: 'user', content: 'go' }])).resolves.toMatchObject({
        content: 'finished', toolRounds: 1 + OPEN_PLAN_MAX_TOOL_ROUND_CONTINUATIONS,
      })
      expect(capContinuations()).toHaveLength(OPEN_PLAN_MAX_TOOL_ROUND_CONTINUATIONS)
    })
  })

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

  test('a goal run cannot end without a todo list', async () => {
    const run = createPlanningRun('planning-goal', 'Ship the release')
    const prompts: string[] = []
    let call = 0
    const streamComplete = vi.fn((request: { messages: Array<{ content: unknown }> }) => (async function* (): AsyncIterable<StreamChunk> {
      call++
      prompts.push(String(request.messages.at(-1)?.content))
      if (call === 2) {
        yield {
          toolCalls: [{
            id: 'plan',
            type: 'function',
            function: { name: 'todo_update', arguments: '{"tasks":[{"title":"Ship it","status":"completed"}]}' },
          }],
          done: true,
        }
        return
      }
      yield { content: call === 3 ? 'shipped' : 'done already', done: true }
    })())
    const executor = new AgentExecutor({
      gateway: { streamComplete } as unknown as LLMGateway,
      tools: makePlanningTools(run.runId, { goal: true }),
      conversationId: 'planning-goal',
      broadcast: vi.fn(),
      model: 'test',
      saveMessages: false,
      emitEvents: false,
      planningRunId: run.runId,
      planningGoal: true,
      isPrimaryExecutor: true,
    })

    await expect(executor.run([{ role: 'user', content: '/goal Ship the release' }])).resolves.toMatchObject({ content: 'shipped' })
    expect(streamComplete).toHaveBeenCalledTimes(3)
    expect(prompts[1]).toContain('has no task list yet')
    expect(getPlanningState(run.runId)?.items[0].status).toBe('completed')
  })

  test('a run without a goal may end without a todo list', async () => {
    const run = createPlanningRun('planning-no-goal', 'Answer')
    const streamComplete = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {
      yield { content: 'answered', done: true }
    })())
    const executor = new AgentExecutor({
      gateway: { streamComplete } as unknown as LLMGateway,
      tools: makePlanningTools(run.runId),
      conversationId: 'planning-no-goal',
      broadcast: vi.fn(),
      model: 'test',
      saveMessages: false,
      emitEvents: false,
      planningRunId: run.runId,
      isPrimaryExecutor: true,
    })

    await expect(executor.run([{ role: 'user', content: 'hi' }])).resolves.toMatchObject({ content: 'answered' })
    expect(streamComplete).toHaveBeenCalledTimes(1)
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
