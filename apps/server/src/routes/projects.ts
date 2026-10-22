import type { FastifyInstance } from 'fastify'
import {
    BriefConflictError,
    createProject,
    createProjectTask,
    deleteProject,
    deleteProjectTask,
    getProject,
    getProjectTask,
    listProjects,
    listProjectTasks,
    reorderProjects,
    updateProject,
    updateProjectTask,
    type CreateProjectInput,
    type ProjectTaskInput,
    type UpdateProjectInput,
} from '../core/projects/project-store.js'
import { ProjectFileError, listProjectFolder, readProjectFile, searchProjectFiles } from '../core/projects/project-files.js'
import { diffBriefRevisions, getBriefRevision, listBriefRevisions, listProjectTimeline } from '../core/projects/project-history.js'
import { listProjectTaskPlans, listProjectTaskProgress } from '../core/agent/planning-state.js'
import {
    addTaskAttachment,
    countTaskAttachments,
    deleteTaskAttachment,
    getTaskAttachment,
    listTaskAttachments,
    markTaskAttachmentsUsed,
    readTaskAttachmentForChat,
} from '../core/projects/project-task-attachments.js'
import { createReadStream, existsSync } from 'node:fs'
import type { ProjectTaskDto, ProjectTaskStatus } from '@shared/types'

type BroadcastFn = (event: string, data: unknown) => void

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** Board cards show how far the newest run on each task got, and how many files it carries. */
function withProgress(projectId: string, tasks: ProjectTaskDto[]): ProjectTaskDto[] {
    const progress = listProjectTaskProgress(projectId)
    const attachments = countTaskAttachments(projectId)
    return tasks.map((task) => ({ ...task, progress: progress.get(task.id) ?? null, attachmentCount: attachments.get(task.id) ?? 0 }))
}

