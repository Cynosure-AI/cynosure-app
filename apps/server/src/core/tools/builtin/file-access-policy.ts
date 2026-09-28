import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDb } from '../../../db/database.js'
import { getEventBus } from '../../telemetry/event-bus.js'

const SETTINGS_KEY = 'fileAccessAllowedDirectories'

function isWithin(parent: string, child: string): boolean {
    const relative = path.relative(parent, child)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function listFileAccessRoots(): string[] {
    const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value_json: string } | undefined
    if (!row) return []
    try {
        const parsed: unknown = JSON.parse(row.value_json)
        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
    } catch {
        return []
    }
}

function saveRoots(roots: string[]): void {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(SETTINGS_KEY, JSON.stringify(roots))
}

export async function addFileAccessRoot(input: string): Promise<string[]> {
    if (!input?.trim() || !path.isAbsolute(input)) throw new Error('Enter an absolute folder path.')
    const canonical = await fs.realpath(input.trim())
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error('The path must be a directory.')
    const roots = listFileAccessRoots()
    if (!roots.includes(canonical)) roots.push(canonical)
    saveRoots(roots)
    return roots
}

export function removeFileAccessRoot(input: string): string[] {
    const roots = listFileAccessRoots()
    const next = roots.filter(root => root !== input)
    if (next.length === roots.length) throw new Error('Folder is not in the allowlist.')
    saveRoots(next)
    return next
}

export class FileAccessDeniedError extends Error {
    constructor(public readonly requestedPath: string, public readonly suggestedFolder: string) {
        super(`Access denied. Path is outside allowed directories: ${requestedPath}`)
    }
}

export async function resolveFileAccessPath(input: string): Promise<string> {
    if (!input?.trim()) throw new Error('Path is required.')
    const absolute = path.resolve(input)
    let resolved = absolute
    try {
        resolved = await fs.realpath(absolute)
    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code !== 'ENOENT') throw error
        const missing: string[] = []
        let cursor = absolute
        while (true) {
            try {
                resolved = path.join(await fs.realpath(cursor), ...missing.reverse())
                break
            } catch (parentError) {
                if (typeof parentError === 'object' && parentError !== null && 'code' in parentError && parentError.code !== 'ENOENT') throw parentError
                if ((await fs.lstat(cursor).catch(() => null))?.isSymbolicLink()) {
                    throw new Error(`Cannot access a broken symbolic link: ${cursor}`)
                }
                const parent = path.dirname(cursor)
                if (parent === cursor) throw new Error(`No existing parent directory found for path: ${input}`)
                missing.push(path.basename(cursor))
                cursor = parent
            }
        }
    }
    for (const root of listFileAccessRoots()) {
        const canonicalRoot = await fs.realpath(root).catch(() => root)
        if (isWithin(canonicalRoot, resolved)) return resolved
    }
    const stats = await fs.stat(resolved).catch(() => null)
    let folder = stats?.isDirectory() ? resolved : path.dirname(resolved)
    while (!(await fs.stat(folder).catch(() => null))?.isDirectory()) {
        const parent = path.dirname(folder)
        if (parent === folder) break
        folder = parent
    }
    throw new FileAccessDeniedError(input, folder)
}

export async function requestFileAccess(input: {
    path: string
    folder: string
    toolName: string
    conversationId: string
    signal?: AbortSignal
}): Promise<boolean> {
    const taskId = randomUUID()
    const eventBus = getEventBus()
    const approved = await new Promise<boolean>((resolve, reject) => {
        if (input.signal?.aborted) {
            reject(new Error('File access request was cancelled.'))
            return
        }
        const onAbort = () => {
            eventBus.emit('hitl:cancel-request', { taskId, conversationId: input.conversationId })
            reject(new Error('File access request was cancelled.'))
        }
        input.signal?.addEventListener('abort', onAbort, { once: true })
        eventBus.emit('hitl:request', {
            taskId,
            conversationId: input.conversationId,
            toolCalls: [{
                id: taskId,
                type: 'function',
                function: { name: 'file_access_permission', arguments: JSON.stringify({ path: input.path, folder: input.folder, tool: input.toolName }) },
                fileAccess: { path: input.path, folder: input.folder, toolName: input.toolName },
            }],
            resolve: (result: { approved: boolean }) => {
                input.signal?.removeEventListener('abort', onAbort)
                resolve(result.approved)
            },
        })
    })
    if (approved) await addFileAccessRoot(input.folder)
    return approved
}

/** Ask for missing folder permissions before the file tool's execution timer starts. */
export async function preflightFileToolAccess(input: {
    toolName: string
    arguments: Record<string, unknown>
    conversationId: string
    signal?: AbortSignal
}): Promise<void> {
    const args = input.arguments
    const paths: string[] = []
    const addPath = (value: unknown) => { if (typeof value === 'string') paths.push(value) }
    if (input.toolName === 'file_read') {
        addPath(args.path)
        if (Array.isArray(args.paths)) args.paths.forEach(addPath)
    } else if (input.toolName === 'file_move' || input.toolName === 'directory_merge') {
        addPath(args.source)
        addPath(args.destination)
    } else if (input.toolName === 'file_archive') {
        if (args.action === 'create') {
            if (Array.isArray(args.filePaths)) args.filePaths.forEach(addPath)
            addPath(args.destination)
        } else {
            addPath(args.archivePath)
            if (typeof args.destination === 'string') addPath(args.destination)
            else if (typeof args.archivePath === 'string') {
                const archive = path.resolve(args.archivePath)
                addPath(path.join(path.dirname(archive), path.basename(archive, path.extname(archive))))
            }
        }
    } else {
        addPath(args.path)
    }
    for (const requestedPath of paths) {
        input.signal?.throwIfAborted()
        const prompted = new Set<string>()
        for (;;) {
            try {
                await resolveFileAccessPath(requestedPath)
                break
            } catch (error) {
                if (!(error instanceof FileAccessDeniedError)) throw error
                if (prompted.has(error.suggestedFolder)) throw error
                prompted.add(error.suggestedFolder)
                const approved = await requestFileAccess({
                    path: error.requestedPath,
                    folder: error.suggestedFolder,
                    toolName: input.toolName,
                    conversationId: input.conversationId,
                    signal: input.signal,
                })
                if (!approved) throw new Error(`Access to ${error.suggestedFolder} was denied by the user.`)
            }
        }
    }
}
