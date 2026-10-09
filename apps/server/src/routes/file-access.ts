import type { FastifyInstance } from 'fastify'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { addFileAccessRoot, listFileAccessRoots, removeFileAccessRoot } from '../core/tools/builtin/file-access-policy.js'

export interface DirectoryListing {
    path: string
    parent: string | null
    home: string
    directories: { name: string; path: string }[]
}

/** List the subdirectories of a folder so the web UI can offer a folder picker. */
export async function listDirectories(input: string | undefined, showHidden = false): Promise<DirectoryListing> {
    const home = homedir()
    const requested = input?.trim() || home
    if (!path.isAbsolute(requested)) throw new Error('Enter an absolute folder path.')
    const current = await fs.realpath(requested)
    if (!(await fs.stat(current)).isDirectory()) throw new Error('The path must be a directory.')

    const entries = await fs.readdir(current, { withFileTypes: true })
    const directories: DirectoryListing['directories'] = []
    for (const entry of entries) {
        if (!showHidden && entry.name.startsWith('.')) continue
        const entryPath = path.join(current, entry.name)
        let isDirectory = entry.isDirectory()
        if (entry.isSymbolicLink()) isDirectory = await fs.stat(entryPath).then((stat) => stat.isDirectory(), () => false)
        if (isDirectory) directories.push({ name: entry.name, path: entryPath })
    }
    directories.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))

    const parent = path.dirname(current)
    return { path: current, parent: parent === current ? null : parent, home, directories }
}

export async function registerFileAccessRoutes(app: FastifyInstance): Promise<void> {
    app.get('/', async () => ({ folders: listFileAccessRoots() }))

    app.get<{ Querystring: { path?: string; showHidden?: string } }>('/directories', async (request, reply) => {
        try {
            return await listDirectories(request.query?.path, request.query?.showHidden === 'true')
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code
            const message = code === 'ENOENT' ? 'That folder does not exist.'
                : code === 'EACCES' || code === 'EPERM' ? 'Cynosure cannot read that folder.'
                    : error instanceof Error ? error.message : String(error)
            return reply.status(400).send({ error: message })
        }
    })

    app.post<{ Body: { path?: unknown } }>('/', async (request, reply) => {
        if (typeof request.body?.path !== 'string') return reply.status(400).send({ error: 'Enter an absolute folder path.' })
        try {
            return { folders: await addFileAccessRoot(request.body.path) }
        } catch (error) {
            return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) })
        }
    })

    app.delete<{ Querystring: { path?: string } }>('/', async (request, reply) => {
        if (typeof request.query?.path !== 'string') return reply.status(400).send({ error: 'Folder path is required.' })
        try {
            return { folders: removeFileAccessRoot(request.query.path) }
        } catch (error) {
            return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) })
        }
    })
}
