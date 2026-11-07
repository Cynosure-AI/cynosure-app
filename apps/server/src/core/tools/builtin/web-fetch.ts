import { mkdirSync, rmSync } from 'fs'
import { open, readFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { parseHTML } from 'linkedom'
import { Defuddle } from 'defuddle/node'
import AdmZip from 'adm-zip'
import { nanoid } from 'nanoid'
import type { ToolDefinition, ToolResult } from '../../gateway/providers/base.provider.js'
import { getConversationArtifactsDir, materializeMediaBuffer, toFileUrl } from '../../artifacts/image-artifacts.js'
import { isServableFile } from '../../artifacts/servable-files.js'
import { isParseableDocument, parseDocument } from '../../utils/document-parser.js'

const FETCH_TIMEOUT_MS = 30_000
// Once a file download has started, its body may take this long.
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000
// Large output is saved as session content by the executor; this only bounds memory.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024
// Images above this are kept for the user but not sent to the model, which providers would refuse.
const MAX_VISION_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
// Documents and archives are only opened in memory up to this size.
const MAX_INSPECT_BYTES = 100 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 200
// Fewer extracted words than this usually means a script-rendered page or a blocked request.
const MIN_USABLE_WORDS = 20
const USER_AGENT = 'Mozilla/5.0 (compatible; Cynosure web_fetch)'
const BROWSER_HINT = 'If the page needs JavaScript or a login, use a browser tool instead (for example the Playwright Browser MCP server).'

const HTML_TYPES = ['text/html', 'application/xhtml+xml']
// SVG is read as text: served from the app's origin it could run scripts, so it is never saved as an image.
const TEXT_TYPES = ['text/', 'application/json', 'application/xml', 'application/javascript', 'application/ld+json', 'application/rss+xml', 'application/atom+xml', 'image/svg+xml']
// Servers often send files as octet-stream or without a type; these extensions are still read as text.
const TEXT_EXTENSIONS = new Set(['', '.html', '.htm', '.txt', '.md', '.markdown', '.json', '.xml', '.csv', '.tsv', '.yaml', '.yml', '.svg', '.js', '.ts', '.css'])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov'])
const AUDIO_EXTENSIONS = new Set(['.ogg', '.mp3', '.wav', '.flac', '.m4a', '.aac'])

const EXTENSION_BY_TYPE: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/avif': '.avif',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/flac': '.flac', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
    'application/pdf': '.pdf', 'application/zip': '.zip', 'application/x-zip-compressed': '.zip',
    'application/gzip': '.gz', 'application/x-gzip': '.gz', 'application/x-tar': '.tar',
    'application/x-7z-compressed': '.7z', 'application/vnd.rar': '.rar', 'application/x-rar-compressed': '.rar',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
}

const TYPE_BY_IMAGE_EXTENSION: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
}

export interface WebFetchToolOptions {
    /** Conversation whose artifacts folder receives downloaded files. Without it, files are refused. */
    conversationId?: string
}

export function makeWebFetchTool(options: WebFetchToolOptions = {}): ToolDefinition {
    return {
        name: 'web_fetch',
        description: `Fetch a URL. A web page comes back as Markdown with its main content only, without navigation, ads and other clutter; plain-text responses such as JSON, XML or Markdown come back as is. A direct link to a file (an image, video, audio file, PDF, office document, archive or other download) saves the file in this conversation and shows it to the user: images are also shown to you, documents come back with their text, and zip archives with their file list. It makes a single HTTP GET request without running JavaScript, so pages rendered by scripts or behind a login may come back empty. ${BROWSER_HINT}`,
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
        timeout: FETCH_TIMEOUT_MS + DOWNLOAD_TIMEOUT_MS + 10_000,
        // Downloads go to the conversation's own artifacts folder, which is app state, not the user's files.
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        execution: { readOnly: true },
        async execute(params: unknown, signal?: AbortSignal): Promise<ToolResult> {
            const input = params as { url?: unknown }
            const url = parseUrl(input.url)
            if (!url) return { success: false, output: 'url must be an absolute http:// or https:// URL.' }
            const timer = new FetchTimer()
            try {
                return await fetchUrl(url, signal ? AbortSignal.any([signal, timer.signal]) : timer.signal, timer, options.conversationId)
            } catch (error) {
                if (signal?.aborted) throw error
                const message = timer.signal.aborted ? (timer.signal.reason as Error).message : (error as Error).message
                return { success: false, output: `Could not fetch ${url.href}: ${message}` }
            } finally {
                timer.clear()
            }
        },
    }
}

