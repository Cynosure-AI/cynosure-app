import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { downloadFileName, makeWebFetchTool } from './web-fetch.js'
import { extractFilePathFromFileUrl, getConversationArtifactsDir } from '../../artifacts/image-artifacts.js'
import { BUILTIN_TOOL_NAMES, getBuiltInToolKey } from '../built-in-tools.js'
import { isReadOnlyModeTool } from '../tool-policy.js'

const ARTICLE = `<!doctype html><html><head><title>Release notes</title></head><body>
<nav><a href="/">Home</a><a href="/docs">Docs</a></nav>
<article><h1>Release notes</h1>
<p>This release adds a built-in web fetch tool that reads pages and returns their main content as Markdown.
See the <a href="/docs/tools">tool documentation</a> for details about every option and its default value.</p>
</article><footer>Copyright footer text</footer></body></html>`

const zip = new AdmZip()
zip.addFile('readme.txt', Buffer.from('hello'))
zip.addFile('src/main.ts', Buffer.from('export {}'))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

const PAGES: Record<string, { type: string; body: string | Buffer; status?: number; headers?: Record<string, string> }> = {
    '/article': { type: 'text/html; charset=utf-8', body: ARTICLE },
    '/empty': { type: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>' },
    '/data.json': { type: 'application/json', body: '{"ok":true}' },
    '/image.png': { type: 'image/png', body: PNG },
    '/clip.mp4': { type: 'video/mp4', body: Buffer.from('not really a video') },
    '/get?id=7': { type: 'application/octet-stream', body: zip.toBuffer(), headers: { 'Content-Disposition': 'attachment; filename="source code.zip"' } },
    '/logo.svg': { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' },
    '/missing': { type: 'text/plain', body: 'nope', status: 404 },
}

let server: Server
let base: string
const dataDir = mkdtempSync(join(tmpdir(), 'cynosure-web-fetch-'))
const conversationId = 'conv-web-fetch'

beforeAll(async () => {
    server = createServer((req, res) => {
        if (req.url === '/moved') {
            res.writeHead(302, { Location: '/article' }).end()
            return
        }
        const page = PAGES[req.url ?? '']
        res.writeHead(page?.status ?? (page ? 200 : 404), { 'Content-Type': page?.type ?? 'text/plain', ...page?.headers }).end(page?.body ?? '')
    })
    process.env.CYNOSURE_DATA_DIR = dataDir
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    delete process.env.CYNOSURE_DATA_DIR
    rmSync(dataDir, { recursive: true, force: true })
})

const fetchUrl = (url: unknown) => makeWebFetchTool().execute({ url })
const download = (url: string) => makeWebFetchTool({ conversationId }).execute({ url })
const linkedPath = (output: string) => extractFilePathFromFileUrl(output.match(/Link: (\S+)/)?.[1] ?? '')

describe('web_fetch', () => {
    it('is registered as a read-only built-in web tool', () => {
        const tool = makeWebFetchTool()
        expect(BUILTIN_TOOL_NAMES).toContain('web_fetch')
        expect(getBuiltInToolKey('web_fetch')).toBe('builtin:web::web_fetch')
        expect(tool.execution?.readOnly).toBe(tool.annotations?.readOnlyHint)
        expect(isReadOnlyModeTool(tool)).toBe(true)
    })

    it('returns the main content of an HTML page as Markdown', async () => {
        const result = await fetchUrl(`${base}/article`)

        expect(result.success).toBe(true)
        expect(result.output).toContain('# Release notes')
        expect(result.output).toContain(`URL: ${base}/article`)
        expect(result.output).toContain(`[tool documentation](${base}/docs/tools)`)
        expect(result.output).not.toContain('Copyright footer')
    })

    it('reports the final URL after redirects', async () => {
        const result = await fetchUrl(`${base}/moved`)

        expect(result.success).toBe(true)
        expect(result.output).toContain(`URL: ${base}/article`)
    })

    it('suggests a browser tool when a page has no readable content', async () => {
        const result = await fetchUrl(`${base}/empty`)

        expect(result.success).toBe(false)
        expect(result.output).toContain('browser tool')
    })

    it('returns text responses as is', async () => {
        const result = await fetchUrl(`${base}/data.json`)

        expect(result.success).toBe(true)
        expect(result.output).toContain('{"ok":true}')
    })

    it('refuses HTTP errors and invalid URLs', async () => {
        expect(await fetchUrl(`${base}/missing`)).toMatchObject({ success: false, output: expect.stringContaining('HTTP 404') })
        expect(await fetchUrl('file:///etc/passwd')).toMatchObject({ success: false, output: expect.stringContaining('http') })
        expect(await fetchUrl('not a url')).toMatchObject({ success: false })
    })

    it('refuses files outside a conversation', async () => {
        expect(await fetchUrl(`${base}/image.png`)).toMatchObject({ success: false, output: expect.stringContaining('image/png') })
    })

    it('saves a linked image to the conversation image store and attaches it for vision', async () => {
        const result = await download(`${base}/image.png`)

        expect(result.success).toBe(true)
        expect(result.output).toContain('image.png')
        expect(result.images).toHaveLength(1)
        expect(result.imageDataUrls?.[0]).toMatch(/^data:image\/png;base64,/)
        const saved = extractFilePathFromFileUrl(result.images![0])!
        expect(saved.startsWith(join(getConversationArtifactsDir(conversationId), 'images'))).toBe(true)
        expect(existsSync(saved)).toBe(true)
    })

    it('saves video as a linked download the user can play', async () => {
        const result = await download(`${base}/clip.mp4`)

        expect(result.success).toBe(true)
        expect(result.images).toBeUndefined()
        const saved = linkedPath(result.output)!
        expect(saved.startsWith(join(getConversationArtifactsDir(conversationId), 'downloads'))).toBe(true)
        expect(saved.endsWith('/clip.mp4')).toBe(true)
        expect(existsSync(saved)).toBe(true)
    })

    it('names an attachment from Content-Disposition and lists zip contents', async () => {
        const result = await download(`${base}/get?id=7`)

        expect(result.success).toBe(true)
        expect(linkedPath(result.output)?.endsWith('/source_code.zip')).toBe(true)
        expect(result.output).toContain('Archive contents (2 files)')
        expect(result.output).toContain('- src/main.ts')
    })

    it('reads SVG as text instead of saving it as an image', async () => {
        const result = await download(`${base}/logo.svg`)

        expect(result.success).toBe(true)
        expect(result.images).toBeUndefined()
        expect(result.output).toContain('<svg')
        expect(readdirSync(dataDir, { recursive: true }).some((entry) => String(entry).endsWith('.svg'))).toBe(false)
    })
})

describe('downloadFileName', () => {
    it('keeps names inside the download folder', () => {
        expect(downloadFileName('attachment; filename="../../.bashrc"', 'https://example.com/x', '')).toBe('bashrc')
        expect(downloadFileName(null, 'https://example.com/a%2F..%2F..%2Fb.zip', 'application/zip')).toBe('a_._._b.zip')
        expect(downloadFileName(null, 'https://example.com/', '')).toBe('download')
    })

    it('prefers the encoded Content-Disposition name and adds a missing extension', () => {
        expect(downloadFileName(`attachment; filename="x.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9.pdf`, 'https://example.com/x', '')).toBe('Résumé.pdf')
        expect(downloadFileName(null, 'https://cdn.example.com/media/12345', 'video/mp4')).toBe('12345.mp4')
    })
})
