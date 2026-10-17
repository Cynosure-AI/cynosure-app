import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { documentThumbnailKey, pruneDocumentThumbnails } from './document-thumbnails.js'

describe('pruneDocumentThumbnails', () => {
    let directory: string
    let cacheDir: string

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'cynosure-thumb-prune-'))
        process.env.CYNOSURE_DATA_DIR = directory
        cacheDir = join(directory, 'data', 'cache', 'thumbnails')
        await mkdir(cacheDir, { recursive: true })
    })

    afterEach(async () => {
        delete process.env.CYNOSURE_DATA_DIR
        await rm(directory, { recursive: true, force: true })
    })

    /** Caches a thumbnail for `path` as it is on disk now, the way a render does. */
    async function cacheThumbnail(path: string): Promise<string> {
        const current = await stat(path)
        const source = { path, sizeBytes: current.size, modifiedMs: current.mtimeMs }
        const key = documentThumbnailKey(source)
        await writeFile(join(cacheDir, `${key}.json`), JSON.stringify(source))
        await writeFile(join(cacheDir, `${key}.webp`), 'image')
        return key
    }

    test('keeps thumbnails of unchanged documents and drops removed, changed, and orphaned ones', async () => {
        const kept = join(directory, 'kept.pdf')
        const removed = join(directory, 'removed.pdf')
        const changed = join(directory, 'changed.pdf')
        await Promise.all([kept, removed, changed].map((path) => writeFile(path, 'pdf')))
        const keptKey = await cacheThumbnail(kept)
        await cacheThumbnail(removed)
        await cacheThumbnail(changed)

        await rm(removed)
        await utimes(changed, new Date(), new Date(Date.now() + 60_000))
        await writeFile(join(cacheDir, 'no-sidecar.webp'), 'image')
        await writeFile(join(cacheDir, 'no-image.json'), '{}')
        await writeFile(join(cacheDir, `${keptKey}.webp.1.tmp`), 'partial')

        expect(await pruneDocumentThumbnails()).toBe(7)
        expect((await readdir(cacheDir)).sort()).toEqual([`${keptKey}.json`, `${keptKey}.webp`])
    })

    test('leaves in-flight writes from this process alone and tolerates a missing cache', async () => {
        const ownTemp = `abc.webp.${process.pid}.tmp`
        await writeFile(join(cacheDir, ownTemp), 'partial')
        expect(await pruneDocumentThumbnails()).toBe(0)
        expect(await readdir(cacheDir)).toEqual([ownTemp])

        await rm(cacheDir, { recursive: true })
        expect(await pruneDocumentThumbnails()).toBe(0)
    })
})
