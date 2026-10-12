import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { closeDb, getDb } from '../../db/database.js'
import {
    createProject,
    createProjectTask,
    deleteProject,
    getProject,
    getProjectForConversation,
    listProjectTasks,
    listProjects,
    setConversationProject,
    updateProject,
    updateProjectTask,
} from './project-store.js'
import {
    buildProjectStateMessage,
    mergeProjectMemoryScope,
    resolveProjectExecutionContext,
} from './project-context.js'
import { makeProjectTools } from './project-tools.js'
import { diffBriefRevisions, listBriefRevisions, listProjectTimeline } from './project-history.js'
import { listEffectiveFileAccessRoots, resolveFileAccessPath, runInFileAccessScope } from '../tools/builtin/file-access-policy.js'
import { makeShellTool } from '../tools/builtin/shell-tool.js'
import { isSystemAutoApprovedTool } from '../tools/tool-policy.js'

vi.mock('../memory/memory-folder-watcher.js', () => ({ watchMemoryFolder: vi.fn(), stopWatchingMemoryFolder: vi.fn() }))

let sandbox: string
let previousDataDir: string | undefined

beforeEach(async () => {
    closeDb()
    previousDataDir = process.env.CYNOSURE_DATA_DIR
    sandbox = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'cynosure-projects-')))
    process.env.CYNOSURE_DATA_DIR = sandbox
})

afterEach(async () => {
    closeDb()
    if (previousDataDir === undefined) delete process.env.CYNOSURE_DATA_DIR
    else process.env.CYNOSURE_DATA_DIR = previousDataDir
    await fs.rm(sandbox, { recursive: true, force: true })
})

