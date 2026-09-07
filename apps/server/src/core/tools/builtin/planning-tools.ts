import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import {
  writeTodoList,
  upsertTodoItem,
} from '../../agent/planning-state.js'

const PLANNING_TOOL_NAMES = new Set([
  'todo_write',
  // Legacy alias kept for backwards compatibility with persisted tool policies.
  'todo_upsert',
])

export const PLANNING_SYSTEM_PROMPT = [
  '## Stateful Planning',
  'Maintain a concise visible task list with the planning tools when the current request benefits from visible progress tracking (like multi-step tasks or complex workflows).',
  'When a current or previous visible task list is present, treat follow-up messages as possible task-list updates: continue, replace, expand, shrink, or close the list to match the user\'s latest intent.',
  'If a follow-up message will use visible execution tools and the visible task list should change, call `todo_write` before the non-planning tools.',
  'Task ids are stable ordered ids such as `01`, `02`, and `03`. Pass `tasks` to replace the whole list, or a single `taskId` + `status` to update one existing item (or append it if no match exists).',
  'If a completed previous list no longer matches the current request, create a new list for the current request instead of continuing to show the old one.',
  'Create the list once you know the objective, mark exactly one active task as `in_progress`, update tasks as facts change, and mark every item `completed`, `blocked`, or `cancelled` when the work is done.',
  'Use these tools sparingly: for simple one-step answers, answer normally without creating a task list.',
].join('\n')

export function isPlanningToolName(name: string): boolean {
  return PLANNING_TOOL_NAMES.has(name)
}

export function makePlanningTools(runId: string): ToolDefinition[] {
  return [
    {
      name: 'todo_write',
      execution: { readOnly: false },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description: 'Create, replace, or update the visible planning todo list for this request. Pass `tasks` to replace the whole list; pass a single `taskId` + `status` to update one item by id (or append it if no match exists). Use only for complex or multi-step work.',
      timeout: 5_000,
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'Short statement of the overall user goal. Used when replacing the list.' },
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: 24,
            description: 'Provide to replace the entire list. Omit to update or append a single item via taskId/status.',
            items: {
              type: 'object',
              properties: {
                taskId: { type: 'string', description: 'Optional ordered task id such as 01, 02, 03. Usually omit and let the server assign ids from list order.' },
                title: { type: 'string', description: 'Concise task label.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'] },
                note: { type: 'string', description: 'Optional short status note.' },
              },
              required: ['title'],
            },
          },
          taskId: { type: 'string', description: 'Single-item mode: id of the task to update, such as 01, 02, 03. If no task matches, a new one is appended.' },
          title: { type: 'string', description: 'Single-item mode: optional new title for the task. Required only when appending a task that does not exist yet.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'], description: 'Single-item mode: new status for the task.' },
          note: { type: 'string', description: 'Single-item mode: optional short status note.' },
        },
      },
      execute: async (params) => {
        const payload = params as { tasks?: unknown; taskId?: string; title?: string; status?: string }
        if (Array.isArray(payload.tasks) && payload.tasks.length > 0) return writeTodoList(runId, params)
        if (payload.taskId || payload.title || payload.status) return upsertTodoItem(runId, params)
        return { success: false, output: 'Provide either `tasks` (replace the whole list) or `taskId` + `status` (update or append a single item).' }
      },
    },
  ]
}
