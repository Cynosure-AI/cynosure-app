import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import {
  completeOrchestrationRunFromTool,
  setOrchestrationTasks,
  updateOrchestrationTask,
} from '../../agent/orchestration-state.js'

const ORCHESTRATION_TOOL_NAMES = new Set([
  'orchestrator_set_tasks',
  'orchestrator_update_task',
  'orchestrator_complete',
])

export const ORCHESTRATOR_SYSTEM_PROMPT = [
  '## Stateful Orchestration',
  'For complex or multi-step requests, maintain a concise visible task list with the orchestration tools.',
  'Create the list once you know the objective, mark exactly one active task as `in_progress`, update tasks as facts change, and complete or block items honestly.',
  'If a previous visible task list exists after an interruption, continue from that state instead of starting over unless the user asks for a new objective.',
  'Use these tools sparingly: for simple one-step answers, answer normally without creating a task list.',
].join('\n')

export function isOrchestrationToolName(name: string): boolean {
  return ORCHESTRATION_TOOL_NAMES.has(name)
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
            maxItems: 24,
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
      execute: async (params) => setOrchestrationTasks(runId, params),
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
      execute: async (params) => updateOrchestrationTask(runId, params),
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
      execute: async (params) => completeOrchestrationRunFromTool(runId, params),
    },
  ]
}
