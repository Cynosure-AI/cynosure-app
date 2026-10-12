import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { ensureMemoryFolderPath, ensureMemoryRoot, makeChildFolderPath } from '../memory/memory-folder-directories.js'
import type { ProjectDto, ProjectTaskDto, ProjectTaskStatus } from '@shared/types'
import { USER_CHANGE, recordBriefRevision, recordTaskEvent, type ProjectChangeContext } from './project-history.js'

/** Parent memory folder that holds one subfolder per project. */
export const PROJECTS_MEMORY_FOLDER = 'Projects'
export const MAX_PROJECT_BRIEF_CHARS = 6000
export const PROJECT_TASK_STATUSES: readonly ProjectTaskStatus[] = ['todo', 'in_progress', 'blocked', 'done']

interface ProjectRow {
    id: string
    name: string
    description: string
    instructions: string
    brief: string
    brief_updated_at: number | null
    root_path: string
    memory_folder_id: string | null
    default_agent_id: string | null
    color: string
    icon: string
    archived: number
    sort_order: number
    created_at: number
    updated_at: number
    conversation_count?: number
    open_task_count?: number
    last_activity_at?: number | null
}

interface ProjectTaskRow {
    id: string
    project_id: string
    title: string
    notes: string
    status: ProjectTaskStatus
    sort_order: number
    assignee_agent_id: string | null
    conversation_id: string | null
    created_by: 'user' | 'agent'
    created_at: number
    updated_at: number
    completed_at: number | null
}

export interface CreateProjectInput {
    name: string
    description?: string
    instructions?: string
    brief?: string
    rootPath?: string
    /** Existing memory folder to use. When omitted, a `Projects/<name>` folder is created. */
    memoryFolderId?: string | null
    /** Skip creating a dedicated memory folder. */
    createMemoryFolder?: boolean
    defaultAgentId?: string | null
    color?: string
    icon?: string
}

export type UpdateProjectInput = Partial<Omit<CreateProjectInput, 'createMemoryFolder'>> & { archived?: boolean; sortOrder?: number }

export interface ProjectTaskInput {
    title?: string
    notes?: string
    status?: ProjectTaskStatus
    sortOrder?: number
    assigneeAgentId?: string | null
    conversationId?: string | null
}

const PROJECT_STATS_SQL = `
    (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id) AS conversation_count,
    (SELECT COUNT(*) FROM project_tasks t WHERE t.project_id = p.id AND t.status != 'done') AS open_task_count,
    (SELECT MAX(c.updated_at) FROM conversations c WHERE c.project_id = p.id) AS last_activity_at`

function rowToProject(row: ProjectRow): ProjectDto {
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        instructions: row.instructions,
        brief: row.brief,
        briefUpdatedAt: row.brief_updated_at,
        rootPath: row.root_path,
        memoryFolderId: row.memory_folder_id,
        defaultAgentId: row.default_agent_id,
        color: row.color,
        icon: row.icon ?? '',
        archived: row.archived === 1,
        sortOrder: row.sort_order,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.conversation_count !== undefined ? { conversationCount: row.conversation_count } : {}),
        ...(row.open_task_count !== undefined ? { openTaskCount: row.open_task_count } : {}),
        ...(row.last_activity_at !== undefined ? { lastActivityAt: row.last_activity_at } : {}),
    }
}

function rowToTask(row: ProjectTaskRow): ProjectTaskDto {
    return {
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        notes: row.notes,
        status: row.status,
        sortOrder: row.sort_order,
        assigneeAgentId: row.assignee_agent_id,
        conversationId: row.conversation_id,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
    }
}

/** Canonicalize a project working directory; an empty value clears it. */
export function normalizeProjectRootPath(input: string | undefined): string {
    const value = input?.trim() ?? ''
    if (!value) return ''
    if (!isAbsolute(value)) throw new Error('Enter an absolute folder path for the project directory.')
    if (!existsSync(value) || !statSync(value).isDirectory()) throw new Error('The project directory must be an existing folder.')
    return realpathSync(value)
}

