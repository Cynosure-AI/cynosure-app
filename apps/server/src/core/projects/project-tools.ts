import type { ToolDefinition, ToolResult } from '../gateway/providers/base.provider.js'
import type { ProjectTaskStatus } from '@shared/types'
import {
    BriefConflictError,
    MAX_PROJECT_BRIEF_CHARS,
    PROJECT_TASK_STATUSES,
    createProjectTask,
    getProject,
    listProjectTasks,
    setProjectBrief,
    updateProjectTask,
} from './project-store.js'

type BroadcastFn = (event: string, data: unknown) => void

export const PROJECT_TOOL_NAMES = ['project_brief_update', 'project_task_list', 'project_task_create', 'project_task_update'] as const

export function isProjectToolName(name: string): boolean {
    return (PROJECT_TOOL_NAMES as readonly string[]).includes(name)
}

export interface ProjectToolContext {
    projectId: string
    conversationId?: string
    /** Agent making the change, recorded in the project timeline. */
    agentId?: string
    /** Recorded change source; tools in chats are 'ai', Dream review is 'dream'. */
    source?: 'ai' | 'dream'
    broadcast?: BroadcastFn
    /**
     * The brief shown to the model when the run started. Brief updates are
     * rejected when the stored brief has changed since, so a stale view never
     * silently overwrites another chat's, Dream's, or the user's edit.
     */
    seenBrief?: string
}

function changeContext(ctx: ProjectToolContext) {
    return { source: ctx.source ?? 'ai', conversationId: ctx.conversationId, agentId: ctx.agentId } as const
}

function result(success: boolean, output: unknown): ToolResult {
    return { success, output: typeof output === 'string' ? output : JSON.stringify(output) }
}

function guarded(run: () => ToolResult): Promise<ToolResult> {
    try {
        return Promise.resolve(run())
    } catch (error) {
        return Promise.resolve(result(false, `Error: ${(error as Error).message}`))
    }
}

export function makeProjectBriefTool(ctx: ProjectToolContext): ToolDefinition {
    // Advances with each write the model sees, so later calls in the run compare against it.
    let seenBrief = ctx.seenBrief
    return {
        name: 'project_brief_update',
        description: `Replace the project brief: the short, always-loaded summary that every chat and agent in this project starts from. Send the complete new brief (Markdown, at most ${MAX_PROJECT_BRIEF_CHARS} characters) covering the goal, current state, key decisions, and open questions. Update it after meaningful progress or decisions; do not log routine chatter or keep a change history. If the brief changed since you saw it, the update is rejected and the current brief is returned; merge your changes into that version and call again.`,
        timeout: 5_000,
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['brief'],
            properties: {
                brief: { type: 'string', maxLength: MAX_PROJECT_BRIEF_CHARS, description: 'Complete replacement brief.' },
            },
        },
        execute: (params) => guarded(() => {
            const { brief } = params as { brief?: unknown }
            if (typeof brief !== 'string') return result(false, 'brief must be a string.')
            try {
                const project = setProjectBrief(ctx.projectId, brief.trim(), changeContext(ctx), seenBrief)
                if (!project) return result(false, 'Project no longer exists.')
                if (seenBrief !== undefined) seenBrief = project.brief
                ctx.broadcast?.('project:updated', { id: project.id })
                return result(true, `Updated the brief for "${project.name}".`)
            } catch (error) {
                if (!(error instanceof BriefConflictError)) throw error
                seenBrief = error.currentBrief
                return result(false, [
                    'The brief was not saved: another chat, Dream, or the user changed it since you last saw it. Current brief:',
                    '',
                    error.currentBrief || '(empty)',
                    '',
                    'Keep what is still true in it, add your changes, and call project_brief_update again with the merged brief.',
                ].join('\n'))
            }
        }),
    }
}

export function makeProjectTaskTools(ctx: ProjectToolContext): ToolDefinition[] {
    const notifyTasks = () => ctx.broadcast?.('project:tasks-updated', { projectId: ctx.projectId })
    const statusSchema = { type: 'string', enum: [...PROJECT_TASK_STATUSES] }
    return [
        {
            name: 'project_task_list',
            description: 'List tasks on the project board. Defaults to tasks that are not done.',
            timeout: 5_000,
            execution: { readOnly: true },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    statuses: { type: 'array', items: statusSchema, description: 'Statuses to include. Omit for todo, in_progress, and blocked.' },
                },
            },
            execute: (params) => guarded(() => {
                const { statuses } = (params ?? {}) as { statuses?: ProjectTaskStatus[] }
                const tasks = listProjectTasks(ctx.projectId, { statuses: statuses?.length ? statuses : ['todo', 'in_progress', 'blocked'] })
                return result(true, tasks.map(({ id, title, status, notes, assigneeAgentId }) => ({ id, title, status, notes, assigneeAgentId })))
            }),
        },
        {
            name: 'project_task_create',
            description: 'Add a task to the project board so it can be picked up later, by you, another agent, or the user.',
            timeout: 5_000,
            execution: { readOnly: false },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['title'],
                properties: {
                    title: { type: 'string', minLength: 1, maxLength: 200 },
                    notes: { type: 'string', maxLength: 4000, description: 'Context needed to do the task without this conversation.' },
                    status: statusSchema,
                },
            },
            execute: (params) => guarded(() => {
                const input = params as { title: string; notes?: string; status?: ProjectTaskStatus }
                const task = createProjectTask(ctx.projectId, { ...input, conversationId: ctx.conversationId, createdBy: 'agent' }, changeContext(ctx))
                notifyTasks()
                return result(true, { id: task.id, title: task.title, status: task.status })
            }),
        },
        {
            name: 'project_task_update',
            description: 'Update a project task: move it between statuses, rename it, or replace its notes. Set in_progress when you start, done when finished, blocked with a note explaining why.',
            timeout: 5_000,
            execution: { readOnly: false },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['taskId'],
                properties: {
                    taskId: { type: 'string' },
                    title: { type: 'string', minLength: 1, maxLength: 200 },
                    notes: { type: 'string', maxLength: 4000 },
                    status: statusSchema,
                },
            },
            execute: (params) => guarded(() => {
                const { taskId, ...input } = params as { taskId: string; title?: string; notes?: string; status?: ProjectTaskStatus }
                const task = updateProjectTask(ctx.projectId, taskId, {
                    ...input,
                    ...(input.status === 'in_progress' && ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
                }, changeContext(ctx))
                if (!task) return result(false, `Task ${taskId} was not found in this project.`)
                notifyTasks()
                return result(true, { id: task.id, title: task.title, status: task.status })
            }),
        },
    ]
}

export function makeProjectTools(ctx: ProjectToolContext): ToolDefinition[] {
    if (!getProject(ctx.projectId)) return []
    return [makeProjectBriefTool(ctx), ...makeProjectTaskTools(ctx)]
}
