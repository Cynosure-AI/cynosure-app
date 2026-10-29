import { parseHTML } from 'linkedom'
import { Defuddle } from 'defuddle/node'
import type { ToolDefinition, ToolResult } from '../../gateway/providers/base.provider.js'

const FETCH_TIMEOUT_MS = 30_000
// Large output is saved as session content by the executor; this only bounds memory.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
// Fewer extracted words than this usually means a script-rendered page or a blocked request.
const MIN_USABLE_WORDS = 20
const USER_AGENT = 'Mozilla/5.0 (compatible; Cynosure web_fetch)'
const BROWSER_HINT = 'If the page needs JavaScript or a login, use a browser tool instead (for example the Playwright Browser MCP server).'

const HTML_TYPES = ['text/html', 'application/xhtml+xml']
const TEXT_TYPES = ['text/', 'application/json', 'application/xml', 'application/javascript', 'application/ld+json', 'application/rss+xml', 'application/atom+xml']

export function makeWebFetchTool(): ToolDefinition {
    return {
        name: 'web_fetch',
        description: `Fetch a web page by URL and return its main content as Markdown, with navigation, ads and other page clutter removed. Plain-text responses such as JSON, XML or Markdown are returned as is. Use this to read documentation, articles, or other public pages. It makes a single HTTP GET request without running JavaScript, so pages rendered by scripts or behind a login may come back empty. ${BROWSER_HINT}`,
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['url'],
            properties: {
                url: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 8000,
                    description: 'Absolute http:// or https:// URL to fetch.',
                },
            },
        },
        timeout: FETCH_TIMEOUT_MS + 10_000,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        execution: { readOnly: true },
        async execute(params: unknown, signal?: AbortSignal): Promise<ToolResult> {
            const input = params as { url?: unknown }
            const url = parseUrl(input.url)
            if (!url) return { success: false, output: 'url must be an absolute http:// or https:// URL.' }
            try {
                return await fetchPage(url, signal)
            } catch (error) {
                if (signal?.aborted) throw error
                const message = (error as Error).name === 'TimeoutError'
                    ? `Request timed out after ${FETCH_TIMEOUT_MS / 1000} seconds.`
                    : (error as Error).message
                return { success: false, output: `Could not fetch ${url.href}: ${message}` }
            }
        },
    }
}

function parseUrl(value: unknown): URL | undefined {
    if (typeof value !== 'string') return undefined
    try {
        const url = new URL(value.trim())
        return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
    } catch {
        return undefined
    }
}

async function fetchPage(url: URL, signal?: AbortSignal): Promise<ToolResult> {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const response = await fetch(url, {
        redirect: 'follow',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
            'User-Agent': USER_AGENT,
            // Advertising text/markdown makes some sites answer 404 instead of falling back to HTML.
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
    })
    const finalUrl = response.url || url.href
    if (!response.ok) {
        await response.body?.cancel()
        return { success: false, output: `HTTP ${response.status} ${response.statusText} for ${finalUrl}. ${response.status === 401 || response.status === 403 ? BROWSER_HINT : ''}`.trim() }
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const isHtml = HTML_TYPES.includes(contentType)
    if (!isHtml && contentType && !TEXT_TYPES.some((type) => contentType.startsWith(type))) {
        await response.body?.cancel()
        return { success: false, output: `${finalUrl} returned ${contentType}, which web_fetch cannot read. It only reads HTML and text responses.` }
    }

    const { text, truncated } = await readBody(response)
    const note = truncated ? `\n\n[Response truncated at ${MAX_RESPONSE_BYTES / 1024 / 1024} MiB.]` : ''
    if (!isHtml && !looksLikeHtml(text)) {
        return { success: true, output: `URL: ${finalUrl}\nContent-Type: ${contentType || 'unknown'}\n\n${text}${note}` }
    }

    const { document } = parseHTML(text)
    const page = await Defuddle(document, finalUrl, { markdown: true })
    const markdown = page.content.trim()
    if (page.wordCount < MIN_USABLE_WORDS || !markdown) {
        return {
            success: false,
            output: `Fetched ${finalUrl}, but found no readable content (${page.wordCount} words). The page is probably rendered by JavaScript or blocks automated requests. ${BROWSER_HINT}`,
        }
    }

    const header = [
        page.title && `# ${page.title}`,
        `URL: ${finalUrl}`,
        page.author && `Author: ${page.author}`,
        page.published && `Published: ${page.published}`,
    ].filter(Boolean).join('\n')
    return { success: true, output: `${header}\n\n${markdown}${note}` }
}

async function readBody(response: Response): Promise<{ text: string; truncated: boolean }> {
    if (!response.body) return { text: '', truncated: false }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    let truncated = false
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const kept = value.subarray(0, MAX_RESPONSE_BYTES - bytes)
        chunks.push(kept)
        bytes += kept.length
        if (bytes >= MAX_RESPONSE_BYTES) {
            truncated = true
            await reader.cancel()
            break
        }
    }
    return { text: Buffer.concat(chunks).toString('utf8'), truncated }
}

/** Servers sometimes send HTML without a content type or as text/plain. */
function looksLikeHtml(text: string): boolean {
    return /^\s*(<!doctype html|<html[\s>])/i.test(text.slice(0, 512))
}
