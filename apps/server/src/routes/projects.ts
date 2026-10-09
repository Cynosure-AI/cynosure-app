import type { FastifyInstance } from 'fastify'
import {
    createProject,
    createProjectTask,
    deleteProject,
    deleteProjectTask,
    getProject,
    listProjects,
    listProjectTasks,
    reorderProjects,
    updateProject,
    updateProjectTask,
    type CreateProjectInput,
    type ProjectTaskInput,
    type UpdateProjectInput,
} from '../core/projects/project-store.js'
import type { ProjectTaskStatus } from '@shared/types'

type BroadcastFn = (event: string, data: unknown) => void

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

export async function registerProjectRoutes(app: FastifyInstance, broadcast: BroadcastFn): Promise<void> {
    const projectChanged = (id: string) => broadcast('project:updated', { id })
    const tasksChanged = (projectId: string) => broadcast('project:tasks-updated', { projectId })

    // GET /api/projects — list projects with conversation and open-task counts
    app.get<{ Querystring: { includeArchived?: string } }>('/', async (req) => (
        listProjects({ includeArchived: req.query.includeArchived === '1' || req.query.includeArchived === 'true' })
    ))

    // POST /api/projects — create; a Projects/<name> memory folder is created unless one is given
    app.post<{ Body: CreateProjectInput }>('/', async (req, reply) => {
        try {
            const project = createProject(req.body ?? { name: '' })
            projectChanged(project.id)
            return project
        } catch (error) {
            return reply.status(400).send({ error: message(error) })
        }
    })

    // PUT /api/projects/reorder — persist sidebar order
    app.put<{ Body: { ids: string[] } }>('/reorder', async (req, reply) => {
        if (!Array.isArray(req.body?.ids)) return reply.status(400).send({ error: 'ids must be an array' })
        reorderProjects(req.body.ids)
        return { success: true }
    })

    app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
        const project = getProject(req.params.id)
        return project ?? reply.status(404).send({ error: 'Project not found' })
    })

    app.put<{ Params: { id: string }; Body: UpdateProjectInput }>('/:id', async (req, reply) => {
        try {
            const project = updateProject(req.params.id, req.body ?? {})
            if (!project) return reply.status(404).send({ error: 'Project not found' })
            projectChanged(project.id)
            return project
        } catch (error) {
            return reply.status(400).send({ error: message(error) })
        }
    })

    // DELETE /api/projects/:id — conversations and jobs are kept and unassigned; memory is kept
    app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
        if (!deleteProject(req.params.id)) return reply.status(404).send({ error: 'Project not found' })
        projectChanged(req.params.id)
        return { success: true }
    })

    // ─── Tasks ─────────────────────────────────────────────

    app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/:id/tasks', async (req, reply) => {
        if (!getProject(req.params.id)) return reply.status(404).send({ error: 'Project not found' })
        const statuses = req.query.status?.split(',').filter(Boolean) as ProjectTaskStatus[] | undefined
        return listProjectTasks(req.params.id, { statuses })
    })

    app.post<{ Params: { id: string }; Body: ProjectTaskInput }>('/:id/tasks', async (req, reply) => {
        if (!getProject(req.params.id)) return reply.status(404).send({ error: 'Project not found' })
        try {
            const task = createProjectTask(req.params.id, { ...req.body, createdBy: 'user' })
            tasksChanged(req.params.id)
            return task
        } catch (error) {
            return reply.status(400).send({ error: message(error) })
        }
    })

    app.put<{ Params: { id: string; taskId: string }; Body: ProjectTaskInput }>('/:id/tasks/:taskId', async (req, reply) => {
        try {
            const task = updateProjectTask(req.params.id, req.params.taskId, req.body ?? {})
            if (!task) return reply.status(404).send({ error: 'Task not found' })
            tasksChanged(req.params.id)
            return task
        } catch (error) {
            return reply.status(400).send({ error: message(error) })
        }
    })

    app.delete<{ Params: { id: string; taskId: string } }>('/:id/tasks/:taskId', async (req, reply) => {
        if (!deleteProjectTask(req.params.id, req.params.taskId)) return reply.status(404).send({ error: 'Task not found' })
        tasksChanged(req.params.id)
        return { success: true }
    })
}
