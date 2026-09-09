import Fastify from 'fastify'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { registerFileRoutes } from './files.js'

describe('file routes', () => {
    const directories: string[] = []

    afterEach(async () => {
        await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
    })

    test('serves an attachment using its user-facing filename', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'cynosure-files-'))
        directories.push(directory)
        const path = join(directory, 'stored-prefix-report.docx')
        await writeFile(path, 'document')

        const app = Fastify()
        await app.register(registerFileRoutes, { prefix: '/api/files' })
        const response = await app.inject({
            method: 'GET',
            url: `/api/files?path=${encodeURIComponent(path)}&name=${encodeURIComponent('Quarterly report.docx')}`,
        })
        await app.close()

        expect(response.statusCode).toBe(200)
        expect(response.headers['content-disposition']).toContain('filename="Quarterly report.docx"')
        expect(response.body).toBe('document')
    })
})
