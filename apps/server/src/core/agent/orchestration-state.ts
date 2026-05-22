import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getEventBus } from '../telemetry/event-bus.js'

export type OrchestrationTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled'
export type OrchestrationRunStatus = 'running' | 'completed' | 'cancelled' | 'error'

export interface OrchestrationTaskItem {
  id: string
  title: string
  status: OrchestrationTaskStatus
  note?: string
  updatedAt: number
}

export interface OrchestrationState {
  runId: string
  conversationId: string
  status: OrchestrationRunStatus
  objective: string
  items: OrchestrationTaskItem[]
  currentTaskId?: string
  result?: { summary?: string; error?: string }
  createdAt: number
  updatedAt: number
  completedAt?: number
}

interface TaskRow {
  id: string
  conversation_id: string
  status: string
  definition_json: string
  result_json: string | null
  iterations: number | null
  created_at: number
  updated_at: number | null
  completed_at: number | null
}

const STATE_TYPE = 'orchestrator_state'
const MAX_OBJECTIVE_LENGTH = 300
const MAX_TASKS = 24
const MAX_TASK_TITLE_LENGTH = 120
const MAX_NOTE_LENGTH = 180

export function createOrchestrationRun(conversationId: string, objective: string): OrchestrationState {
  const db = getDb()
  const now = Date.now()
  const runId = nanoid()
  const state: OrchestrationState = {
    runId,
    conversationId,
    status: 'running',
    objective: cleanObjective(objective),
    items: [],
    createdAt: now,
    updatedAt: now,
  }

  db.prepare(
    `INSERT INTO tasks (id, conversation_id, status, definition_json, result_json, iterations, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(runId, conversationId, state.status, JSON.stringify(toDefinition(state)), null, 0, now, now, null)

  emitState(state)
  return state
}

export function resumeOrCreateOrchestrationRun(conversationId: string, objective: string): OrchestrationState {
  const latest = getLatestOrchestrationState(conversationId)
  if (!latest || latest.status !== 'running' || latest.items.length === 0) {
    return createOrchestrationRun(conversationId, objective)
  }

  const now = Date.now()
  const items = ensureResumedTask(latest.items, now)
  const state: OrchestrationState = {
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

export function buildOrchestrationStateContext(state: OrchestrationState): string | null {
  if (!state.items.length) return null
  const lines = state.items.map((item) => {
    const note = item.note ? `; note=${item.note}` : ''
    return `- id=${item.id}; status=${item.status}; title=${item.title}${note}`
  })
  return [
    'Current visible orchestration state for this conversation:',
    `objective=${state.objective}`,
    ...lines,
    'Continue from this state. Prefer updating existing task ids over replacing the whole list unless the user changed the objective.',
  ].join('\n')
}

export function getLatestOrchestrationState(conversationId: string): OrchestrationState | null {
  const rows = getDb().prepare(
    `SELECT id, conversation_id, status, definition_json, result_json, iterations, created_at, updated_at, completed_at
     FROM tasks
     WHERE conversation_id = ?
     ORDER BY
       CASE WHEN status = 'running' THEN 0 ELSE 1 END,
       COALESCE(updated_at, created_at) DESC`
  ).all(conversationId) as TaskRow[]

  for (const row of rows) {
    const state = fromRow(row)
    if (state) return state
  }
  return null
}

export function closeOrchestrationRun(
  runId: string,
  status: Exclude<OrchestrationRunStatus, 'running'>,
  result?: { summary?: string; error?: string },
): OrchestrationState | null {
  const current = getOrchestrationState(runId)
  if (!current || current.status !== 'running') return current
  if (!current.items.length) {
    deleteOrchestrationRun(runId)
    return null
  }

  const now = Date.now()
  const items = reconcileItemsForClose(current.items, status, result?.error, now)
  const state: OrchestrationState = {
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

export function setOrchestrationTasks(runId: string, params: unknown): { success: boolean; output: string } {
  const payload = params as { objective?: string; tasks?: Array<{ title?: string; status?: string; note?: string }> }
  const current = getOrchestrationState(runId)
  if (!current) return { success: false, output: 'Orchestration run not found.' }

  const now = Date.now()
  const items = (payload.tasks || [])
    .slice(0, MAX_TASKS)
    .map((task) => ({
      id: nanoid(8),
      title: cleanTaskTitle(task.title),
      status: normalizeTaskStatus(task.status),
      note: cleanNote(task.note),
      updatedAt: now,
    }))
    .filter((task) => task.title.length > 0)

  if (!items.length) return { success: false, output: 'At least one task with a title is required.' }
  const normalizedItems = ensureActiveTask(items, now)

  const state: OrchestrationState = {
    ...current,
    objective: cleanObjective(payload.objective || current.objective),
    items: normalizedItems,
    currentTaskId: normalizedItems.find((item) => item.status === 'in_progress')?.id,
    updatedAt: now,
  }
  persistState(state)
  emitState(state)
  return { success: true, output: JSON.stringify({ runId, tasks: normalizedItems.map(({ id, title, status }) => ({ id, title, status })) }) }
}

export function updateOrchestrationTask(runId: string, params: unknown): { success: boolean; output: string } {
  const payload = params as { taskId?: string; title?: string; status?: string; note?: string }
  const current = getOrchestrationState(runId)
  if (!current) return { success: false, output: 'Orchestration run not found.' }
  if (!current.items.length) return { success: false, output: 'No orchestration tasks have been set.' }

  const idx = current.items.findIndex((item) => (
    (payload.taskId && item.id === payload.taskId) ||
    (payload.title && item.title.toLowerCase() === payload.title.trim().toLowerCase())
  ))
  if (idx === -1) return { success: false, output: 'Task not found. Use taskId from orchestrator_set_tasks or the exact title.' }

  const now = Date.now()
  const status = normalizeTaskStatus(payload.status)
  const items = current.items.map((item, itemIdx) => {
    if (itemIdx !== idx) {
      return status === 'in_progress' && item.status === 'in_progress'
        ? { ...item, status: 'pending' as const, updatedAt: now }
        : item
    }
    return {
      ...item,
      status,
      note: payload.note === undefined ? item.note : cleanNote(payload.note),
      updatedAt: now,
    }
  })

  const normalizedItems = advanceActiveTask(items, idx, status, now)
  const state: OrchestrationState = {
    ...current,
    items: normalizedItems,
    currentTaskId: normalizedItems.find((item) => item.status === 'in_progress')?.id,
    updatedAt: now,
  }
  persistState(state)
  emitState(state)
  return { success: true, output: JSON.stringify({ task: normalizedItems[idx] }) }
}

export function completeOrchestrationRunFromTool(runId: string, params: unknown): { success: boolean; output: string } {
  const payload = params as { summary?: string }
  const state = closeOrchestrationRun(runId, 'completed', { summary: cleanNote(payload.summary) })
  if (!state) return { success: false, output: 'Orchestration run not found.' }
  return { success: true, output: 'Orchestration completed.' }
}

export function reconcileOrchestrationAfterToolBatch(
  runId: string,
  result: { success: boolean; note?: string },
): OrchestrationState | null {
  const current = getOrchestrationState(runId)
  if (!current || current.status !== 'running') return current

  const activeIndex = current.items.findIndex((item) => item.status === 'in_progress')
  if (activeIndex === -1) return current

  const now = Date.now()
  const activeStatus: OrchestrationTaskStatus = result.success ? 'completed' : 'blocked'
  const items = current.items.map((item, index) => (
    index === activeIndex
      ? { ...item, status: activeStatus, note: cleanNote(result.note) ?? item.note, updatedAt: now }
      : item
  ))
  const normalizedItems = advanceActiveTask(items, activeIndex, activeStatus, now)

  const state: OrchestrationState = {
    ...current,
    items: normalizedItems,
    currentTaskId: normalizedItems.find((item) => item.status === 'in_progress')?.id,
    updatedAt: now,
  }
  persistState(state)
  emitState(state)
  return state
}

export function ensureOrchestrationStarted(runId: string, title: string): OrchestrationState | null {
  const current = getOrchestrationState(runId)
  if (!current || current.status !== 'running' || current.items.length > 0) return current

  const now = Date.now()
  const item: OrchestrationTaskItem = {
    id: nanoid(8),
    title: title.trim().slice(0, 120) || 'Work through request',
    status: 'in_progress',
    note: 'Started from tool execution.',
    updatedAt: now,
  }
  const state: OrchestrationState = {
    ...current,
    items: [item],
    currentTaskId: item.id,
    updatedAt: now,
  }
  persistState(state)
  emitState(state)
  return state
}

function getOrchestrationState(runId: string): OrchestrationState | null {
  const row = getDb().prepare(
    `SELECT id, conversation_id, status, definition_json, result_json, iterations, created_at, updated_at, completed_at
     FROM tasks WHERE id = ?`
  ).get(runId) as TaskRow | undefined
  return row ? fromRow(row) : null
}

function deleteOrchestrationRun(runId: string): void {
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(runId)
}

function persistState(state: OrchestrationState, completed = false): void {
  getDb().prepare(
    `UPDATE tasks
     SET status = ?, definition_json = ?, result_json = ?, iterations = ?, updated_at = ?, completed_at = ?
     WHERE id = ?`
  ).run(
    state.status,
    JSON.stringify(toDefinition(state)),
    state.result ? JSON.stringify(state.result) : null,
    state.items.filter((item) => item.status === 'completed').length,
    state.updatedAt,
    completed ? state.completedAt ?? state.updatedAt : state.completedAt ?? null,
    state.runId,
  )
}

function emitState(state: OrchestrationState): void {
  getEventBus().emit('orchestrator:state-updated', serializeState(state))
}

function fromRow(row: TaskRow): OrchestrationState | null {
  try {
    const definition = JSON.parse(row.definition_json) as {
      type?: string
      objective?: string
      items?: OrchestrationTaskItem[]
      currentTaskId?: string
    }
    if (definition.type !== STATE_TYPE) return null

    const result = row.result_json ? JSON.parse(row.result_json) as OrchestrationState['result'] : undefined
    return {
      runId: row.id,
      conversationId: row.conversation_id,
      status: normalizeRunStatus(row.status),
      objective: definition.objective || '',
      items: Array.isArray(definition.items) ? definition.items : [],
      currentTaskId: definition.currentTaskId,
      result,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
      completedAt: row.completed_at ?? undefined,
    }
  } catch {
    return null
  }
}

function toDefinition(state: OrchestrationState): Record<string, unknown> {
  return {
    type: STATE_TYPE,
    objective: state.objective,
    items: state.items,
    currentTaskId: state.currentTaskId,
  }
}

function serializeState(state: OrchestrationState): OrchestrationState {
  return {
    ...state,
    items: state.items.map((item) => ({ ...item })),
    result: state.result ? { ...state.result } : undefined,
  }
}

function normalizeTaskStatus(status: string | undefined): OrchestrationTaskStatus {
  if (status === 'in_progress' || status === 'completed' || status === 'blocked' || status === 'cancelled') return status
  return 'pending'
}

function normalizeRunStatus(status: string): OrchestrationRunStatus {
  if (status === 'completed' || status === 'cancelled' || status === 'error') return status
  return 'running'
}

function ensureResumedTask(items: OrchestrationTaskItem[], now: number): OrchestrationTaskItem[] {
  if (items.some((item) => item.status === 'in_progress')) return items
  const firstOpen = items.findIndex((item) => item.status !== 'completed')
  if (firstOpen === -1) return items
  return items.map((item, index) => (
    index === firstOpen
      ? { ...item, status: 'in_progress', note: item.status === 'pending' ? item.note : 'Resumed after interruption.', updatedAt: now }
      : item
  ))
}

function ensureActiveTask(items: OrchestrationTaskItem[], now: number): OrchestrationTaskItem[] {
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

function advanceActiveTask(
  items: OrchestrationTaskItem[],
  updatedIndex: number,
  status: OrchestrationTaskStatus,
  now: number,
): OrchestrationTaskItem[] {
  if (status === 'in_progress') return items
  if (status !== 'completed' && status !== 'blocked' && status !== 'cancelled') return items
  if (items.some((item) => item.status === 'in_progress')) return items

  const nextPending = items.findIndex((item, index) => index > updatedIndex && item.status === 'pending')
  if (nextPending === -1) return items
  return items.map((item, index) => (
    index === nextPending ? { ...item, status: 'in_progress', updatedAt: now } : item
  ))
}

function reconcileItemsForClose(
  items: OrchestrationTaskItem[],
  status: Exclude<OrchestrationRunStatus, 'running'>,
  error: string | undefined,
  now: number,
): OrchestrationTaskItem[] {
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
