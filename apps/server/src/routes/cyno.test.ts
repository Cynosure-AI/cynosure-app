import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb } from '../db/database.js'
import { getDefaultMemoryFolder } from '../core/memory/memory-folder-scope.js'
import { getBuiltInToolKey } from '../core/tools/built-in-tools.js'
import { registerCynoRoutes } from './cyno.js'

let directory: string
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-cyno-route-'))
    vi.stubEnv('CYNOSURE_DATA_DIR', directory)
})
afterEach(() => {
    closeDb()
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
})

describe('Cyno routes', () => {
    test('return the profile with its unset tools and memory resolved', async () => {
        const app = Fastify()
        await app.register(registerCynoRoutes, { prefix: '/cyno' })

        const profile = (await app.inject({ method: 'GET', url: '/cyno' })).json()
        expect(profile).toMatchObject({ name: 'Cyno', tools: null, memoryFolders: null })
        expect(profile.effective.tools).toContain(getBuiltInToolKey('schedule_create'))
        expect(profile.effective.memoryFolders).toEqual([getDefaultMemoryFolder()!.id])

        const saved = (await app.inject({ method: 'PUT', url: '/cyno', payload: { memoryFolders: [], tools: ['x'] } })).json()
        expect(saved.effective).toEqual({ tools: ['x'], memoryFolders: [] })
        expect((await app.inject({ method: 'PUT', url: '/cyno', payload: { name: '' } })).statusCode).toBe(400)
    })
})