/** Types a browser may render in place; anything else downloads, so uploaded HTML or SVG never runs in the app. */
function isInlineSafe(mimeType: string): boolean {
    return (/^image\//.test(mimeType) && mimeType !== 'image/svg+xml') || /^(audio|video)\//.test(mimeType)
        || mimeType === 'application/pdf' || mimeType === 'text/plain'
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
            if (error instanceof BriefConflictError) {
                return reply.status(409).send({
                    error: 'The brief changed while you were editing it. Your draft is kept; save again to replace the new version (it stays in the timeline).',
                    brief: error.currentBrief,
                })
            }
            return reply.status(400).send({ error: message(error) })
        }
    })

    // DELETE /api/projects/:id — conversations and jobs are kept and unassigned; memory is kept
    app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
        if (!deleteProject(req.params.id)) return reply.status(404).send({ error: 'Project not found' })
        projectChanged(req.params.id)
        return { success: true }
    })

    // ─── Project directory files ───────────────────────────

    // GET /api/projects/:id/files?path=<folder>&q=<search> — browse or search the project directory
    app.get<{ Params: { id: string }; Querystring: { path?: string; q?: string; showHidden?: string } }>('/:id/files', async (req, reply) => {
        const project = getProject(req.params.id)
        if (!project) return reply.status(404).send({ error: 'Project not found' })
        const showHidden = req.query.showHidden === 'true'
        try {
            return req.query.q?.trim()
                ? await searchProjectFiles(project.rootPath, req.query.q, showHidden)
                : await listProjectFolder(project.rootPath, req.query.path, showHidden)
        } catch (error) {
            return reply.status(error instanceof ProjectFileError ? error.statusCode : 400).send({ error: message(error) })
        }
    })

    // GET /api/projects/:id/files/content?path=<file> — a project file, ready to attach to a chat
    app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/:id/files/content', async (req, reply) => {
        const project = getProject(req.params.id)
        if (!project) return reply.status(404).send({ error: 'Project not found' })
        try {
            return await readProjectFile(project.rootPath, req.query.path ?? '')
        } catch (error) {
            return reply.status(error instanceof ProjectFileError ? error.statusCode : 400).send({ error: message(error) })
        }
    })

    // ─── History ───────────────────────────────────────────

    // GET /api/projects/:id/timeline — brief revisions, task changes, and chats, newest first
    app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>('/:id/timeline', async (req, reply) => {
        if (!getProject(req.params.id)) return reply.status(404).send({ error: 'Project not found' })
        return listProjectTimeline(req.params.id, {
            limit: req.query.limit ? Number(req.query.limit) : undefined,
            before: req.query.before ? Number(req.query.before) : undefined,
        })
    })

    app.get<{ Params: { id: string } }>('/:id/brief/revisions', async (req, reply) => {
        if (!getProject(req.params.id)) return reply.status(404).send({ error: 'Project not found' })
        return listBriefRevisions(req.params.id)
    })

    app.get<{ Params: { id: string; revisionId: string } }>('/:id/brief/revisions/:revisionId', async (req, reply) => (
        getBriefRevision(req.params.id, req.params.revisionId) ?? reply.status(404).send({ error: 'Revision not found' })
    ))

    // GET /api/projects/:id/brief/revisions/:revisionId/diff?from=<revisionId>
    // Without `from`, shows what that revision changed compared with the one before it.
    app.get<{ Params: { id: string; revisionId: string }; Querystring: { from?: string } }>('/:id/brief/revisions/:revisionId/diff', async (req, reply) => {
        const segments = diffBriefRevisions(req.params.id, req.params.revisionId, req.query.from || undefined)
        return segments ? { segments } : reply.status(404).send({ error: 'Revision not found' })
    })

    // POST /api/projects/:id/brief/revisions/:revisionId/restore — make an earlier brief current again
    app.post<{ Params: { id: string; revisionId: string } }>('/:id/brief/revisions/:revisionId/restore', async (req, reply) => {
        const revision = getBriefRevision(req.params.id, req.params.revisionId)
        if (!revision) return reply.status(404).send({ error: 'Revision not found' })
        const project = updateProject(req.params.id, { brief: revision.content }, { source: 'restore' })
        projectChanged(req.params.id)
        return project
    })

    // ─── Tasks ─────────────────────────────────────────────

    app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/:id/tasks', async (req, reply) => {
        if (!getProject(req.params.id)) return reply.status(404).send({ error: 'Project not found' })
        const statuses = req.query.status?.split(',').filter(Boolean) as ProjectTaskStatus[] | undefined
        return withProgress(req.params.id, listProjectTasks(req.params.id, { statuses }))
    })

    app.post<{ Params: { id: string }; Body: ProjectTaskInput }>('/:id/tasks', async (req, reply) => {
        if (!getProject(req.params.id)) return reply.status(404).send({ error: 'Project not found' })
        try {
            const task = createProjectTask(req.params.id, { ...req.body, createdBy: 'user' })
            tasksChanged(req.params.id)
            return { ...task, progress: null, attachmentCount: 0 }
        } catch (error) {
            return reply.status(400).send({ error: message(error) })
        }
    })

    app.put<{ Params: { id: string; taskId: string }; Body: ProjectTaskInput }>('/:id/tasks/:taskId', async (req, reply) => {
        try {
            const task = updateProjectTask(req.params.id, req.params.taskId, req.body ?? {})
            if (!task) return reply.status(404).send({ error: 'Task not found' })
            tasksChanged(req.params.id)
            return withProgress(req.params.id, [task])[0]
        } catch (error) {
            return reply.status(400).send({ error: message(error) })
        }
    })

    // GET /api/projects/:id/tasks/:taskId/work-log — todo lists of the runs that worked on the task, newest first
    app.get<{ Params: { id: string; taskId: string } }>('/:id/tasks/:taskId/work-log', async (req, reply) => {
        if (!getProjectTask(req.params.id, req.params.taskId)) return reply.status(404).send({ error: 'Task not found' })
        return listProjectTaskPlans(req.params.taskId)
    })

    // ─── Task attachments ──────────────────────────────────

    app.get<{ Params: { id: string; taskId: string } }>('/:id/tasks/:taskId/attachments', async (req, reply) => {
        if (!getProjectTask(req.params.id, req.params.taskId)) return reply.status(404).send({ error: 'Task not found' })
        return listTaskAttachments(req.params.id, req.params.taskId)
    })

    // POST /api/projects/:id/tasks/:taskId/attachments — body { name, content: data URL }
    app.post<{ Params: { id: string; taskId: string }; Body: { name?: string; content?: string } }>('/:id/tasks/:taskId/attachments', async (req, reply) => {
        try {
            const attachment = addTaskAttachment(req.params.id, req.params.taskId, req.body ?? {})
            tasksChanged(req.params.id)
            return attachment
        } catch (error) {
            return reply.status(400).send({ error: message(error) })
        }
    })

    // GET /api/projects/:id/tasks/:taskId/attachments/:attachmentId — the file, to view or download
    app.get<{ Params: { id: string; taskId: string; attachmentId: string }; Querystring: { download?: string } }>(
        '/:id/tasks/:taskId/attachments/:attachmentId',
        async (req, reply) => {
            const attachment = getTaskAttachment(req.params.id, req.params.taskId, req.params.attachmentId)
            if (!attachment || !existsSync(attachment.path)) return reply.status(404).send({ error: 'Attachment not found' })
            const inline = req.query.download !== 'true' && isInlineSafe(attachment.mimeType)
            const asciiName = attachment.name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
            reply.header('Content-Type', inline ? attachment.mimeType : 'application/octet-stream')
            reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`)
            reply.header('X-Content-Type-Options', 'nosniff')
            reply.header('Content-Length', attachment.sizeBytes)
            return reply.send(createReadStream(attachment.path))
        },
    )

    // GET /api/projects/:id/tasks/:taskId/attachments/:attachmentId/content — ready to attach to a chat
    app.get<{ Params: { id: string; taskId: string; attachmentId: string } }>('/:id/tasks/:taskId/attachments/:attachmentId/content', async (req, reply) => {
        try {
            return readTaskAttachmentForChat(req.params.id, req.params.taskId, req.params.attachmentId)
                ?? reply.status(404).send({ error: 'Attachment not found' })
        } catch (error) {
            return reply.status(error instanceof ProjectFileError ? error.statusCode : 400).send({ error: message(error) })
        }
    })

    app.delete<{ Params: { id: string; taskId: string; attachmentId: string } }>('/:id/tasks/:taskId/attachments/:attachmentId', async (req, reply) => {
        if (!deleteTaskAttachment(req.params.id, req.params.taskId, req.params.attachmentId)) return reply.status(404).send({ error: 'Attachment not found' })
        tasksChanged(req.params.id)
        return { success: true }
    })

    // POST /api/projects/:id/task-attachments/used — the chat sent these attachments
    app.post<{ Params: { id: string }; Body: { ids?: string[] } }>('/:id/task-attachments/used', async (req) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id): id is string => typeof id === 'string').slice(0, 100) : []
        markTaskAttachmentsUsed(ids)
        return { success: true }
    })

    app.delete<{ Params: { id: string; taskId: string } }>('/:id/tasks/:taskId', async (req, reply) => {
        if (!deleteProjectTask(req.params.id, req.params.taskId)) return reply.status(404).send({ error: 'Task not found' })
        tasksChanged(req.params.id)
        return { success: true }
    })
}
