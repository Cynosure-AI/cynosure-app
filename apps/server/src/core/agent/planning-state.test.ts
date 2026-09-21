import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { vi } from 'vitest'
import { getEventBus } from '../telemetry/event-bus.js'

const dbHolder = vi.hoisted(() => ({ current: null as unknown as Database.Database }))
vi.mock('../../db/database.js', () => ({
  getDb: () => dbHolder.current,
}))

import {
  applyTodoUpdate,
  buildPlanningStateContext,
  closePlanningRun,
  createPlanningRun,
  getLatestPlanningState,
  getPlanningState,
  interruptPlanningRun,
  reconcilePlanningAfterToolBatch,
  resumeOrCreatePlanningRun,
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
    expect(applyTodoUpdate(run.runId, {
      op: 'set',
      tasks: [
        { title: 'Build artifacts', status: 'pending' },
        { title: 'Publish release', status: 'pending' },
      ],
    }).success).toBe(true)
    expect(getPlanningState(run.runId)?.items.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: '01', status: 'in_progress' },
      { id: '02', status: 'pending' },
    ])

    expect(applyTodoUpdate(run.runId, { op: 'update', taskId: '1', status: 'completed', note: 'built' }).success).toBe(true)
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
    applyTodoUpdate(run.runId, {
      op: 'set',
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
    applyTodoUpdate(run.runId, { op: 'set', tasks: [{ title: 'Inspect logs' }, { title: 'Apply fix' }] })

    const interrupted = interruptPlanningRun(run.runId, { error: 'User stopped the run' })
    expect(interrupted?.items[0]).toMatchObject({
      status: 'in_progress',
      note: 'User stopped the run',
    })
    const failed = reconcilePlanningAfterToolBatch(run.runId, { success: false, note: 'Logs unavailable' })
    expect(failed?.items.map(({ status }) => status)).toEqual(['blocked', 'in_progress'])
    expect(failed?.items[0].note).toBe('Logs unavailable')
  })

  test('validates atomic operations and exposes planning context', () => {
    const run = createPlanningRun('conversation', 'Plan')

    expect(applyTodoUpdate(run.runId, { op: 'set', tasks: [{ title: '   ' }] })).toEqual({
      success: false,
      output: 'At least one task with a title is required.',
    })
    expect(applyTodoUpdate(run.runId, { op: 'add' })).toEqual({
      success: false,
      output: '`add` requires a non-empty `title`.',
    })
    expect(applyTodoUpdate(run.runId, { op: 'add', title: 'New task', status: 'not-a-status' })).toEqual({
      success: false,
      output: 'Invalid task status "not-a-status".',
    })
    applyTodoUpdate(run.runId, { op: 'add', title: 'New task' })
    const state = getPlanningState(run.runId)!
    expect(state.items[0]).toMatchObject({ id: '01', title: 'New task', status: 'in_progress' })
    expect(buildPlanningStateContext(state)).toContain('id=01; status=in_progress; title=New task')
    expect(buildPlanningStateContext({ ...state, items: [] })).toBeNull()
    // Update by taskId only: title stays unchanged.
    expect(applyTodoUpdate(run.runId, { op: 'update', taskId: '1', status: 'completed' }).success).toBe(true)
    expect(getPlanningState(run.runId)?.items[0]).toMatchObject({ id: '01', title: 'New task', status: 'completed' })
    // Update never falls back to creating a task.
    expect(applyTodoUpdate(run.runId, { op: 'update', taskId: '99', status: 'pending' })).toEqual({
      success: false,
      output: 'No task matches taskId "99".',
    })
    expect(applyTodoUpdate(run.runId, { op: 'clear', title: 'ambiguous' })).toEqual({
      success: false,
      output: 'Field "title" is not valid for operation "clear".',
    })
  })

  test('adds at a requested position, removes by id, and clears the list', () => {
    const run = createPlanningRun('conversation', 'Edit the plan')
    applyTodoUpdate(run.runId, {
      op: 'set',
      objective: 'Edited objective',
      tasks: [{ title: 'First' }, { title: 'Third' }],
    })

    expect(applyTodoUpdate(run.runId, { op: 'add', title: 'Second', afterTaskId: '01' }).success).toBe(true)
    expect(getPlanningState(run.runId)).toMatchObject({
      objective: 'Edited objective',
      items: [
        { id: '01', title: 'First', status: 'in_progress' },
        { id: '02', title: 'Second', status: 'pending' },
        { id: '03', title: 'Third', status: 'pending' },
      ],
    })

    expect(applyTodoUpdate(run.runId, { op: 'remove', taskId: '01' }).success).toBe(true)
    expect(getPlanningState(run.runId)?.items.map(({ id, title, status }) => ({ id, title, status }))).toEqual([
      { id: '01', title: 'Second', status: 'in_progress' },
      { id: '02', title: 'Third', status: 'pending' },
    ])
    expect(applyTodoUpdate(run.runId, { op: 'clear' }).success).toBe(true)
    expect(getPlanningState(run.runId)).toMatchObject({ items: [], currentTaskId: undefined })
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
