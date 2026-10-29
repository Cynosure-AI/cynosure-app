import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { makeWebFetchTool } from './web-fetch.js'
import { BUILTIN_TOOL_NAMES, getBuiltInToolKey } from '../built-in-tools.js'
import { isReadOnlyModeTool } from '../tool-policy.js'

const ARTICLE = `<!doctype html><html><head><title>Release notes</title></head><body>
<nav><a href="/">Home</a><a href="/docs">Docs</a></nav>
<article><h1>Release notes</h1>
<p>This release adds a built-in web fetch tool that reads pages and returns their main content as Markdown.
See the <a href="/docs/tools">tool documentation</a> for details about every option and its default value.</p>
</article><footer>Copyright footer text</footer></body></html>`

const PAGES: Record<string, { type: string; body: string; status?: number }> = {
    '/article': { type: 'text/html; charset=utf-8', body: ARTICLE },
    '/empty': { type: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>' },
    '/data.json': { type: 'application/json', body: '{"ok":true}' },
    '/image.png': { type: 'image/png', body: 'png' },
    '/missing': { type: 'text/plain', body: 'nope', status: 404 },
}

let server: Server
let base: string

beforeAll(async () => {
    server = createServer((req, res) => {
        if (req.url === '/moved') {
            res.writeHead(302, { Location: '/article' }).end()
            return
        }
        const page = PAGES[req.url ?? '']
        res.writeHead(page?.status ?? (page ? 200 : 404), { 'Content-Type': page?.type ?? 'text/plain' }).end(page?.body ?? '')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const fetchUrl = (url: unknown) => makeWebFetchTool().execute({ url })

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

    it('refuses binary responses, HTTP errors and invalid URLs', async () => {
        expect(await fetchUrl(`${base}/image.png`)).toMatchObject({ success: false, output: expect.stringContaining('image/png') })
        expect(await fetchUrl(`${base}/missing`)).toMatchObject({ success: false, output: expect.stringContaining('HTTP 404') })
        expect(await fetchUrl('file:///etc/passwd')).toMatchObject({ success: false, output: expect.stringContaining('http') })
        expect(await fetchUrl('not a url')).toMatchObject({ success: false })
    })
})
