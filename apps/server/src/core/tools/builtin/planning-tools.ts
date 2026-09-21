import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import { applyTodoUpdate } from '../../agent/planning-state.js'

const PLANNING_TOOL_NAMES = new Set([
  'todo_update',
])

export const PLANNING_SYSTEM_PROMPT = [
  '## Stateful Planning',
  'Maintain a concise visible task list with the planning tools when the current request benefits from visible progress tracking (like multi-step tasks or complex workflows).',
  'When a current or previous visible task list is present, treat follow-up messages as possible task-list updates: continue, replace, expand, shrink, or close the list to match the user\'s latest intent.',
  'If a follow-up message will use visible execution tools and the visible task list should change, call `todo_update` before the non-planning tools.',
  'Use exactly one explicit operation per call: `set` replaces the list, `add` inserts a task, `update` changes an existing task, `remove` deletes one task, and `clear` removes the entire list.',
  'Task ids are ordered ids such as `01`, `02`, and `03`. `update` and `remove` only accept an existing task id; they never create tasks implicitly.',
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
      name: 'todo_update',
      execution: { readOnly: false },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      description: 'Apply one explicit operation to the visible planning todo list. Use set, add, update, remove, or clear. Use only for complex or multi-step work.',
      timeout: 5_000,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: {
            type: 'string',
            enum: ['set', 'add', 'update', 'remove', 'clear'],
            description: 'Exactly one operation to perform. Required fields: set=tasks; add=title; update=taskId plus a changed field; remove=taskId; clear=none.',
          },
          objective: { type: 'string', description: 'Set only: short statement of the overall user goal.' },
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: 24,
            description: 'Set only: the complete replacement list.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', description: 'Concise task label.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'] },
                note: { type: 'string', description: 'Optional short status note.' },
              },
              required: ['title'],
            },
          },
          taskId: { type: 'string', description: 'Update/remove only: id of an existing task, such as 01.' },
          afterTaskId: { type: 'string', description: 'Add only: insert after this existing task id. Omit to append.' },
          title: { type: 'string', description: 'Add: required task title. Update: optional replacement title.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'], description: 'Add/update only: task status.' },
          note: { type: 'string', description: 'Add/update only: short status note. Pass an empty string on update to remove the note.' },
        },
        required: ['op'],
      },
      execute: async (params) => applyTodoUpdate(runId, params),
    },
  ]
}
