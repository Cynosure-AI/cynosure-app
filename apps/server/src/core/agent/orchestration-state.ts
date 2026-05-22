import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getEventBus } from '../telemetry/event-bus.js'
import type { ToolDefinition, ToolResult } from '../gateway/providers/base.provider.js'

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
const ORCHESTRATION_TOOL_NAMES = new Set([
  'orchestrator_set_tasks',
  'orchestrator_update_task',
  'orchestrator_complete',
])

export const ORCHESTRATOR_SYSTEM_PROMPT = [
  '## Stateful Orchestration',
  'For complex or multi-step requests, maintain a concise visible task list with the orchestration tools.',
  'Create the list once you know the objective, mark exactly one active task as `in_progress` when useful, update tasks as facts change, and complete or block items honestly.',
  'Use these tools sparingly: for simple one-step answers, answer normally without creating a task list.',
].join('\n')

export function isOrchestrationToolName(name: string): boolean {
  return ORCHESTRATION_TOOL_NAMES.has(name)
}

export function createOrchestrationRun(conversationId: string, objective: string): OrchestrationState {
  const db = getDb()
  const now = Date.now()
  const runId = nanoid()
  const state: OrchestrationState = {
    runId,
    conversationId,
    status: 'running',
    objective: objective.trim().slice(0, 300),
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

  const now = Date.now()
  const items = status === 'completed'
    ? completeOpenItems(current.items, now)
    : current.items
  const state: OrchestrationState = {
    ...current,
    status,
    items,
    currentTaskId: items.find((item) => item.status === 'in_progress')?.id,
    result,
    updatedAt: now,
    completedAt: now,
  }
  persistState(state, true)
  emitState(state)
  return state
}

export function makeOrchestrationTools(runId: string): ToolDefinition[] {
  return [
    {
      name: 'orchestrator_set_tasks',
      description: 'Create or replace the visible orchestration task list for this request. Use only for complex or multi-step work.',
      timeout: 5_000,
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'Short statement of the overall user goal.' },
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Concise task label.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'] },
                note: { type: 'string', description: 'Optional short status note.' },
              },
              required: ['title'],
            },
          },
        },
        required: ['objective', 'tasks'],
      },
      execute: async (params) => setTasks(runId, params),
    },
    {
      name: 'orchestrator_update_task',
      description: 'Update one visible orchestration task by taskId or exact title.',
      timeout: 5_000,
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Task id returned by orchestrator_set_tasks.' },
          title: { type: 'string', description: 'Exact task title if taskId is unavailable.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'] },
          note: { type: 'string', description: 'Optional short status note.' },
        },
        required: ['status'],
      },
      execute: async (params) => updateTask(runId, params),
    },
    {
      name: 'orchestrator_complete',
      description: 'Close the visible orchestration state when the overall request is complete.',
      timeout: 5_000,
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Short final result summary.' },
        },
      },
      execute: async (params) => completeRun(runId, params),
    },
  ]
}

function setTasks(runId: string, params: unknown): ToolResult {
  const payload = params as { objective?: string; tasks?: Array<{ title?: string; status?: string; note?: string }> }
  const current = getOrchestrationState(runId)
  if (!current) return { success: false, output: 'Orchestration run not found.' }

  const now = Date.now()
  const items = (payload.tasks || [])
    .slice(0, 12)
    .map((task) => ({
      id: nanoid(8),
      title: String(task.title || '').trim().slice(0, 120),
      status: normalizeTaskStatus(task.status),
      note: cleanNote(task.note),
      updatedAt: now,
    }))
    .filter((task) => task.title.length > 0)

  if (!items.length) return { success: false, output: 'At least one task with a title is required.' }
  const normalizedItems = ensureActiveTask(items, now)

  const state: OrchestrationState = {
    ...current,
    objective: String(payload.objective || current.objective).trim().slice(0, 300),
    items: normalizedItems,
    currentTaskId: normalizedItems.find((item) => item.status === 'in_progress')?.id,
    updatedAt: now,
  }
  persistState(state)
  emitState(state)
  return { success: true, output: JSON.stringify({ runId, tasks: normalizedItems.map(({ id, title, status }) => ({ id, title, status })) }) }
}

function updateTask(runId: string, params: unknown): ToolResult {
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
      note: cleanNote(payload.note),
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

function completeRun(runId: string, params: unknown): ToolResult {
  const payload = params as { summary?: string }
  const state = closeOrchestrationRun(runId, 'completed', { summary: cleanNote(payload.summary) })
  if (!state) return { success: false, output: 'Orchestration run not found.' }
  return { success: true, output: 'Orchestration completed.' }
}

function getOrchestrationState(runId: string): OrchestrationState | null {
  const row = getDb().prepare(
    `SELECT id, conversation_id, status, definition_json, result_json, iterations, created_at, updated_at, completed_at
     FROM tasks WHERE id = ?`
  ).get(runId) as TaskRow | undefined
  return row ? fromRow(row) : null
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

function ensureActiveTask(items: OrchestrationTaskItem[], now: number): OrchestrationTaskItem[] {
  if (items.some((item) => item.status === 'in_progress')) return items
  if (items.some((item) => item.status === 'completed')) return items
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

function completeOpenItems(items: OrchestrationTaskItem[], now: number): OrchestrationTaskItem[] {
  return items.map((item) => {
    if (item.status === 'blocked' || item.status === 'cancelled' || item.status === 'completed') return item
    return { ...item, status: 'completed', updatedAt: now }
  })
}

function cleanNote(note: string | undefined): string | undefined {
  const cleaned = String(note || '').trim().slice(0, 180)
  return cleaned || undefined
}
