import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getEventBus } from '../telemetry/event-bus.js'
import type { ProjectTaskProgress } from '@shared/types'

export type PlanningTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled'
export type PlanningRunStatus = 'running' | 'completed' | 'cancelled' | 'error'

export interface PlanningTaskItem {
  id: string
  title: string
  status: PlanningTaskStatus
  note?: string
  updatedAt: number
}

export interface PlanningState {
  runId: string
  conversationId: string
  status: PlanningRunStatus
  objective: string
  items: PlanningTaskItem[]
  currentTaskId?: string
  result?: { summary?: string; error?: string }
  createdAt: number
  updatedAt: number
  completedAt?: number
}

interface PlanRow {
  id: string
  conversation_id: string
  status: string
  objective: string
  items_json: string
  current_item_id: string | null
  result_json: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

const PLAN_COLUMNS = 'id, conversation_id, status, objective, items_json, current_item_id, result_json, created_at, updated_at, completed_at'
const MAX_OBJECTIVE_LENGTH = 300
const MAX_TASKS = 24
const MAX_TASK_TITLE_LENGTH = 120
const MAX_NOTE_LENGTH = 180

export function createPlanningRun(conversationId: string, objective: string): PlanningState {
  const db = getDb()
  const now = Date.now()
  const runId = nanoid()
  const state: PlanningState = {
    runId,
    conversationId,
    status: 'running',
    objective: cleanObjective(objective),
    items: [],
    createdAt: now,
    updatedAt: now,
  }

  db.prepare(
    `INSERT INTO run_plans (id, conversation_id, status, objective, items_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(runId, conversationId, state.status, state.objective, '[]', now, now)

  return state
}

export function resumeOrCreatePlanningRun(conversationId: string, objective: string): PlanningState {
  const latest = getLatestPlanningState(conversationId)
  if (!latest || latest.items.length === 0) {
    return createPlanningRun(conversationId, objective)
  }

  if (latest.status !== 'running') {
    const seeded = createPlanningRun(conversationId, latest.objective || objective)
    const now = Date.now()
    const items = renumberTaskIds(latest.items).map((item) => ({
      ...item,
      updatedAt: now,
    }))
    const state: PlanningState = {
      ...seeded,
      objective: latest.objective || cleanObjective(objective),
      items,
      currentTaskId: items.find((item) => item.status === 'in_progress')?.id,
      updatedAt: now,
    }
    persistState(state)
    emitState(state)
    return state
  }

  const now = Date.now()
  const items = ensureResumedTask(renumberTaskIds(latest.items), now)
  const state: PlanningState = {
    ...latest,
    status: 'running',
    objective: latest.objective || cleanObjective(objective),
    items,
    currentTaskId: items.find((item) => item.status === 'in_progress')?.id,
    result: undefined,
    updatedAt: now,
    completedAt: undefined,
  }
  persistState(state)
  emitState(state)
  return state
}

export function buildPlanningStateContext(state: PlanningState): string | null {
  if (!state.items.length) return null
  const lines = state.items.map((item) => {
    const note = item.note ? `; note=${item.note}` : ''
    return `- id=${item.id}; status=${item.status}; title=${item.title}${note}`
  })
  return [
    'Current visible planning todo list for this conversation:',
    `objective=${state.objective}`,
    ...lines,
    'To change this list, call todo_update with the complete current tasks array. Keep completed tasks in the array.',
  ].join('\n')
}

export function getLatestPlanningState(conversationId: string): PlanningState | null {
  const rows = getDb().prepare(
    `SELECT ${PLAN_COLUMNS}
     FROM run_plans
     WHERE conversation_id = ?
     ORDER BY
       CASE WHEN status = 'running' THEN 0 ELSE 1 END,
       updated_at DESC`
  ).all(conversationId) as PlanRow[]

  for (const row of rows) {
    const state = fromRow(row)
    if (state) return state
  }
  return null
}

export function closePlanningRun(
  runId: string,
  status: Exclude<PlanningRunStatus, 'running'>,
  result?: { summary?: string; error?: string },
): PlanningState | null {
  const current = getPlanningState(runId)
  if (!current || current.status !== 'running') return current
  if (!current.items.length) {
    deletePlanningRun(runId)
    return null
  }

  const now = Date.now()
  if (status === 'completed' && hasOpenItems(current.items)) {
    const state: PlanningState = {
      ...current,
      status: 'running',
      result,
      updatedAt: now,
    }
    persistState(state)
    emitState(state)
    return state
  }

  const items = reconcileItemsForClose(current.items, status, result?.error, now)
  const state: PlanningState = {
    ...current,
    status,
    items,
    currentTaskId: undefined,
    result,
    updatedAt: now,
    completedAt: now,
  }
  persistState(state, true)
  emitState(state)
  return state
}

export function interruptPlanningRun(
  runId: string,
  result?: { summary?: string; error?: string },
): PlanningState | null {
  const current = getPlanningState(runId)
  if (!current || current.status !== 'running') return current
  if (!current.items.length) return current

  const now = Date.now()
  const state: PlanningState = {
    ...current,
    status: 'running',
    items: noteActiveItem(current.items, result?.error || 'Interrupted before completion.', now),
    result,
    updatedAt: now,
    completedAt: undefined,
  }
  persistState(state)
  emitState(state)
  return state
}

export function applyTodoUpdate(runId: string, params: unknown): { success: boolean; output: string } {
  const payload = (params && typeof params === 'object' && !Array.isArray(params) ? params : {}) as {
    objective?: string
    tasks?: Array<{ title?: string; status?: string; note?: string }>
  }
  if (!Array.isArray(payload.tasks)) return { success: false, output: '`tasks` must be an array.' }
  const current = getPlanningState(runId)
  if (!current) return { success: false, output: 'Planning run not found.' }
  return payload.tasks.length === 0 ? clearTodoList(current) : setTodoList(current, payload.tasks, payload.objective)
}

function setTodoList(
  current: PlanningState,
  tasks: Array<{ title?: string; status?: string; note?: string }>,
  objective: string | undefined,
): { success: boolean; output: string } {
  const invalidStatus = tasks.find((task) => task.status !== undefined && !isTaskStatus(task.status))
  if (invalidStatus) return { success: false, output: `Invalid task status ${JSON.stringify(invalidStatus.status)}.` }

  const now = Date.now()
  const items = tasks
    .slice(0, MAX_TASKS)
    .map((task, index) => ({
      id: formatTaskId(index),
      title: cleanTaskTitle(task.title),
      status: normalizeTaskStatus(task.status),
      note: cleanNote(task.note),
      updatedAt: now,
    }))
    .filter((task) => task.title.length > 0)

  if (!items.length) return { success: false, output: 'At least one task with a title is required.' }
  const normalizedItems = ensureActiveTask(renumberTaskIds(items), now)

  const state: PlanningState = {
    ...current,
    objective: cleanObjective(objective || current.objective),
    items: normalizedItems,
    currentTaskId: normalizedItems.find((item) => item.status === 'in_progress')?.id,
    updatedAt: now,
  }
  persistState(state)
  emitState(state)
  return { success: true, output: JSON.stringify({ action: 'set', runId: current.runId, tasks: normalizedItems.map(({ id, title, status }) => ({ id, title, status })) }) }
}

function clearTodoList(current: PlanningState): { success: boolean; output: string } {
  const state: PlanningState = {
    ...current,
    items: [],
    currentTaskId: undefined,
    updatedAt: Date.now(),
  }
  persistState(state)
  emitState(state)
  return { success: true, output: JSON.stringify({ action: 'cleared', runId: current.runId }) }
}

export function getPlanningState(runId: string): PlanningState | null {
  const row = getDb().prepare(`SELECT ${PLAN_COLUMNS} FROM run_plans WHERE id = ?`).get(runId) as PlanRow | undefined
  return row ? fromRow(row) : null
}

/**
 * Record that the conversation's running plan works on a project task, so the
 * plan becomes part of that task's work log. No-op when no plan is running.
 */
export function linkRunningPlanToProjectTask(conversationId: string, projectTaskId: string): void {
  const db = getDb()
  const plan = db.prepare(
    `SELECT id FROM run_plans WHERE conversation_id = ? AND status = 'running' ORDER BY updated_at DESC LIMIT 1`
  ).get(conversationId) as { id: string } | undefined
  if (!plan) return
  db.prepare('INSERT OR IGNORE INTO run_plan_project_tasks (plan_id, project_task_id, linked_at) VALUES (?, ?, ?)')
    .run(plan.id, projectTaskId, Date.now())
}

/** Plans that worked on a project task, newest first: the task's work log. */
export function listProjectTaskPlans(projectTaskId: string): PlanningState[] {
  const rows = getDb().prepare(
    `SELECT ${PLAN_COLUMNS.split(', ').map((column) => `p.${column}`).join(', ')}
     FROM run_plans p
     JOIN run_plan_project_tasks l ON l.plan_id = p.id
     WHERE l.project_task_id = ?
     ORDER BY p.created_at DESC`
  ).all(projectTaskId) as PlanRow[]
  return rows.map(fromRow).filter((state): state is PlanningState => state !== null)
}

/** Step counts of the newest plan that worked on each of a project's tasks, keyed by task id. */
export function listProjectTaskProgress(projectId: string): Map<string, ProjectTaskProgress> {
  const rows = getDb().prepare(
    `SELECT l.project_task_id AS task_id, ${PLAN_COLUMNS.split(', ').map((column) => `p.${column}`).join(', ')}
     FROM run_plans p
     JOIN run_plan_project_tasks l ON l.plan_id = p.id
     JOIN project_tasks t ON t.id = l.project_task_id
     WHERE t.project_id = ?
     ORDER BY p.created_at DESC`
  ).all(projectId) as Array<PlanRow & { task_id: string }>
  const progress = new Map<string, ProjectTaskProgress>()
  for (const row of rows) {
    if (progress.has(row.task_id)) continue
    const plan = fromRow(row)
    if (!plan) continue
    progress.set(row.task_id, {
      runId: plan.runId,
      status: plan.status,
      completed: plan.items.filter((item) => item.status === 'completed').length,
      total: plan.items.length,
    })
  }
  return progress
}

function deletePlanningRun(runId: string): void {
  getDb().prepare('DELETE FROM run_plans WHERE id = ?').run(runId)
}

function persistState(state: PlanningState, completed = false): void {
  getDb().prepare(
    `UPDATE run_plans
     SET status = ?, objective = ?, items_json = ?, current_item_id = ?, result_json = ?, updated_at = ?, completed_at = ?
     WHERE id = ?`
  ).run(
    state.status,
    state.objective,
    JSON.stringify(state.items),
    state.currentTaskId ?? null,
    state.result ? JSON.stringify(state.result) : null,
    state.updatedAt,
    completed ? state.completedAt ?? state.updatedAt : state.completedAt ?? null,
    state.runId,
  )
}

function emitState(state: PlanningState): void {
  getEventBus().emit('planning:state-updated', serializeState(state))
}

function fromRow(row: PlanRow): PlanningState | null {
  try {
    const items = JSON.parse(row.items_json) as unknown
    const result = row.result_json ? JSON.parse(row.result_json) as PlanningState['result'] : undefined
    return {
      runId: row.id,
      conversationId: row.conversation_id,
      status: normalizeRunStatus(row.status),
      objective: row.objective,
      items: Array.isArray(items) ? items as PlanningTaskItem[] : [],
      currentTaskId: row.current_item_id ?? undefined,
      result,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined,
    }
  } catch {
    return null
  }
}

function serializeState(state: PlanningState): PlanningState {
  return {
    ...state,
    items: state.items.map((item) => ({ ...item })),
    result: state.result ? { ...state.result } : undefined,
  }
}

function normalizeTaskStatus(status: string | undefined): PlanningTaskStatus {
  if (status === 'in_progress' || status === 'completed' || status === 'blocked' || status === 'cancelled') return status
  return 'pending'
}

function normalizeRunStatus(status: string): PlanningRunStatus {
  if (status === 'completed' || status === 'cancelled' || status === 'error') return status
  return 'running'
}

function ensureResumedTask(items: PlanningTaskItem[], now: number): PlanningTaskItem[] {
  if (items.some((item) => item.status === 'in_progress')) return items
  const firstOpen = items.findIndex((item) => item.status !== 'completed')
  if (firstOpen === -1) return items
  return items.map((item, index) => (
    index === firstOpen
      ? { ...item, status: 'in_progress', note: item.status === 'pending' ? item.note : 'Resumed after interruption.', updatedAt: now }
      : item
  ))
}

function ensureActiveTask(items: PlanningTaskItem[], now: number): PlanningTaskItem[] {
  const activeIndex = items.findIndex((item) => item.status === 'in_progress')
  if (activeIndex !== -1) {
    return items.map((item, index) => (
      index !== activeIndex && item.status === 'in_progress'
        ? { ...item, status: 'pending', updatedAt: now }
        : item
    ))
  }

  const firstPending = items.findIndex((item) => item.status === 'pending')
  if (firstPending === -1) return items
  return items.map((item, index) => (
    index === firstPending ? { ...item, status: 'in_progress', updatedAt: now } : item
  ))
}

function reconcileItemsForClose(
  items: PlanningTaskItem[],
  status: Exclude<PlanningRunStatus, 'running'>,
  error: string | undefined,
  now: number,
): PlanningTaskItem[] {
  if (status === 'completed') {
    return items.map((item) => (
      item.status === 'in_progress'
        ? { ...item, status: 'completed', updatedAt: now }
        : item
    ))
  }

  if (status === 'cancelled') {
    return items.map((item) => (
      item.status === 'in_progress'
        ? { ...item, status: 'cancelled', note: 'Cancelled by user.', updatedAt: now }
        : item
    ))
  }

  return items.map((item) => (
    item.status === 'in_progress'
      ? { ...item, status: 'blocked', note: cleanNote(error) || 'Stopped before completion.', updatedAt: now }
      : item
  ))
}

function hasOpenItems(items: PlanningTaskItem[]): boolean {
  return items.some((item) => item.status === 'pending' || item.status === 'in_progress')
}

function noteActiveItem(items: PlanningTaskItem[], note: string, now: number): PlanningTaskItem[] {
  return items.map((item) => (
    item.status === 'in_progress'
      ? { ...item, note: cleanNote(note) ?? item.note, updatedAt: now }
      : item
  ))
}

function isTaskStatus(status: string): status is PlanningTaskStatus {
  return status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'blocked' || status === 'cancelled'
}

function renumberTaskIds(items: PlanningTaskItem[]): PlanningTaskItem[] {
  return items.map((item, index) => ({
    ...item,
    id: formatTaskId(index),
  }))
}

function formatTaskId(index: number): string {
  return String(index + 1).padStart(2, '0')
}

function cleanNote(note: string | undefined): string | undefined {
  const cleaned = String(note || '').trim().slice(0, MAX_NOTE_LENGTH)
  return cleaned || undefined
}

function cleanObjective(objective: string | undefined): string {
  return String(objective || '').trim().slice(0, MAX_OBJECTIVE_LENGTH)
}

function cleanTaskTitle(title: string | undefined): string {
  return String(title || '').trim().slice(0, MAX_TASK_TITLE_LENGTH)
}