function insertConversation(id: string, projectId: string | null = null, agentId: string | null = null): void {
    getDb().prepare('INSERT INTO conversations (id, title, agent_id, project_id, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, 'Chat', agentId, projectId, 'chat', Date.now(), Date.now())
}

describe('project store', () => {
    test('creating a project creates a Projects/<name> memory folder by default', () => {
        const project = createProject({ name: 'Garden Planner', description: 'Plan the beds' })
        const folder = getDb().prepare('SELECT name, directory_path FROM memory_folders WHERE id = ?').get(project.memoryFolderId) as { name: string; directory_path: string }
        expect(folder.name).toBe('Garden Planner')
        expect(folder.directory_path.endsWith(path.join('Projects', 'Garden Planner'))).toBe(true)
        expect(createProject({ name: 'No Memory', createMemoryFolder: false }).memoryFolderId).toBeNull()
    })

    test('validates the project directory and canonicalizes it', async () => {
        const dir = path.join(sandbox, 'work')
        await fs.mkdir(dir)
        expect(createProject({ name: 'Dir', rootPath: dir, createMemoryFolder: false }).rootPath).toBe(dir)
        expect(() => createProject({ name: 'Rel', rootPath: 'relative/path' })).toThrow(/absolute/)
        expect(() => createProject({ name: 'Missing', rootPath: path.join(sandbox, 'missing') })).toThrow(/existing folder/)
    })

    test('lists counts and keeps conversations when a project is deleted', () => {
        const project = createProject({ name: 'Counted', createMemoryFolder: false })
        insertConversation('c1', project.id)
        insertConversation('c2')
        setConversationProject('c2', project.id)
        createProjectTask(project.id, { title: 'Open' })
        createProjectTask(project.id, { title: 'Closed', status: 'done' })

        expect(listProjects()[0]).toMatchObject({ id: project.id, conversationCount: 2, openTaskCount: 1 })
        expect(getProjectForConversation('c2')?.id).toBe(project.id)

        expect(deleteProject(project.id)).toBe(true)
        expect(getProject(project.id)).toBeUndefined()
        const rows = getDb().prepare('SELECT project_id FROM conversations ORDER BY id').all() as Array<{ project_id: string | null }>
        expect(rows).toEqual([{ project_id: null }, { project_id: null }])
        expect(getDb().prepare('SELECT COUNT(*) AS n FROM project_tasks').get()).toEqual({ n: 0 })
    })

    test('projects keep an Iconify icon and reject other values', () => {
        const project = createProject({ name: 'Icon', icon: 'lucide:sprout', createMemoryFolder: false })
        expect(project.icon).toBe('lucide:sprout')
        expect(updateProject(project.id, { icon: '' })!.icon).toBe('')
        expect(() => updateProject(project.id, { icon: '<svg onload=x>' })).toThrow(/Iconify/)
    })

    test('archived projects are hidden unless requested', () => {
        const project = createProject({ name: 'Old', createMemoryFolder: false })
        updateProject(project.id, { archived: true })
        expect(listProjects()).toHaveLength(0)
        expect(listProjects({ includeArchived: true })).toHaveLength(1)
    })

    test('tasks track completion time and reject unknown statuses', () => {
        const project = createProject({ name: 'Tasks', createMemoryFolder: false })
        const task = createProjectTask(project.id, { title: 'Write tests' })
        expect(task).toMatchObject({ status: 'todo', completedAt: null, createdBy: 'user' })
        const done = updateProjectTask(project.id, task.id, { status: 'done' })!
        expect(done.completedAt).toBeTypeOf('number')
        expect(updateProjectTask(project.id, task.id, { status: 'todo' })!.completedAt).toBeNull()
        expect(() => updateProjectTask(project.id, task.id, { status: 'later' as never })).toThrow(/Status/)
        expect(() => createProjectTask(project.id, { title: '  ' })).toThrow(/title/)
    })
})

describe('project execution context', () => {
    const folder = (id: string) => ({ id, name: id, folderPath: id })

    test('merges project memory into run scopes', () => {
        const projectFolders = [folder('project')]
        const assigned = () => [folder('assigned')]
        expect(mergeProjectMemoryScope({ overrides: [], projectFolders, assignedFolders: assigned, isFreeChat: false })).toEqual([])
        expect(mergeProjectMemoryScope({ overrides: undefined, projectFolders, assignedFolders: assigned, isFreeChat: true })).toBeUndefined()
        expect(mergeProjectMemoryScope({ overrides: undefined, projectFolders, assignedFolders: assigned, isFreeChat: false })!.map((f) => f.id))
            .toEqual(['project', 'assigned'])
        expect(mergeProjectMemoryScope({ overrides: [folder('chosen'), folder('project')], projectFolders, assignedFolders: assigned, isFreeChat: false })!.map((f) => f.id))
            .toEqual(['project', 'chosen'])
        expect(mergeProjectMemoryScope({ overrides: [folder('chosen')], projectFolders: [], assignedFolders: assigned, isFreeChat: false })!.map((f) => f.id))
            .toEqual(['chosen'])
    })

    test('builds instructions, state, memory scope, and tools for project conversations', () => {
        const project = createProject({ name: 'Launch', instructions: 'Answer in German.', brief: 'Goal: ship v1.' })
        createProjectTask(project.id, { title: 'Draft release notes', status: 'in_progress' })
        insertConversation('in-project', project.id)
        insertConversation('outside')

        expect(resolveProjectExecutionContext('outside')).toBeNull()
        const context = resolveProjectExecutionContext('in-project')!
        expect(context.systemPrompt).toContain('## Project: Launch')
        expect(context.systemPrompt).toContain('Answer in German.')
        expect(context.memoryFolders[0].id).toBe(project.memoryFolderId)
        expect(context.stateMessage?.content).toContain('Goal: ship v1.')
        expect(context.stateMessage?.content).toContain('[in_progress] Draft release notes')
        expect(context.stateMessage?.metadata).toMatchObject({ contextKind: 'project-state', untrusted: true })
        expect(context.tools.map((tool) => tool.name)).toEqual(['project_brief_update', 'project_task_list', 'project_task_create', 'project_task_update'])
        expect(context.tools.every((tool) => isSystemAutoApprovedTool(tool.name))).toBe(true)
    })

    test('an empty project asks the agent to write a brief', () => {
        const project = createProject({ name: 'Empty', createMemoryFolder: false })
        expect(buildProjectStateMessage(project)?.content).toContain('brief is empty')
    })

    test('project tools update the brief and board and broadcast changes', async () => {
        const project = createProject({ name: 'Tools', createMemoryFolder: false })
        insertConversation('conv', project.id)
        const broadcast = vi.fn()
        const tools = Object.fromEntries(makeProjectTools({ projectId: project.id, conversationId: 'conv', broadcast }).map((tool) => [tool.name, tool]))

        expect((await tools.project_brief_update.execute({ brief: 'New state' })).success).toBe(true)
        expect(getProject(project.id)?.brief).toBe('New state')
        expect(getProject(project.id)?.briefUpdatedAt).toBeTypeOf('number')

        const created = JSON.parse((await tools.project_task_create.execute({ title: 'Follow up', notes: 'Call the vendor' })).output as string)
        expect(listProjectTasks(project.id)[0]).toMatchObject({ title: 'Follow up', createdBy: 'agent', conversationId: 'conv' })
        expect((await tools.project_task_update.execute({ taskId: created.id, status: 'done' })).success).toBe(true)
        expect(JSON.parse((await tools.project_task_list.execute({})).output as string)).toEqual([])
        expect((await tools.project_task_update.execute({ taskId: 'missing', status: 'done' })).success).toBe(false)
        expect(broadcast).toHaveBeenCalledWith('project:updated', { id: project.id })
        expect(broadcast).toHaveBeenCalledWith('project:tasks-updated', { projectId: project.id })
    })
})

describe('project directory access', () => {
    test('file access and the shell default to the project directory only for project conversations', async () => {
        const dir = path.join(sandbox, 'repo')
        await fs.mkdir(dir)
        await fs.writeFile(path.join(dir, 'notes.txt'), 'hi')
        const project = createProject({ name: 'Repo', rootPath: dir, createMemoryFolder: false })
        insertConversation('inside', project.id)
        insertConversation('outside')

        expect(runInFileAccessScope('inside', () => listEffectiveFileAccessRoots())).toContain(dir)
        expect(runInFileAccessScope('outside', () => listEffectiveFileAccessRoots())).not.toContain(dir)
        await expect(runInFileAccessScope('inside', () => resolveFileAccessPath(path.join(dir, 'notes.txt')))).resolves.toBe(path.join(dir, 'notes.txt'))
        await expect(runInFileAccessScope('outside', () => resolveFileAccessPath(path.join(dir, 'notes.txt')))).rejects.toThrow(/Access denied/)

        const shell = makeShellTool({ defaultCwd: dir })
        const result = await shell.execute({ command: process.platform === 'win32' ? 'cd' : 'pwd' })
        expect(String(result.output)).toContain(dir)
    })
})

describe('project history', () => {
    test('records who changed the brief and diffs revisions', async () => {
        const project = createProject({ name: 'History', brief: 'Goal: plant tomatoes.', createMemoryFolder: false })
        insertConversation('chat-1', project.id)
        const tools = Object.fromEntries(makeProjectTools({ projectId: project.id, conversationId: 'chat-1', agentId: 'agent-x' }).map((tool) => [tool.name, tool]))
        await tools.project_brief_update.execute({ brief: 'Goal: plant peppers.' })
        await tools.project_brief_update.execute({ brief: 'Goal: plant peppers.' })

        const revisions = listBriefRevisions(project.id)
        expect(revisions.map(({ revisionNumber, source, isCurrent }) => ({ revisionNumber, source, isCurrent }))).toEqual([
            { revisionNumber: 2, source: 'ai', isCurrent: true },
            { revisionNumber: 1, source: 'user', isCurrent: false },
        ])
        expect(revisions[0]).toMatchObject({ conversationId: 'chat-1', agentId: 'agent-x' })

        const changes = diffBriefRevisions(project.id, revisions[0].id)!
        expect(changes.filter((part) => part.type === 'removed').map((part) => part.text).join('')).toContain('tomatoes')
        expect(changes.filter((part) => part.type === 'added').map((part) => part.text).join('')).toContain('peppers')
        expect(diffBriefRevisions(project.id, revisions[1].id)!.every((part) => part.type !== 'removed')).toBe(true)
    })

    test('the timeline merges brief revisions, task changes, and chats, newest first', () => {
        const project = createProject({ name: 'Timeline', createMemoryFolder: false })
        insertConversation('chat-1', project.id)
        const task = createProjectTask(project.id, { title: 'Buy soil' })
        updateProjectTask(project.id, task.id, { sortOrder: 5 })
        updateProjectTask(project.id, task.id, { status: 'done' }, { source: 'ai', conversationId: 'chat-1' })
        updateProject(project.id, { brief: 'Soil bought.' })

        const kinds = listProjectTimeline(project.id).map((entry) => entry.kind)
        expect(kinds.sort()).toEqual(['brief', 'chat_started', 'task_created', 'task_updated'])
        const done = listProjectTimeline(project.id).find((entry) => entry.kind === 'task_updated')
        expect(done).toMatchObject({ fromStatus: 'todo', toStatus: 'done', source: 'ai', conversationTitle: 'Chat' })
    })
})

