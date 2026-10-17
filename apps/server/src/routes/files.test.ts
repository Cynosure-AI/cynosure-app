import Fastify from 'fastify'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, test } from 'vitest'
import { registerFileRoutes } from './files.js'

/** One US-letter page whose lower-left quadrant is filled red. */
function makePdf(): Buffer {
    const content = '1 0 0 rg 0 0 306 396 re f'
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ]
    let pdf = '%PDF-1.7\n'
    const offsets: number[] = []
    objects.forEach((object, i) => {
        offsets.push(Buffer.byteLength(pdf))
        pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
    })
    const xref = Buffer.byteLength(pdf)
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    pdf += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
    return Buffer.from(pdf)
}

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

    describe('thumbnails', () => {
        afterEach(() => {
            delete process.env.CYNOSURE_DATA_DIR
        })

        async function setup() {
            const directory = await mkdtemp(join(tmpdir(), 'cynosure-thumbs-'))
            directories.push(directory)
            process.env.CYNOSURE_DATA_DIR = join(directory, 'data-root')
            const app = Fastify()
            await app.register(registerFileRoutes, { prefix: '/api/files' })
            return { directory, app }
        }

        test('renders the first PDF page as a cached webp', async () => {
            const { directory, app } = await setup()
            const path = join(directory, 'report.pdf')
            await writeFile(path, makePdf())
            const url = `/api/files/thumbnail?path=${encodeURIComponent(path)}`

            const response = await app.inject({ method: 'GET', url })
            expect(response.statusCode).toBe(200)
            expect(response.headers['content-type']).toBe('image/webp')

            const image = sharp(response.rawPayload)
            const { width, height } = await image.metadata()
            expect(width).toBe(600)
            expect(height).toBeGreaterThan(width!)
            const { data, info } = await image.removeAlpha().raw().toBuffer({ resolveWithObject: true })
            const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)]
            const [red, green, blue] = pixel(10, info.height - 10)
            expect(red).toBeGreaterThan(200)
            expect(Math.max(green, blue)).toBeLessThan(40)
            expect(Math.min(...pixel(info.width - 10, 10))).toBeGreaterThan(240)

            const etag = response.headers.etag as string
            const cached = await app.inject({ method: 'GET', url, headers: { 'if-none-match': etag } })
            await app.close()

            expect(cached.statusCode).toBe(304)
            const cacheFiles = await readdir(join(process.env.CYNOSURE_DATA_DIR!, 'data', 'cache', 'thumbnails'))
            const key = etag.replaceAll('"', '')
            expect(cacheFiles.sort()).toEqual([`${key}.json`, `${key}.webp`])
        })

        test('refuses file types it cannot render and unreadable PDFs', async () => {
            const { directory, app } = await setup()
            const docx = join(directory, 'notes.docx')
            const broken = join(directory, 'broken.pdf')
            await writeFile(docx, 'document')
            await writeFile(broken, 'not a pdf')

            const unsupported = await app.inject({ method: 'GET', url: `/api/files/thumbnail?path=${encodeURIComponent(docx)}` })
            const unreadable = await app.inject({ method: 'GET', url: `/api/files/thumbnail?path=${encodeURIComponent(broken)}` })
            const traversal = await app.inject({ method: 'GET', url: `/api/files/thumbnail?path=${encodeURIComponent(`${directory}/../x.pdf`)}` })
            await app.close()

            expect(unsupported.statusCode).toBe(415)
            expect(unreadable.statusCode).toBe(422)
            expect(traversal.statusCode).toBe(400)
        })
    })
})
