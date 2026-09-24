import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import { applyTodoUpdate } from '../../agent/planning-state.js'

const PLANNING_TOOL_NAMES = new Set([
  'todo_update',
])

export const PLANNING_SYSTEM_PROMPT = [
  '## Visible Todo List',
  'For multi-step work, use `todo_update` to show a concise task list and keep it current.',
  'Each call sends the entire current list in `tasks`; it replaces the previous list. Include finished tasks with status `completed`, the current task with `in_progress`, and future tasks with `pending`. Send `tasks: []` to clear the list.',
  'Create the list before using other tools when it helps track progress. Update it as work changes and finish all applicable tasks before the final answer.',
  'For simple one-step answers, skip the todo list.',
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
      description: 'Replace the visible todo list with the complete current list. Include all tasks on every call; use an empty array to clear it.',
      timeout: 5_000,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          objective: { type: 'string', description: 'Optional short statement of the overall user goal.' },
          tasks: {
            type: 'array',
            maxItems: 24,
            description: 'Complete current list, including finished and pending tasks. An empty list clears it.',
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
        },
        required: ['tasks'],
      },
      execute: async (params) => applyTodoUpdate(runId, params),
    },
  ]
}
