import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import Fastify from 'fastify'
import { closeDb } from '../../db/database.js'
import { registerProjectRoutes } from '../../routes/projects.js'
import { createProject, createProjectTask, deleteProject, deleteProjectTask } from './project-store.js'
import {
    addTaskAttachment,
    countTaskAttachments,
    deleteTaskAttachment,
    getTaskAttachment,
    getTaskImageAttachmentIds,
    listTaskAttachments,
    markTaskAttachmentsUsed,
    readTaskAttachmentForChat,
} from './project-task-attachments.js'

vi.mock('../memory/memory-folder-watcher.js', () => ({ watchMemoryFolder: vi.fn(), stopWatchingMemoryFolder: vi.fn() }))

let sandbox: string
let previousDataDir: string | undefined

beforeEach(async () => {
    closeDb()
    previousDataDir = process.env.CYNOSURE_DATA_DIR
    sandbox = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'cynosure-task-attachments-')))
    process.env.CYNOSURE_DATA_DIR = sandbox
})

afterEach(async () => {
    closeDb()
    if (previousDataDir === undefined) delete process.env.CYNOSURE_DATA_DIR
    else process.env.CYNOSURE_DATA_DIR = previousDataDir
    await fs.rm(sandbox, { recursive: true, force: true })
})

const dataUrl = (mime: string, text: string) => `data:${mime};base64,${Buffer.from(text).toString('base64')}`

function setup() {
    const project = createProject({ name: 'Board', createMemoryFolder: false })
    const task = createProjectTask(project.id, { title: 'Fix the header' })
    return { project, task }
}