/** Project icons are Iconify names such as `lucide:sprout`. */
function normalizeIcon(icon: string | undefined): string {
    const value = icon?.trim() ?? ''
    if (value && !/^[a-z0-9-]+:[a-z0-9-]+$/.test(value)) throw new Error('Icon must be an Iconify name such as lucide:sprout.')
    return value
}

function requireName(name: string | undefined): string {
    const trimmed = name?.trim()
    if (!trimmed) throw new Error('Project name is required.')
    return trimmed
}

function assertMemoryFolder(id: string | null | undefined): string | null {
    if (!id) return null
    if (!getDb().prepare('SELECT 1 FROM memory_folders WHERE id = ?').get(id)) throw new Error('Memory folder not found.')
    return id
}

function assertAgent(id: string | null | undefined): string | null {
    if (!id) return null
    if (!getDb().prepare('SELECT 1 FROM agents WHERE id = ?').get(id)) throw new Error('Agent not found.')
    return id
}

function createProjectMemoryFolder(name: string): string {
    const db = getDb()
    ensureMemoryRoot()
    const base = makeChildFolderPath(name, PROJECTS_MEMORY_FOLDER)
    // Reuse is intentional: recreating a project with the same name reconnects its memory.
    const folder = ensureMemoryFolderPath(db, base)
    if (!folder.description) {
        db.prepare('UPDATE memory_folders SET description = ? WHERE id = ?').run(`Knowledge for the "${name}" project`, folder.id)
    }
    return folder.id
}

export function listProjects(options: { includeArchived?: boolean } = {}): ProjectDto[] {
    const where = options.includeArchived ? '' : 'WHERE p.archived = 0'
    const rows = getDb().prepare(`SELECT p.*, ${PROJECT_STATS_SQL} FROM projects p ${where} ORDER BY p.archived ASC, p.sort_order ASC, p.created_at DESC`).all() as ProjectRow[]
    return rows.map(rowToProject)
}

export function getProject(id: string): ProjectDto | undefined {
    const row = getDb().prepare(`SELECT p.*, ${PROJECT_STATS_SQL} FROM projects p WHERE p.id = ?`).get(id) as ProjectRow | undefined
    return row ? rowToProject(row) : undefined
}

export function createProject(input: CreateProjectInput): ProjectDto {
    const name = requireName(input.name)
    const rootPath = normalizeProjectRootPath(input.rootPath)
    const defaultAgentId = assertAgent(input.defaultAgentId)
    const memoryFolderId = input.memoryFolderId !== undefined
        ? assertMemoryFolder(input.memoryFolderId)
        : input.createMemoryFolder === false ? null : createProjectMemoryFolder(name)
    const id = nanoid()
    const now = Date.now()
    const db = getDb()
    db.transaction(() => {
        db.prepare(`INSERT INTO projects (id, name, description, instructions, brief, brief_updated_at, root_path, memory_folder_id, default_agent_id, color, icon, archived, sort_order, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`).run(
            id, name, input.description?.trim() ?? '', input.instructions ?? '', (input.brief ?? '').slice(0, MAX_PROJECT_BRIEF_CHARS),
            input.brief ? now : null, rootPath, memoryFolderId, defaultAgentId, input.color ?? '', normalizeIcon(input.icon), now, now,
        )
        if (input.brief) recordBriefRevision(id, input.brief.slice(0, MAX_PROJECT_BRIEF_CHARS), USER_CHANGE, now)
    })()
    return getProject(id)!
}