/** One abort signal whose deadline is extended once a download starts. */
class FetchTimer {
    private readonly controller = new AbortController()
    private timer: NodeJS.Timeout | undefined
    readonly signal = this.controller.signal

    constructor() { this.restart(FETCH_TIMEOUT_MS) }

    restart(ms: number): void {
        clearTimeout(this.timer)
        this.timer = setTimeout(() => {
            const error = new Error(`Request timed out after ${ms / 1000} seconds.`)
            error.name = 'TimeoutError'
            this.controller.abort(error)
        }, ms)
    }

    clear(): void { clearTimeout(this.timer) }
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

async function fetchUrl(url: URL, signal: AbortSignal, timer: FetchTimer, conversationId: string | undefined): Promise<ToolResult> {
    const response = await fetch(url, {
        redirect: 'follow',
        signal,
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
    if (isTextResponse(contentType, finalUrl, response.headers.get('content-disposition'))) return readTextResponse(response, finalUrl, contentType)

    timer.restart(DOWNLOAD_TIMEOUT_MS)
    return downloadFile(response, finalUrl, contentType, conversationId)
}

function isTextResponse(contentType: string, finalUrl: string, disposition: string | null): boolean {
    if (HTML_TYPES.includes(contentType) || TEXT_TYPES.some((type) => contentType.startsWith(type))) return true
    if (contentType && contentType !== 'application/octet-stream') return false
    // Without a usable type, the file name decides; a named attachment without a text extension is a file.
    const attachmentName = dispositionFileName(disposition)
    if (attachmentName) {
        const ext = extname(attachmentName).toLowerCase()
        return ext !== '' && TEXT_EXTENSIONS.has(ext)
    }
    return TEXT_EXTENSIONS.has(extname(new URL(finalUrl).pathname).toLowerCase())
}

async function readTextResponse(response: Response, finalUrl: string, contentType: string): Promise<ToolResult> {
    const isHtml = HTML_TYPES.includes(contentType)
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

// ─── File downloads ────────────────────────────────────────

async function downloadFile(response: Response, finalUrl: string, contentType: string, conversationId: string | undefined): Promise<ToolResult> {
    const typeLabel = contentType || 'an unknown type'
    if (!conversationId) {
        await response.body?.cancel()
        return { success: false, output: `${finalUrl} returned ${typeLabel}. Files can only be downloaded in a conversation.` }
    }
    const declaredBytes = Number(response.headers.get('content-length') || 0)
    if (declaredBytes > MAX_DOWNLOAD_BYTES) {
        await response.body?.cancel()
        return { success: false, output: `${finalUrl} is ${formatBytes(declaredBytes)}, over the ${formatBytes(MAX_DOWNLOAD_BYTES)} download limit.` }
    }

    const name = downloadFileName(response.headers.get('content-disposition'), finalUrl, contentType)
    const dir = join(getConversationArtifactsDir(conversationId), 'downloads', nanoid(10))
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, name)
    let bytes: number | undefined
    try {
        bytes = await writeBody(response, filePath)
    } finally {
        if (bytes === undefined) rmSync(dir, { recursive: true, force: true })
    }
    if (bytes > MAX_DOWNLOAD_BYTES) {
        rmSync(dir, { recursive: true, force: true })
        return { success: false, output: `${finalUrl} is larger than the ${formatBytes(MAX_DOWNLOAD_BYTES)} download limit, so the download was stopped.` }
    }

    const ext = extname(name).toLowerCase()
    const summary = `Downloaded ${finalUrl}\nFile: ${name} (${formatBytes(bytes)}, ${contentType || 'unknown type'})`
    if (IMAGE_EXTENSIONS.has(ext) && bytes <= MAX_IMAGE_BYTES) {
        return describeImage(filePath, dir, ext, contentType, bytes, summary, conversationId)
    }

    const lines = [summary, `Saved at: ${filePath}`]
    if (isServableFile(filePath)) lines.push(`Link: ${toFileUrl(filePath)}`)
    if (VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext)) {
        lines.push(`The user can play it from the link in the chat. You cannot ${VIDEO_EXTENSIONS.has(ext) ? 'watch' : 'listen to'} it yourself.`)
    } else if (IMAGE_EXTENSIONS.has(ext)) {
        lines.push(`The image is over ${formatBytes(MAX_IMAGE_BYTES)}, so it was saved but not shown.`)
    } else if (bytes <= MAX_INSPECT_BYTES) {
        lines.push(...await inspectFile(filePath, name))
    }
    return { success: true, output: lines.join('\n') }
}

async function writeBody(response: Response, filePath: string): Promise<number> {
    const file = await open(filePath, 'w')
    let bytes = 0
    try {
        if (!response.body) return 0
        const reader = response.body.getReader()
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.length
            if (bytes > MAX_DOWNLOAD_BYTES) {
                await reader.cancel()
                break
            }
            await file.write(value)
        }
    } finally {
        await file.close()
    }
    return bytes
}

/** Images go to the conversation's image store, which the chat shows and vision models can read. */
async function describeImage(filePath: string, dir: string, ext: string, contentType: string, bytes: number, summary: string, conversationId: string): Promise<ToolResult> {
    const mimeType = contentType.startsWith('image/') ? contentType : TYPE_BY_IMAGE_EXTENSION[ext]
    const data = await readFile(filePath)
    const artifact = materializeMediaBuffer(data, mimeType, conversationId, 'image')
    rmSync(dir, { recursive: true, force: true })
    const visible = bytes <= MAX_VISION_IMAGE_BYTES
    return {
        success: true,
        output: `${summary}\nThe image is shown to the user in the chat${visible ? ' and attached for you to view' : `; it is over ${formatBytes(MAX_VISION_IMAGE_BYTES)}, so it is not attached for you`}.`,
        images: [artifact.url],
        imageDataUrls: visible ? [`data:${mimeType};base64,${data.toString('base64')}`] : undefined,
    }
}

/** Text the model can use from a saved document or archive. */
async function inspectFile(filePath: string, name: string): Promise<string[]> {
    try {
        if (isParseableDocument(name)) {
            const text = (await parseDocument(await readFile(filePath), name)).trim()
            return text ? ['', '## Document text', '', text] : ['No text could be extracted from the document.']
        }
        if (extname(name).toLowerCase() === '.zip') {
            const entries = new AdmZip(filePath).getEntries().filter((entry) => !entry.isDirectory)
            const listed = entries.slice(0, MAX_ARCHIVE_ENTRIES).map((entry) => `- ${entry.entryName} (${formatBytes(entry.header.size)})`)
            const more = entries.length > MAX_ARCHIVE_ENTRIES ? [`- … ${entries.length - MAX_ARCHIVE_ENTRIES} more files`] : []
            return ['', `## Archive contents (${entries.length} files)`, '', ...listed, ...more]
        }
    } catch (error) {
        return [`The file was saved, but could not be read: ${(error as Error).message}`]
    }
    return []
}

/** A safe file name from Content-Disposition or the URL, with an extension matching the content type. */
export function downloadFileName(disposition: string | null, finalUrl: string, contentType: string): string {
    let name = dispositionFileName(disposition)
    if (!name) {
        try { name = decodeURIComponent(basename(new URL(finalUrl).pathname)) } catch { name = basename(new URL(finalUrl).pathname) }
    }
    name = name
        .replace(/[^\p{L}\p{N}._()-]+/gu, '_')
        .replace(/\.{2,}/g, '.')
        .replace(/^[._]+/, '')
        .slice(-120)
    const typeExt = EXTENSION_BY_TYPE[contentType]
    if (!name) name = 'download'
    if (typeExt && !extname(name)) name += typeExt
    return name
}

function dispositionFileName(disposition: string | null): string | undefined {
    if (!disposition) return undefined
    const encoded = disposition.match(/filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/)
    if (encoded) {
        try { return decodeURIComponent(encoded[1].trim()) } catch { /* fall back to the plain name */ }
    }
    return disposition.match(/filename\s*=\s*"([^"]*)"/)?.[1] ?? disposition.match(/filename\s*=\s*([^;]+)/)?.[1]?.trim()
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
