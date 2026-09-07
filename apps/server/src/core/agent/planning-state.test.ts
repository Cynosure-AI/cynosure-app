import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { vi } from 'vitest'
import { getEventBus } from '../telemetry/event-bus.js'

const dbHolder = vi.hoisted(() => ({ current: null as unknown as Database.Database }))
vi.mock('../../db/database.js', () => ({
  getDb: () => dbHolder.current,
}))

import {
  buildPlanningStateContext,
  closePlanningRun,
  createPlanningRun,
  getLatestPlanningState,
  getPlanningState,
  interruptPlanningRun,
  reconcilePlanningAfterToolBatch,
  resumeOrCreatePlanningRun,
  upsertTodoItem,
  writeTodoList,
} from './planning-state.js'

describe('visible planning state', () => {
  beforeEach(() => {
    dbHolder.current = new Database(':memory:')
    dbHolder.current.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        status TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        result_json TEXT,
        iterations INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        completed_at INTEGER
      )
    `)
  })

  afterEach(() => {
    getEventBus().removeAllListeners()
    dbHolder.current.close()
  })

  test('creates, writes, advances, and completes a planning run', () => {
    const updates: unknown[] = []
    getEventBus().on('planning:state-updated', (state) => updates.push(state))
    const run = createPlanningRun('conversation', '  Ship the release  ')

    expect(run.objective).toBe('Ship the release')
    expect(writeTodoList(run.runId, {
      tasks: [
        { title: 'Build artifacts', status: 'pending' },
        { title: 'Publish release', status: 'pending' },
      ],
    }).success).toBe(true)
    expect(getPlanningState(run.runId)?.items.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: '01', status: 'in_progress' },
      { id: '02', status: 'pending' },
    ])

    expect(upsertTodoItem(run.runId, { taskId: '1', status: 'completed', note: 'built' }).success).toBe(true)
    expect(getPlanningState(run.runId)?.items.map(({ status }) => status)).toEqual(['completed', 'in_progress'])
    expect(reconcilePlanningAfterToolBatch(run.runId, { success: true })?.items.map(({ status }) => status))
      .toEqual(['completed', 'completed'])

    const completed = closePlanningRun(run.runId, 'completed', { summary: 'released' })
    expect(completed).toMatchObject({ status: 'completed', result: { summary: 'released' } })
    expect(completed?.completedAt).toEqual(expect.any(Number))
    expect(updates.length).toBeGreaterThanOrEqual(4)
  })

  test('keeps a run open when completion is requested with pending work', () => {
    const run = createPlanningRun('conversation', 'Do both steps')
    writeTodoList(run.runId, {
      tasks: [
        { title: 'First', status: 'in_progress' },
        { title: 'Second', status: 'pending' },
      ],
    })

    const state = closePlanningRun(run.runId, 'completed', { summary: 'premature' })

    expect(state?.status).toBe('running')
    expect(state?.completedAt).toBeUndefined()
  })

  test('records interruption and tool failure on the active task', () => {
    const run = createPlanningRun('conversation', 'Investigate failure')
    writeTodoList(run.runId, { tasks: [{ title: 'Inspect logs' }, { title: 'Apply fix' }] })

    const interrupted = interruptPlanningRun(run.runId, { error: 'User stopped the run' })
    expect(interrupted?.items[0]).toMatchObject({
      status: 'in_progress',
      note: 'User stopped the run',
    })
    const failed = reconcilePlanningAfterToolBatch(run.runId, { success: false, note: 'Logs unavailable' })
    expect(failed?.items.map(({ status }) => status)).toEqual(['blocked', 'in_progress'])
    expect(failed?.items[0].note).toBe('Logs unavailable')
  })

  test('validates list and append requests and exposes planning context', () => {
    const run = createPlanningRun('conversation', 'Plan')

    expect(writeTodoList(run.runId, { tasks: [{ title: '   ' }] })).toEqual({
      success: false,
      output: 'At least one task with a title is required.',
    })
    expect(upsertTodoItem(run.runId, {})).toEqual({
      success: false,
      output: 'No task matches taskId (missing). A title is required to append a new planning task.',
    })
    upsertTodoItem(run.runId, { title: 'New task', status: 'not-a-status' })
    const state = getPlanningState(run.runId)!
    expect(state.items[0]).toMatchObject({ id: '01', title: 'New task', status: 'in_progress' })
    expect(buildPlanningStateContext(state)).toContain('id=01; status=in_progress; title=New task')
    expect(buildPlanningStateContext({ ...state, items: [] })).toBeNull()
    // Update by taskId only: title stays unchanged.
    expect(upsertTodoItem(run.runId, { taskId: '1', status: 'completed' }).success).toBe(true)
    expect(getPlanningState(run.runId)?.items[0]).toMatchObject({ id: '01', title: 'New task', status: 'completed' })
    // Append requires a title when no taskId matches.
    expect(upsertTodoItem(run.runId, { taskId: '99', status: 'pending' }).success).toBe(false)
  })

  test('deletes an empty run on close and skips corrupt persisted rows', () => {
    const empty = createPlanningRun('conversation', 'Empty')
    expect(closePlanningRun(empty.runId, 'cancelled')).toBeNull()
    expect(getPlanningState(empty.runId)).toBeNull()

    dbHolder.current.prepare(
      'INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('corrupt', 'other', 'running', '{broken', null, 0, 1, 1, null)
    expect(getLatestPlanningState('other')).toBeNull()
    const replacement = resumeOrCreatePlanningRun('other', 'Recovered')
    expect(replacement.objective).toBe('Recovered')
  })
})