export function updateProject(id: string, input: UpdateProjectInput, context: ProjectChangeContext = USER_CHANGE): ProjectDto | undefined {
    const db = getDb()
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
    if (!existing) return undefined
    const now = Date.now()
    const briefChanged = input.brief !== undefined && input.brief !== existing.brief
    const brief = briefChanged ? input.brief!.slice(0, MAX_PROJECT_BRIEF_CHARS) : existing.brief
    db.transaction(() => {
        if (briefChanged) {
            // A project from before revisions existed keeps its old brief as the baseline.
            if (existing.brief) recordBriefRevision(id, existing.brief, { source: 'initial' }, existing.brief_updated_at ?? existing.updated_at)
            recordBriefRevision(id, brief, context, now)
        }
        db.prepare(`UPDATE projects SET name = ?, description = ?, instructions = ?, brief = ?, brief_updated_at = ?, root_path = ?, memory_folder_id = ?,
            default_agent_id = ?, color = ?, icon = ?, archived = ?, sort_order = ?, updated_at = ? WHERE id = ?`).run(
            input.name !== undefined ? requireName(input.name) : existing.name,
            input.description !== undefined ? input.description.trim() : existing.description,
            input.instructions ?? existing.instructions,
            brief,
            briefChanged ? now : existing.brief_updated_at,
            input.rootPath !== undefined ? normalizeProjectRootPath(input.rootPath) : existing.root_path,
            input.memoryFolderId !== undefined ? assertMemoryFolder(input.memoryFolderId) : existing.memory_folder_id,
            input.defaultAgentId !== undefined ? assertAgent(input.defaultAgentId) : existing.default_agent_id,
            input.color ?? existing.color,
            input.icon !== undefined ? normalizeIcon(input.icon) : existing.icon,
            input.archived !== undefined ? (input.archived ? 1 : 0) : existing.archived,
            input.sortOrder ?? existing.sort_order,
            now,
            id,
        )
    })()
    return getProject(id)
}

/**
 * Delete a project. Its conversations and scheduled jobs stay and become
 * unassigned; its memory folder is user knowledge and is never removed here.
 */
export function deleteProject(id: string): boolean {
    const db = getDb()
    let deleted = false
    db.transaction(() => {
        db.prepare('UPDATE conversations SET project_id = NULL WHERE project_id = ?').run(id)
        db.prepare('UPDATE cron_jobs SET project_id = NULL WHERE project_id = ?').run(id)
        deleted = db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0
    })()
    return deleted
}

export function reorderProjects(ids: string[]): void {
    const db = getDb()
    const statement = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?')
    db.transaction(() => ids.forEach((id, index) => statement.run(index, id)))()
}

export function setProjectBrief(id: string, brief: string, context: ProjectChangeContext = USER_CHANGE): ProjectDto | undefined {
    return updateProject(id, { brief }, context)
}

export function getConversationProjectId(conversationId: string): string | null {
    try {
        const row = getDb().prepare('SELECT project_id FROM conversations WHERE id = ?').get(conversationId) as { project_id: string | null } | undefined
        return row?.project_id ?? null
    } catch {
        return null
    }
}

export function getProjectForConversation(conversationId: string): ProjectDto | undefined {
    const projectId = getConversationProjectId(conversationId)
    if (!projectId) return undefined
    const row = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined
    return row ? rowToProject(row) : undefined
}

