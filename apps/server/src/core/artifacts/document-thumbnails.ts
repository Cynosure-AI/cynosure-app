import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import sharp from 'sharp'
import { getDocumentProxy, renderPageAsImage } from 'unpdf'
import { getAppDataDir } from '../data-dir.js'

/** Rendered width in pixels: sharp enough for a 4-column grid card on a 2x display. */
const THUMBNAIL_WIDTH = 600
/** Bump to invalidate every cached thumbnail when the rendering changes. */
const THUMBNAIL_VERSION = 1
/** Rendering parses the whole file in memory, so skip very large documents. */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024
/** PDF rendering is CPU-heavy; a grid of cards would otherwise render them all at once. */
const MAX_CONCURRENT_RENDERS = 2

const THUMBNAIL_EXTENSIONS = new Set(['.pdf'])

export interface DocumentThumbnailSource {
    path: string
    sizeBytes: number
    modifiedMs: number
}

export interface DocumentThumbnail {
    data: Buffer
    etag: string
}

export function canRenderDocumentThumbnail(path: string, sizeBytes: number): boolean {
    return THUMBNAIL_EXTENSIONS.has(extname(path).toLowerCase()) && sizeBytes <= MAX_SOURCE_BYTES
}

/** Content-addressed by path, size, and mtime, so an edited file gets a fresh thumbnail. */
export function documentThumbnailKey(source: DocumentThumbnailSource): string {
    return createHash('sha256')
        .update(`${THUMBNAIL_VERSION}\0${source.path}\0${source.sizeBytes}\0${source.modifiedMs}`)
        .digest('hex')
}

function thumbnailCacheDir(): string {
    return join(getAppDataDir(), 'cache', 'thumbnails')
}

const pendingRenders = new Map<string, Promise<DocumentThumbnail>>()
let activeRenders = 0
const renderQueue: (() => void)[] = []

async function withRenderSlot<T>(task: () => Promise<T>): Promise<T> {
    if (activeRenders >= MAX_CONCURRENT_RENDERS) {
        await new Promise<void>((release) => renderQueue.push(release))
    }
    activeRenders++
    try {
        return await task()
    } finally {
        activeRenders--
        renderQueue.shift()?.()
    }
}

export async function getDocumentThumbnail(source: DocumentThumbnailSource): Promise<DocumentThumbnail> {
    const etag = documentThumbnailKey(source)
    const cacheDir = thumbnailCacheDir()
    const cachePath = join(cacheDir, `${etag}.webp`)

    try {
        return { data: await readFile(cachePath), etag }
    } catch {
        // Not cached yet.
    }

    let job = pendingRenders.get(etag)
    if (!job) {
        job = withRenderSlot(async () => {
            const data = await renderPdfThumbnail(source.path)
            await mkdir(cacheDir, { recursive: true })
            // The sidecar records the source so pruning can tell when it is gone or changed.
            const { path, sizeBytes, modifiedMs } = source
            await writeFile(join(cacheDir, `${etag}.json`), JSON.stringify({ path, sizeBytes, modifiedMs }))
            // Write then rename so a concurrent reader never sees a partial file.
            const tempPath = `${cachePath}.${process.pid}.tmp`
            await writeFile(tempPath, data)
            await rename(tempPath, cachePath)
            return { data, etag }
        }).finally(() => pendingRenders.delete(etag))
        pendingRenders.set(etag, job)
    }
    return job
}

/**
 * Delete thumbnails whose source document was removed or has changed since it
 * was rendered, along with leftovers from interrupted writes. Returns how many
 * cache files were removed.
 */
export async function pruneDocumentThumbnails(): Promise<number> {
    const cacheDir = thumbnailCacheDir()
    let names: string[]
    try {
        names = await readdir(cacheDir)
    } catch {
        return 0
    }

    const stale = new Set<string>()
    const thumbnails = new Set(names.filter((name) => name.endsWith('.webp')).map((name) => name.slice(0, -'.webp'.length)))
    const ownTempSuffix = `.${process.pid}.tmp`

    for (const name of names) {
        // Temp files from this process belong to renders that are still running.
        if (name.endsWith('.tmp') && !name.endsWith(ownTempSuffix)) stale.add(name)
        else if (name.endsWith('.json') && !thumbnails.has(name.slice(0, -'.json'.length))) stale.add(name)
    }

    for (const key of thumbnails) {
        if (!await isThumbnailCurrent(cacheDir, key)) {
            stale.add(`${key}.webp`)
            stale.add(`${key}.json`)
        }
    }

    let removed = 0
    for (const name of stale) {
        if (!names.includes(name)) continue
        await rm(join(cacheDir, name), { force: true })
        removed++
    }
    return removed
}

async function isThumbnailCurrent(cacheDir: string, key: string): Promise<boolean> {
    try {
        const source = JSON.parse(await readFile(join(cacheDir, `${key}.json`), 'utf8')) as DocumentThumbnailSource
        const current = await stat(source.path)
        return documentThumbnailKey({ path: source.path, sizeBytes: current.size, modifiedMs: current.mtimeMs }) === key
    } catch {
        // No readable sidecar, or the source is gone.
        return false
    }
}

async function renderPdfThumbnail(path: string): Promise<Buffer> {
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)))
    try {
        const png = await renderPageAsImage(pdf, 1, {
            canvasImport: () => import('@napi-rs/canvas'),
            width: THUMBNAIL_WIDTH,
        })
        // Flatten onto white: pages without a painted background render transparent.
        return await sharp(Buffer.from(png))
            .flatten({ background: '#ffffff' })
            .webp({ quality: 80 })
            .toBuffer()
    } finally {
        await pdf.loadingTask.destroy()
    }
}
