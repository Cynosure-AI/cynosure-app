import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getEventBus } from '../telemetry/event-bus.js'

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

export type TodoUpdateParams =
  | { tasks: Array<{ title: string; status?: PlanningTaskStatus; note?: string }>; objective?: string }
  | {
      op: 'set'
      objective?: string
      tasks: Array<{ title: string; status?: PlanningTaskStatus; note?: string }>
    }
  | { op: 'add'; title: string; status?: PlanningTaskStatus; note?: string; afterTaskId?: string }
  | { op: 'update'; taskId: string; title?: string; status?: PlanningTaskStatus; note?: string }
  | { op: 'completed'; taskId: string }
  | { op: 'remove'; taskId: string }
  | { op: 'clear' }

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

const STATE_TYPE = 'planning_state'
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
    `INSERT INTO tasks (id, conversation_id, status, definition_json, result_json, iterations, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(runId, conversationId, state.status, JSON.stringify(toDefinition(state)), null, 0, now, now, null)

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
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { success: false, output: '`tasks` must be an array.' }
  }
  const payload = params as {
    op?: string
    objective?: string
    tasks?: Array<{ title?: string; status?: string; note?: string }>
    taskId?: string
    afterTaskId?: string
    title?: string
    status?: string
    note?: string
  }
  const current = getPlanningState(runId)
  if (!current) return { success: false, output: 'Planning run not found.' }

  // Current tool calls send the complete list without an operation. Accept
  // legacy operation calls from older transcripts as well.
  if (payload.op === undefined) {
    if (!Array.isArray(payload.tasks)) return { success: false, output: '`tasks` must be an array.' }
    return payload.tasks.length === 0 ? clearTodoList(current) : setTodoList(current, payload)
  }

  switch (payload.op) {
    case 'set':
      return setTodoList(current, payload)
    case 'add':
      return addTodoItem(current, payload)
    case 'update':
      return updateTodoItem(current, payload)
    case 'completed':
      return completeTodoItem(current, payload)
    case 'remove':
      return removeTodoItem(current, payload)
    case 'clear':
      return clearTodoList(current)
    default:
      return { success: false, output: 'Invalid or missing `op`. Use set, add, update, completed, remove, or clear.' }
  }
}

function setTodoList(
  current: PlanningState,
  payload: { objective?: string; tasks?: Array<{ title?: string; status?: string; note?: string }> },
): { success: boolean; output: string } {
  if (!Array.isArray(payload.tasks) || payload.tasks.length === 0) {
    return { success: false, output: '`set` requires at least one task. Use `clear` to remove the list.' }
  }
  const invalidStatus = payload.tasks.find((task) => task.status !== undefined && !isTaskStatus(task.status))
  if (invalidStatus) return invalidTaskStatus(invalidStatus.status)

  const now = Date.now()
  const items = payload.tasks
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
    objective: cleanObjective(payload.objective || current.objective),
    items: normalizedItems,
    currentTaskId: normalizedItems.find((item) => item.status === 'in_progress')?.id,
    updatedAt: now,
  }
  persistState(state)
  emitState(state)
  return { success: true, output: JSON.stringify({ action: 'set', runId: current.runId, tasks: normalizedItems.map(({ id, title, status }) => ({ id, title, status })) }) }
}

function addTodoItem(
  current: PlanningState,
  payload: { title?: string; status?: string; note?: string; afterTaskId?: string },
): { success: boolean; output: string } {
  const title = cleanTaskTitle(payload.title)
  if (!title) return { success: false, output: '`add` requires a non-empty `title`.' }
  if (payload.status !== undefined && !isTaskStatus(payload.status)) return invalidTaskStatus(payload.status)
  if (current.items.length >= MAX_TASKS) return { success: false, output: `Planning list is limited to ${MAX_TASKS} tasks.` }

  let insertionIndex = current.items.length
  if (payload.afterTaskId !== undefined) {
    const afterIndex = findTaskIndexById(current.items, payload.afterTaskId)
    if (afterIndex === -1) return taskNotFound(payload.afterTaskId)
    insertionIndex = afterIndex + 1
  }

  const now = Date.now()
  const added: PlanningTaskItem = {
    id: formatTaskId(insertionIndex),
    title,
    status: normalizeTaskStatus(payload.status),
    note: cleanNote(payload.note),
    updatedAt: now,
  }
  const items = [...current.items]
  items.splice(insertionIndex, 0, added)
  const normalizedItems = ensureActiveTask(items, now)
  const renumberedItems = renumberTaskIds(normalizedItems)
  const state: PlanningState = {
    ...current,
    items: renumberedItems,
    currentTaskId: renumberedItems.find((item) => item.status === 'in_progress')?.id,
    updatedAt: now,
  }
  persistState(state)
  emitState(state)
  return { success: true, output: JSON.stringify({ action: 'added', task: renumberedItems[insertionIndex] }) }
}

function updateTodoItem(
  current: PlanningState,
  payload: { taskId?: string; title?: string; status?: string; note?: string },
  action: 'updated' | 'completed' = 'updated',
): { success: boolean; output: string } {
  if (!payload.taskId) return { success: false, output: '`update` requires `taskId`.' }
  const idx = findTaskIndexById(current.items, payload.taskId)
  if (idx === -1) return taskNotFound(payload.taskId)
  if (payload.title === undefined && payload.status === undefined && payload.note === undefined) {
    return { success: false, output: '`update` requires at least one of `title`, `status`, or `note`.' }
  }
  if (payload.status !== undefined && !isTaskStatus(payload.status)) return invalidTaskStatus(payload.status)
  if (payload.title !== undefined && !cleanTaskTitle(payload.title)) {
    return { success: false, output: '`title` must not be empty.' }
  }

  const now = Date.now()
  const status = payload.status === undefined ? current.items[idx].status : normalizeTaskStatus(payload.status)
  const items = current.items.map((item, itemIdx) => {
    if (itemIdx !== idx) {
      return status === 'in_progress' && item.status === 'in_progress'
        ? { ...item, status: 'pending' as const, updatedAt: now }
        : item
    }
    return {
      ...item,
      title: payload.title === undefined ? item.title : cleanTaskTitle(payload.title) || item.title,
      status,
      note: payload.note === undefined ? item.note : cleanNote(payload.note),
      updatedAt: now,
    }
  })

  const normalizedItems = advanceActiveTask(items, idx, status, now)
  const state: PlanningState = {
    ...current,
    items: normalizedItems,
    currentTaskId: normalizedItems.find((item) => item.status === 'in_progress')?.id,
    updatedAt: now,
  }
  persistState(state)
  emitState(state)
  return { success: true, output: JSON.stringify({ action, task: normalizedItems[idx] }) }
}

function completeTodoItem(
  current: PlanningState,
  payload: { taskId?: string },
): { success: boolean; output: string } {
  if (!payload.taskId) return { success: false, output: '`completed` requires `taskId`.' }
  return updateTodoItem(current, { taskId: payload.taskId, status: 'completed' }, 'completed')
}

function removeTodoItem(
  current: PlanningState,
  payload: { taskId?: string },
): { success: boolean; output: string } {
  if (!payload.taskId) return { success: false, output: '`remove` requires `taskId`.' }
  const idx = findTaskIndexById(current.items, payload.taskId)
  if (idx === -1) return taskNotFound(payload.taskId)

  const now = Date.now()
  const removed = current.items[idx]
  const items = ensureActiveTask(renumberTaskIds(current.items.filter((_, index) => index !== idx)), now)
  const state: PlanningState = {
    ...current,
    items,
    currentTaskId: items.find((item) => item.status === 'in_progress')?.id,
    updatedAt: now,
  }
  persistState(state)
  emitState(state)
  return { success: true, output: JSON.stringify({ action: 'removed', task: removed }) }
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
  const row = getDb().prepare(
    `SELECT id, conversation_id, status, definition_json, result_json, iterations, created_at, updated_at, completed_at
     FROM tasks WHERE id = ?`
  ).get(runId) as TaskRow | undefined
  return row ? fromRow(row) : null
}

function deletePlanningRun(runId: string): void {
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(runId)
}

function persistState(state: PlanningState, completed = false): void {
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

function emitState(state: PlanningState): void {
  getEventBus().emit('planning:state-updated', serializeState(state))
}

function fromRow(row: TaskRow): PlanningState | null {
  try {
    const definition = JSON.parse(row.definition_json) as {
      type?: string
      objective?: string
      items?: PlanningTaskItem[]
      currentTaskId?: string
    }
    if (definition.type !== STATE_TYPE) return null

    const result = row.result_json ? JSON.parse(row.result_json) as PlanningState['result'] : undefined
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

function toDefinition(state: PlanningState): Record<string, unknown> {
  return {
    type: STATE_TYPE,
    objective: state.objective,
    items: state.items,
    currentTaskId: state.currentTaskId,
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

function advanceActiveTask(
  items: PlanningTaskItem[],
  updatedIndex: number,
  status: PlanningTaskStatus,
  now: number,
): PlanningTaskItem[] {
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

function findTaskIndexById(items: PlanningTaskItem[], taskId: string): number {
  const normalized = normalizeTaskId(taskId)
  return items.findIndex((item) => normalized !== undefined && normalizeTaskId(item.id) === normalized)
}

function isTaskStatus(status: string): status is PlanningTaskStatus {
  return status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'blocked' || status === 'cancelled'
}

function invalidTaskStatus(status: string | undefined): { success: false; output: string } {
  return { success: false, output: `Invalid task status ${JSON.stringify(status)}.` }
}

function taskNotFound(taskId: string): { success: false; output: string } {
  return { success: false, output: `No task matches taskId ${JSON.stringify(taskId)}.` }
}

function renumberTaskIds(items: PlanningTaskItem[]): PlanningTaskItem[] {
  return items.map((item, index) => ({
    ...item,
    id: formatTaskId(index),
  }))
}

function normalizeTaskId(taskId: string | undefined): string | undefined {
  const raw = String(taskId || '').trim()
  if (!raw) return undefined
  const numeric = Number(raw)
  if (Number.isInteger(numeric) && numeric > 0 && numeric <= MAX_TASKS) {
    return formatTaskId(numeric - 1)
  }
  return raw
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