export function setConversationProject(conversationId: string, projectId: string | null): boolean {
    const db = getDb()
    if (projectId && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new Error('Project not found.')
    return db.prepare('UPDATE conversations SET project_id = ? WHERE id = ?').run(projectId, conversationId).changes > 0
}

// ─── Tasks ─────────────────────────────────────────────────

function assertStatus(status: string | undefined): ProjectTaskStatus | undefined {
    if (status === undefined) return undefined
    if (!PROJECT_TASK_STATUSES.includes(status as ProjectTaskStatus)) {
        throw new Error(`Status must be one of: ${PROJECT_TASK_STATUSES.join(', ')}.`)
    }
    return status as ProjectTaskStatus
}

export function listProjectTasks(projectId: string, options: { statuses?: ProjectTaskStatus[] } = {}): ProjectTaskDto[] {
    const statuses = options.statuses?.length ? options.statuses : undefined
    const rows = getDb().prepare(`SELECT * FROM project_tasks WHERE project_id = ?
        ${statuses ? `AND status IN (${statuses.map(() => '?').join(', ')})` : ''}
        ORDER BY sort_order ASC, created_at ASC`).all(projectId, ...(statuses ?? [])) as ProjectTaskRow[]
    return rows.map(rowToTask)
}

export function getProjectTask(projectId: string, taskId: string): ProjectTaskDto | undefined {
    const row = getDb().prepare('SELECT * FROM project_tasks WHERE id = ? AND project_id = ?').get(taskId, projectId) as ProjectTaskRow | undefined
    return row ? rowToTask(row) : undefined
}

export function createProjectTask(projectId: string, input: ProjectTaskInput & { createdBy?: 'user' | 'agent' }, context: ProjectChangeContext = USER_CHANGE): ProjectTaskDto {
    const db = getDb()
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new Error('Project not found.')
    const title = input.title?.trim()
    if (!title) throw new Error('Task title is required.')
    const status = assertStatus(input.status) ?? 'todo'
    const sortOrder = input.sortOrder ?? ((db.prepare('SELECT MAX(sort_order) AS n FROM project_tasks WHERE project_id = ? AND status = ?').get(projectId, status) as { n: number | null }).n ?? 0) + 1
    const id = nanoid()
    const now = Date.now()
    db.prepare(`INSERT INTO project_tasks (id, project_id, title, notes, status, sort_order, assignee_agent_id, conversation_id, created_by, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, projectId, title, input.notes?.trim() ?? '', status, sortOrder, assertAgent(input.assigneeAgentId), input.conversationId ?? null,
        input.createdBy ?? 'user', now, now, status === 'done' ? now : null,
    )
    recordTaskEvent(projectId, { kind: 'task_created', taskId: id, taskTitle: title, toStatus: status }, context)
    return getProjectTask(projectId, id)!
}

export function updateProjectTask(projectId: string, taskId: string, input: ProjectTaskInput, context: ProjectChangeContext = USER_CHANGE): ProjectTaskDto | undefined {
    const existing = getProjectTask(projectId, taskId)
    if (!existing) return undefined
    const status = assertStatus(input.status) ?? existing.status
    const title = input.title !== undefined ? input.title.trim() : existing.title
    if (!title) throw new Error('Task title is required.')
    const now = Date.now()
    getDb().prepare(`UPDATE project_tasks SET title = ?, notes = ?, status = ?, sort_order = ?, assignee_agent_id = ?, conversation_id = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND project_id = ?`).run(
        title,
        input.notes !== undefined ? input.notes.trim() : existing.notes,
        status,
        input.sortOrder ?? existing.sortOrder,
        input.assigneeAgentId !== undefined ? assertAgent(input.assigneeAgentId) : existing.assigneeAgentId,
        input.conversationId !== undefined ? input.conversationId : existing.conversationId,
        now,
        status === 'done' ? (existing.completedAt ?? now) : null,
        taskId,
        projectId,
    )
    // Reordering within a column is not history; status and wording changes are.
    if (status !== existing.status || title !== existing.title) {
        recordTaskEvent(projectId, { kind: 'task_updated', taskId, taskTitle: title, fromStatus: existing.status, toStatus: status }, context)
    }
    return getProjectTask(projectId, taskId)
}

export function deleteProjectTask(projectId: string, taskId: string, context: ProjectChangeContext = USER_CHANGE): boolean {
    const existing = getProjectTask(projectId, taskId)
    if (!existing) return false
    getDb().prepare('DELETE FROM project_tasks WHERE id = ? AND project_id = ?').run(taskId, projectId)
    recordTaskEvent(projectId, { kind: 'task_deleted', taskId, taskTitle: existing.title, fromStatus: existing.status }, context)
    return true
}
