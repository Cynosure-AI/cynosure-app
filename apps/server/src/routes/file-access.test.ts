import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { closeDb } from '../db/database.js'
import { registerFileAccessRoutes } from './file-access.js'

let sandbox: string
let previousDataDir: string | undefined

beforeEach(async () => {
    closeDb()
    sandbox = await fs.mkdtemp(path.join(tmpdir(), 'cynosure-file-routes-'))
    previousDataDir = process.env.CYNOSURE_DATA_DIR
    process.env.CYNOSURE_DATA_DIR = sandbox
})

afterEach(async () => {
    closeDb()
    if (previousDataDir === undefined) delete process.env.CYNOSURE_DATA_DIR
    else process.env.CYNOSURE_DATA_DIR = previousDataDir
    await fs.rm(sandbox, { recursive: true, force: true })
})

describe('file access settings routes', () => {
    it('lists, adds, and removes allowed folders', async () => {
        const app = Fastify()
        await app.register(registerFileAccessRoutes, { prefix: '/file-access' })
        const folder = path.join(sandbox, 'project')
        await fs.mkdir(folder)
        expect((await app.inject({ method: 'GET', url: '/file-access' })).json()).toEqual({ folders: [] })
        expect((await app.inject({ method: 'POST', url: '/file-access', payload: { path: folder } })).json()).toEqual({ folders: [folder] })
        expect((await app.inject({ method: 'GET', url: '/file-access' })).json()).toEqual({ folders: [folder] })
        expect((await app.inject({ method: 'DELETE', url: `/file-access?path=${encodeURIComponent(folder)}` })).json()).toEqual({ folders: [] })
        await app.close()
    })

    it('lists subdirectories for the folder picker', async () => {
        const app = Fastify()
        await app.register(registerFileAccessRoutes, { prefix: '/file-access' })
        const root = await fs.realpath(sandbox)
        await fs.mkdir(path.join(root, 'beta'))
        await fs.mkdir(path.join(root, 'Alpha'))
        await fs.mkdir(path.join(root, '.hidden'))
        await fs.writeFile(path.join(root, 'file.txt'), 'content')

        const listing = (await app.inject({ method: 'GET', url: `/file-access/directories?path=${encodeURIComponent(root)}` })).json()
        expect(listing.path).toBe(root)
        expect(listing.parent).toBe(path.dirname(root))
        expect(listing.directories).toEqual([
            { name: 'Alpha', path: path.join(root, 'Alpha') },
            { name: 'beta', path: path.join(root, 'beta') },
        ])

        const withHidden = (await app.inject({ method: 'GET', url: `/file-access/directories?path=${encodeURIComponent(root)}&showHidden=true` })).json()
        expect(withHidden.directories.map((entry: { name: string }) => entry.name)).toContain('.hidden')

        expect((await app.inject({ method: 'GET', url: '/file-access/directories?path=relative' })).statusCode).toBe(400)
        expect((await app.inject({ method: 'GET', url: `/file-access/directories?path=${encodeURIComponent(path.join(root, 'missing'))}` })).statusCode).toBe(400)
        await app.close()
    })

    it('rejects relative paths and files', async () => {
        const app = Fastify()
        await app.register(registerFileAccessRoutes, { prefix: '/file-access' })
        const file = path.join(sandbox, 'file.txt')
        await fs.writeFile(file, 'content')
        expect((await app.inject({ method: 'POST', url: '/file-access', payload: { path: 'relative' } })).statusCode).toBe(400)
        expect((await app.inject({ method: 'POST', url: '/file-access', payload: { path: file } })).statusCode).toBe(400)
        await app.close()
    })
})
