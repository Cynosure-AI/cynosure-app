import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getAppDataDir } from '../data-dir.js'
import type { ProjectTaskAttachmentDto } from '@shared/types'
import { MAX_PROJECT_FILE_BYTES, toAttachableContent, type ProjectFileContent } from './project-files.js'

interface AttachmentRow {
    id: string
    task_id: string
    project_id: string
    name: string
    path: string
    mime_type: string
    size_bytes: number
    used_in_chat: number
    created_at: number
}

export interface StoredTaskAttachment extends ProjectTaskAttachmentDto {
    path: string
}

function rowToAttachment(row: AttachmentRow): StoredTaskAttachment {
    return {
        id: row.id,
        taskId: row.task_id,
        projectId: row.project_id,
        name: row.name,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        usedInChat: row.used_in_chat === 1,
        createdAt: row.created_at,
        path: row.path,
    }
}

function toDto({ path: _path, ...attachment }: StoredTaskAttachment): ProjectTaskAttachmentDto {
    return attachment
}

function taskAttachmentDir(projectId: string, taskId: string): string {
    return join(getAppDataDir(), 'artifacts', 'projects', projectId, 'tasks', taskId)
}

/** Keep a readable, filesystem-safe name; the id prefix keeps uploads with the same name apart. */
function safeFileName(name: string): string {
    return basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'file'
}

export function listTaskAttachments(projectId: string, taskId: string): ProjectTaskAttachmentDto[] {
    const rows = getDb().prepare('SELECT * FROM project_task_attachments WHERE project_id = ? AND task_id = ? ORDER BY created_at ASC')
        .all(projectId, taskId) as AttachmentRow[]
    return rows.map((row) => toDto(rowToAttachment(row)))
}

/** Attachment counts for every task of a project, for the board cards. */
export function countTaskAttachments(projectId: string): Map<string, number> {
    const rows = getDb().prepare('SELECT task_id, COUNT(*) AS n FROM project_task_attachments WHERE project_id = ? GROUP BY task_id')
        .all(projectId) as { task_id: string; n: number }[]
    return new Map(rows.map((row) => [row.task_id, row.n]))
}

/** One stable image per task for board thumbnails, using the panel's non-SVG image rule. */
export function getTaskImageAttachmentIds(projectId: string): Map<string, string> {
    const rows = getDb().prepare(`SELECT task_id, MIN(id) AS id FROM project_task_attachments
        WHERE project_id = ? AND mime_type GLOB 'image/*' AND mime_type != 'image/svg+xml'
        GROUP BY task_id`).all(projectId) as { task_id: string; id: string }[]
    return new Map(rows.map((row) => [row.task_id, row.id]))
}

export function getTaskAttachment(projectId: string, taskId: string, attachmentId: string): StoredTaskAttachment | undefined {
    const row = getDb().prepare('SELECT * FROM project_task_attachments WHERE id = ? AND project_id = ? AND task_id = ?')
        .get(attachmentId, projectId, taskId) as AttachmentRow | undefined
    return row ? rowToAttachment(row) : undefined
}

/** Store an upload sent as a data URL (`data:<mime>;base64,...`). */
export function addTaskAttachment(projectId: string, taskId: string, input: { name?: string; content?: string }): ProjectTaskAttachmentDto {
    const db = getDb()
    if (!db.prepare('SELECT 1 FROM project_tasks WHERE id = ? AND project_id = ?').get(taskId, projectId)) throw new Error('Task not found.')
    const name = basename(input.name?.trim() ?? '')
    if (!name) throw new Error('Attachment name is required.')
    const match = /^data:([^;,]*)(;base64)?,/.exec(input.content ?? '')
    if (!match || !match[2]) throw new Error('Attachment content must be a base64 data URL.')
    const buffer = Buffer.from(input.content!.slice(match[0].length), 'base64')
    if (buffer.length > MAX_PROJECT_FILE_BYTES) throw new Error('Files larger than 20 MB cannot be attached.')

    const id = nanoid()
    const dir = taskAttachmentDir(projectId, taskId)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${id}-${safeFileName(name)}`)
    writeFileSync(path, buffer)
    const now = Date.now()
    db.prepare(`INSERT INTO project_task_attachments (id, task_id, project_id, name, path, mime_type, size_bytes, used_in_chat, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(id, taskId, projectId, name, path, match[1] || 'application/octet-stream', buffer.length, now)
    return toDto(getTaskAttachment(projectId, taskId, id)!)
}

export function deleteTaskAttachment(projectId: string, taskId: string, attachmentId: string): boolean {
    const attachment = getTaskAttachment(projectId, taskId, attachmentId)
    if (!attachment) return false
    getDb().prepare('DELETE FROM project_task_attachments WHERE id = ?').run(attachmentId)
    // A file already sent to a chat stays on disk with that chat's history.
    if (!attachment.usedInChat) rmSync(attachment.path, { force: true })
    return true
}

/** The attachment in the form the chat composer attaches it. */
export function readTaskAttachmentForChat(projectId: string, taskId: string, attachmentId: string): ProjectFileContent | undefined {
    const attachment = getTaskAttachment(projectId, taskId, attachmentId)
    if (!attachment || !existsSync(attachment.path)) return undefined
    return toAttachableContent(readFileSync(attachment.path), attachment.name)
}

/** Record that attachments were sent in a chat, so deleting their task keeps the files. */
export function markTaskAttachmentsUsed(ids: string[]): void {
    if (!ids.length) return
    getDb().prepare(`UPDATE project_task_attachments SET used_in_chat = 1 WHERE id IN (${ids.map(() => '?').join(', ')})`).run(...ids)
}

/**
 * Remove the files of attachments that were never used in a chat. Call before
 * deleting their task or project; the rows go with it by cascade.
 */
export function removeUnusedAttachmentFiles(where: { projectId: string; taskId?: string }): void {
    const rows = (where.taskId
        ? getDb().prepare('SELECT * FROM project_task_attachments WHERE project_id = ? AND task_id = ?').all(where.projectId, where.taskId)
        : getDb().prepare('SELECT * FROM project_task_attachments WHERE project_id = ?').all(where.projectId)) as AttachmentRow[]
    for (const row of rows) {
        if (!row.used_in_chat) rmSync(row.path, { force: true })
    }
    if (rows.every((row) => !row.used_in_chat)) {
        const dir = where.taskId ? taskAttachmentDir(where.projectId, where.taskId) : join(getAppDataDir(), 'artifacts', 'projects', where.projectId)
        rmSync(dir, { recursive: true, force: true })
    }
}
