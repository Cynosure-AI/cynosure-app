import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { ProjectFileError, listProjectFolder, readProjectFile, searchProjectFiles } from './project-files.js'

let sandbox: string
let root: string

beforeEach(async () => {
    sandbox = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'cynosure-project-files-')))
    root = path.join(sandbox, 'project')
    await fs.mkdir(path.join(root, 'src', 'lib'), { recursive: true })
    await fs.mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true })
    await fs.mkdir(path.join(root, '.git'))
    await fs.writeFile(path.join(root, 'README.md'), '# Garden\n')
    await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export const app = 1\n')
    await fs.writeFile(path.join(root, 'src', 'lib', 'beds.ts'), 'export const beds = 2\n')
    await fs.writeFile(path.join(root, 'src', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]))
    await fs.writeFile(path.join(root, 'src', 'blob.bin'), Buffer.from([1, 0, 2, 3]))
    await fs.writeFile(path.join(root, 'node_modules', 'dep', 'app.ts'), 'vendored\n')
    await fs.writeFile(path.join(root, '.env'), 'SECRET=1\n')
    await fs.writeFile(path.join(sandbox, 'outside.txt'), 'private\n')
})

afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true })
})

async function errorOf(promise: Promise<unknown>): Promise<ProjectFileError> {
    const error = await promise.then(() => null, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(ProjectFileError)
    return error as ProjectFileError
}

describe('project files', () => {
    test('lists a folder with folders first and hidden entries only on request', async () => {
        const listing = await listProjectFolder(root)
        expect(listing.path).toBe('')
        expect(listing.entries.map(entry => entry.path)).toEqual(['node_modules', 'src', 'README.md'])

        const hidden = await listProjectFolder(root, '', true)
        expect(hidden.entries.map(entry => entry.path)).toEqual(['.git', 'node_modules', 'src', '.env', 'README.md'])

        const nested = await listProjectFolder(root, 'src')
        expect(nested.path).toBe('src')
        expect(nested.entries[0]).toEqual({ name: 'lib', path: 'src/lib', type: 'directory' })
        expect(nested.entries.find(entry => entry.path === 'src/app.ts')).toMatchObject({ type: 'file', size: 21 })
    })

    test('searches by path and skips generated folders', async () => {
        const result = await searchProjectFiles(root, 'APP')
        expect(result.entries.map(entry => entry.path)).toEqual(['src/app.ts'])
        expect((await searchProjectFiles(root, 'lib/')).entries.map(entry => entry.path)).toEqual(['src/lib/beds.ts'])
    })

    test('hides ignored files and directories in listings and search even with hidden files enabled', async () => {
        await fs.writeFile(path.join(root, '.gitignore'), '# Generated and private files\nnode_modules/\n*.bin\n.env\n')

        for (const showHidden of [false, true]) {
            const listing = await listProjectFolder(root, '', showHidden)
            expect(listing.entries.map(entry => entry.path)).not.toContain('node_modules')
            expect(listing.entries.map(entry => entry.path)).not.toContain('.env')
            expect((await listProjectFolder(root, 'src', showHidden)).entries.map(entry => entry.path)).not.toContain('src/blob.bin')
            const results = (await searchProjectFiles(root, '', showHidden)).entries.map(entry => entry.path)
            expect(results).toContain('src/app.ts')
            expect(results).not.toContain('src/blob.bin')
            expect(results).not.toContain('.env')
        }
    })

    test('applies nested rules relative to their folder and allows nested negations', async () => {
        await fs.writeFile(path.join(root, '.gitignore'), '*.ts\n!src/app.ts\n')
        await fs.writeFile(path.join(root, 'src', '.gitignore'), '!lib/*.ts\n/logo.png\n')
        await fs.writeFile(path.join(root, 'src', 'lib', 'logo.png'), 'nested image')

        expect((await listProjectFolder(root, 'src')).entries.map(entry => entry.path)).toEqual(['src/lib', 'src/app.ts', 'src/blob.bin'])
        expect((await listProjectFolder(root, 'src/lib')).entries.map(entry => entry.path)).toEqual(['src/lib/beds.ts', 'src/lib/logo.png'])
        expect((await searchProjectFiles(root, '.ts')).entries.map(entry => entry.path)).toEqual(['src/app.ts', 'src/lib/beds.ts'])
        expect((await searchProjectFiles(root, 'logo')).entries.map(entry => entry.path)).toEqual(['src/lib/logo.png'])
    })

    test('prunes ignored ancestors and does not let rules inside them reinclude files', async () => {
        await fs.writeFile(path.join(root, '.gitignore'), 'src/lib/\n')
        await fs.writeFile(path.join(root, 'src', 'lib', '.gitignore'), '!beds.ts\n')
        expect((await listProjectFolder(root, 'src')).entries.map(entry => entry.path)).not.toContain('src/lib')
        expect((await listProjectFolder(root, 'src/lib')).entries).toEqual([])
        expect((await searchProjectFiles(root, 'beds', true)).entries).toEqual([])
    })

    test('supports anchored patterns, directory patterns, globstars, and escaped characters', async () => {
        await fs.writeFile(path.join(root, '.gitignore'), '/README.md\n**/*.bin\nlogo.png/\n\\#notes.txt\n')
        await fs.writeFile(path.join(root, '#notes.txt'), 'notes')
        await fs.writeFile(path.join(root, 'src', 'README.md'), 'nested readme')
        expect((await listProjectFolder(root)).entries.map(entry => entry.path)).toEqual(['node_modules', 'src'])
        expect((await searchProjectFiles(root, 'README')).entries.map(entry => entry.path)).toEqual(['src/README.md'])
        expect((await searchProjectFiles(root, 'blob')).entries).toEqual([])
        expect((await listProjectFolder(root, 'src')).entries.map(entry => entry.path)).toContain('src/logo.png')
    })

    test('reloads changed ignore rules on subsequent requests', async () => {
        expect((await searchProjectFiles(root, 'app')).entries).toHaveLength(1)
        await fs.writeFile(path.join(root, '.gitignore'), '*.ts\n')
        expect((await searchProjectFiles(root, 'app')).entries).toEqual([])
        await fs.writeFile(path.join(root, '.gitignore'), '*.ts\n!app.ts\n')
        expect((await searchProjectFiles(root, 'app')).entries).toHaveLength(1)
    })

    test('reads text as text, images as data URLs, and refuses other binaries', async () => {
        expect(await readProjectFile(root, 'src/app.ts')).toEqual({ kind: 'file', name: 'src/app.ts', content: 'export const app = 1\n' })
        const image = await readProjectFile(root, 'src/logo.png')
        expect(image.kind).toBe('image')
        expect(image.content.startsWith('data:image/png;base64,')).toBe(true)
        expect((await errorOf(readProjectFile(root, 'src/blob.bin'))).statusCode).toBe(415)
        expect((await errorOf(readProjectFile(root, 'src'))).statusCode).toBe(400)
    })

    test('refuses paths and symlinks that leave the project directory', async () => {
        expect((await errorOf(readProjectFile(root, '../outside.txt'))).statusCode).toBe(403)
        expect((await errorOf(readProjectFile(root, path.join(sandbox, 'outside.txt')))).statusCode).toBe(403)
        expect((await errorOf(listProjectFolder(root, '..'))).statusCode).toBe(403)

        await fs.symlink(path.join(sandbox, 'outside.txt'), path.join(root, 'link.txt'))
        expect((await errorOf(readProjectFile(root, 'link.txt'))).statusCode).toBe(403)
    })

    test('reports a project without a directory', async () => {
        expect((await errorOf(listProjectFolder(''))).message).toBe('This project has no project directory.')
    })
})
