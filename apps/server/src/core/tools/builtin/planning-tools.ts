import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import {
  writeTodoList,
  upsertTodoItem,
} from '../../agent/planning-state.js'

const PLANNING_TOOL_NAMES = new Set([
  'todo_write',
  'todo_upsert',
])

export const PLANNING_SYSTEM_PROMPT = [
  '## Stateful Planning',
  'Maintain a concise visible task list with the planning tools when the current request benefits from visible progress tracking (like multi-step tasks or complex workflows).',
  'When a current or previous visible task list is present, treat follow-up messages as possible task-list updates: continue, replace, expand, shrink, or close the list to match the user\'s latest intent.',
  'If a follow-up message will use visible execution tools and the visible task list should change, call `todo_write` or `todo_upsert` before the non-planning tools.',
  'Task ids are stable ordered ids such as `01`, `02`, and `03`. Use `todo_upsert` when updating an existing item or adding a new item to an existing list.',
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
      description: 'Create or replace the visible planning todo list for this request. Use only for complex or multi-step work.',
      timeout: 5_000,
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'Short statement of the overall user goal.' },
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: 24,
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
        },
        required: ['objective', 'tasks'],
      },
      execute: async (params) => writeTodoList(runId, params),
    },
    {
      name: 'todo_upsert',
      execution: { readOnly: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: 'Update an existing visible planning todo item by taskId/title, or append it as a new ordered item if no match exists.',
      timeout: 5_000,
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Optional ordered task id such as 01, 02, 03. If omitted and no title matches, a new id is assigned.' },
          title: { type: 'string', description: 'Task title to update or append.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'] },
          note: { type: 'string', description: 'Optional short status note.' },
        },
        required: ['title', 'status'],
      },
      execute: async (params) => upsertTodoItem(runId, params),
    },
  ]
}