describe('project task attachments', () => {
    test('stores an upload and returns it in chat form', () => {
        const { project, task } = setup()
        const attachment = addTaskAttachment(project.id, task.id, { name: 'notes.md', content: dataUrl('text/markdown', '# Hello') })
        expect(attachment).toMatchObject({ name: 'notes.md', mimeType: 'text/markdown', sizeBytes: 7, usedInChat: false })
        expect(listTaskAttachments(project.id, task.id)).toHaveLength(1)
        expect(countTaskAttachments(project.id).get(task.id)).toBe(1)
        expect(readTaskAttachmentForChat(project.id, task.id, attachment.id)).toEqual({ kind: 'file', name: 'notes.md', content: '# Hello' })

        const image = addTaskAttachment(project.id, task.id, { name: 'shot.png', content: dataUrl('image/png', 'png') })
        expect(readTaskAttachmentForChat(project.id, task.id, image.id)?.kind).toBe('image')
    })

    test('rejects uploads that are not base64 data URLs or have no name', () => {
        const { project, task } = setup()
        expect(() => addTaskAttachment(project.id, task.id, { name: 'a.txt', content: 'plain text' })).toThrow(/data URL/)
        expect(() => addTaskAttachment(project.id, task.id, { name: '', content: dataUrl('text/plain', 'x') })).toThrow(/name/)
        expect(() => addTaskAttachment(project.id, 'missing', { name: 'a.txt', content: dataUrl('text/plain', 'x') })).toThrow(/Task not found/)
    })

    test('groups non-SVG images by task, keeps a stable choice, and scopes them to the project', () => {
        const { project, task } = setup()
        const otherTask = createProjectTask(project.id, { title: 'Another image' })
        const documents = createProjectTask(project.id, { title: 'Documents only' })
        const empty = createProjectTask(project.id, { title: 'No files' })
        const otherProject = setup()
        expect(getTaskImageAttachmentIds(project.id).size).toBe(0)

        for (const [name, mime] of [['notes.txt', 'text/plain'], ['icon.svg', 'image/svg+xml'], ['upper.png', 'Image/png']]) {
            addTaskAttachment(project.id, documents.id, { name, content: dataUrl(mime, 'file') })
        }
        const images = ['image/png', 'image/jpeg'].map((mime, index) => addTaskAttachment(project.id, task.id, {
            name: `image-${index}`, content: dataUrl(mime, 'image'),
        }))
        const otherImage = addTaskAttachment(project.id, otherTask.id, { name: 'photo.webp', content: dataUrl('image/webp', 'image') })
        const unrelated = addTaskAttachment(otherProject.project.id, otherProject.task.id, { name: 'photo.gif', content: dataUrl('image/gif', 'image') })

        const expectedId = images.map((image) => image.id).sort()[0]!
        const thumbnails = getTaskImageAttachmentIds(project.id)
        expect(thumbnails).toEqual(new Map([[task.id, expectedId], [otherTask.id, otherImage.id]]))
        expect(thumbnails.has(documents.id)).toBe(false)
        expect(thumbnails.has(empty.id)).toBe(false)
        expect(getTaskImageAttachmentIds(otherProject.project.id)).toEqual(new Map([[otherProject.task.id, unrelated.id]]))
        expect(countTaskAttachments(project.id).get(documents.id)).toBe(3)

        deleteTaskAttachment(project.id, task.id, expectedId)
        expect(getTaskImageAttachmentIds(project.id).get(task.id)).toBe(images.find((image) => image.id !== expectedId)!.id)
    })

    test('task API responses include attachment counts and non-SVG thumbnails, including after updates', async () => {
        const { project, task } = setup()
        const svgTask = createProjectTask(project.id, { title: 'SVG only' })
        const image = addTaskAttachment(project.id, task.id, { name: 'photo.png', content: dataUrl('image/png', 'image') })
        addTaskAttachment(project.id, task.id, { name: 'notes.txt', content: dataUrl('text/plain', 'notes') })
        addTaskAttachment(project.id, svgTask.id, { name: 'icon.svg', content: dataUrl('image/svg+xml', '<svg/>') })
        const app = Fastify()
        try {
            await app.register((instance) => registerProjectRoutes(instance, vi.fn()), { prefix: '/api/projects' })
            const list = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/tasks` })
            expect(list.statusCode).toBe(200)
            expect(list.json()).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: task.id, attachmentCount: 2, imageAttachmentId: image.id }),
                expect.objectContaining({ id: svgTask.id, attachmentCount: 1, imageAttachmentId: null }),
            ]))
            const updated = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/tasks/${task.id}`, payload: { title: 'Updated' } })
            expect(updated.statusCode).toBe(200)
            expect(updated.json()).toMatchObject({ title: 'Updated', attachmentCount: 2, imageAttachmentId: image.id })
            const created = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks`, payload: { title: 'New task' } })
            expect(created.statusCode).toBe(200)
            expect(created.json()).toMatchObject({ attachmentCount: 0, imageAttachmentId: null })
        } finally {
            await app.close()
        }
    })

    test('keeps path segments out of the stored file name', () => {
        const { project, task } = setup()
        const attachment = addTaskAttachment(project.id, task.id, { name: '../../escape.txt', content: dataUrl('text/plain', 'x') })
        const stored = getTaskAttachment(project.id, task.id, attachment.id)!
        expect(attachment.name).toBe('escape.txt')
        expect(stored.path.startsWith(sandbox)).toBe(true)
    })

    test('removing an attachment deletes its file', () => {
        const { project, task } = setup()
        const attachment = addTaskAttachment(project.id, task.id, { name: 'a.txt', content: dataUrl('text/plain', 'x') })
        const stored = getTaskAttachment(project.id, task.id, attachment.id)!
        expect(deleteTaskAttachment(project.id, task.id, attachment.id)).toBe(true)
        expect(existsSync(stored.path)).toBe(false)
    })

    test('deleting a task deletes its files, except those used in a chat', () => {
        const { project, task } = setup()
        const unused = getTaskAttachment(project.id, task.id, addTaskAttachment(project.id, task.id, { name: 'a.txt', content: dataUrl('text/plain', 'a') }).id)!
        const used = getTaskAttachment(project.id, task.id, addTaskAttachment(project.id, task.id, { name: 'b.txt', content: dataUrl('text/plain', 'b') }).id)!
        markTaskAttachmentsUsed([used.id])

        expect(deleteProjectTask(project.id, task.id)).toBe(true)
        expect(existsSync(unused.path)).toBe(false)
        expect(existsSync(used.path)).toBe(true)
        expect(listTaskAttachments(project.id, task.id)).toEqual([])
    })

    test('deleting a project deletes its unused task files', () => {
        const { project, task } = setup()
        const stored = getTaskAttachment(project.id, task.id, addTaskAttachment(project.id, task.id, { name: 'a.txt', content: dataUrl('text/plain', 'a') }).id)!
        expect(deleteProject(project.id)).toBe(true)
        expect(existsSync(stored.path)).toBe(false)
    })
})
