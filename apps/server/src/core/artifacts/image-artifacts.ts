import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { basename, extname, isAbsolute, join, resolve } from 'path'
import { getAppDataDir } from '../data-dir.js'
import { nanoid } from 'nanoid'

export type MediaArtifactKind = 'image' | 'video' | 'audio'

const MEDIA_CONFIG: Record<MediaArtifactKind, {
    directory: string
    extensions: Set<string>
    defaultExt: string
    defaultMime: string
    maxRemoteBytes: number
}> = {
    image: {
        directory: 'images',
        extensions: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif']),
        defaultExt: 'png',
        defaultMime: 'image/png',
        maxRemoteBytes: 25 * 1024 * 1024,
    },
    video: {
        directory: 'videos',
        extensions: new Set(['.mp4', '.webm', '.mov']),
        defaultExt: 'mp4',
        defaultMime: 'video/mp4',
        maxRemoteBytes: 1024 * 1024 * 1024,
    },
    audio: {
        directory: 'audio',
        extensions: new Set(['.ogg', '.mp3', '.wav', '.flac', '.m4a', '.aac']),
        defaultExt: 'wav',
        defaultMime: 'audio/wav',
        maxRemoteBytes: 250 * 1024 * 1024,
    },
}

export interface ImageArtifact {
    path: string
    url: string
    mimeType?: string
}

export type MediaArtifact = ImageArtifact

export function getConversationArtifactsDir(conversationId: string): string {
    return join(getAppDataDir(), 'artifacts', 'conversations', conversationId)
}

function getConversationMediaDir(conversationId: string, kind: MediaArtifactKind): string {
    const dir = join(getConversationArtifactsDir(conversationId), MEDIA_CONFIG[kind].directory)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
}

export function cleanupConversationArtifacts(conversationId: string): void {
    try {
        rmSync(getConversationArtifactsDir(conversationId), { recursive: true, force: true })
    } catch {
        // Best-effort cleanup only.
    }
}

export function toFileUrl(filePath: string): string {
    return `/api/files?path=${encodeURIComponent(filePath)}`
}

export function extractFilePathFromFileUrl(url: string): string | null {
    const match = url.match(/\/api\/files\?path=([^&]+)/)
    if (!match) return null
    try {
        return decodeURIComponent(match[1])
    } catch {
        return null
    }
}

function mimeToExt(mimeType: string | undefined): string | null {
    const lower = mimeType?.split(';')[0]?.trim().toLowerCase()
    switch (lower) {
        case 'image/png': return 'png'
        case 'image/jpeg':
        case 'image/jpg': return 'jpg'
        case 'image/gif': return 'gif'
        case 'image/webp': return 'webp'
        case 'image/bmp': return 'bmp'
        case 'image/svg+xml': return 'svg'
        case 'image/avif': return 'avif'
        case 'video/mp4': return 'mp4'
        case 'video/webm': return 'webm'
        case 'video/quicktime': return 'mov'
        case 'audio/ogg': return 'ogg'
        case 'audio/mpeg': return 'mp3'
        case 'audio/wav':
        case 'audio/x-wav':
        case 'audio/wave': return 'wav'
        case 'audio/flac': return 'flac'
        case 'audio/mp4':
        case 'audio/x-m4a': return 'm4a'
        case 'audio/aac': return 'aac'
        default: return null
    }
}

function mediaExtFromMime(mimeType: string | undefined, kind: MediaArtifactKind): string | null {
    const ext = mimeToExt(mimeType)
    return ext && MEDIA_CONFIG[kind].extensions.has(`.${ext}`) ? ext : null
}

function extFromPath(pathOrUrl: string, kind: MediaArtifactKind): string | null {
    try {
        const sourcePath = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')
            ? new URL(pathOrUrl).pathname
            : pathOrUrl
        const ext = extname(sourcePath).toLowerCase()
        if (!MEDIA_CONFIG[kind].extensions.has(ext)) return null
        return ext.slice(1).replace('jpeg', 'jpg')
    } catch {
        return null
    }
}

function safeFilename(ext: string): string {
    return `${Date.now()}-${nanoid()}.${ext}`
}

function artifactForExistingPath(filePath: string): MediaArtifact {
    return { path: filePath, url: toFileUrl(filePath) }
}

function isInsideDirectory(filePath: string, dir: string): boolean {
    const resolvedFile = resolve(filePath)
    const resolvedDir = resolve(dir)
    return resolvedFile === resolvedDir || resolvedFile.startsWith(`${resolvedDir}/`)
}

function writeArtifact(conversationId: string, data: Buffer, ext: string, kind: MediaArtifactKind, mimeType?: string): MediaArtifact {
    const dir = getConversationMediaDir(conversationId, kind)
    const filePath = join(dir, safeFilename(ext))
    writeFileSync(filePath, data)
    return { path: filePath, url: toFileUrl(filePath), mimeType }
}

function copyArtifact(conversationId: string, sourcePath: string, kind: MediaArtifactKind): MediaArtifact {
    const dir = getConversationMediaDir(conversationId, kind)
    if (isInsideDirectory(sourcePath, dir)) return artifactForExistingPath(sourcePath)

    const ext = extFromPath(sourcePath, kind) || MEDIA_CONFIG[kind].defaultExt
    const hash = createHash('sha1').update(sourcePath).digest('hex').slice(0, 10)
    const filename = `${Date.now()}-${hash}-${basename(sourcePath).replace(/[^A-Za-z0-9._-]/g, '_') || `image.${ext}`}`
    const targetPath = join(dir, filename.endsWith(`.${ext}`) ? filename : `${filename}.${ext}`)
    copyFileSync(sourcePath, targetPath)
    return artifactForExistingPath(targetPath)
}

async function fetchRemoteMedia(source: string, kind: MediaArtifactKind): Promise<{ data: Buffer; mimeType?: string }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
        const res = await fetch(source, { signal: controller.signal })
        if (!res.ok) throw new Error(`Failed to fetch ${kind}: ${res.status}`)

        const contentType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
        if (contentType && !contentType.startsWith(`${kind}/`)) {
            throw new Error(`Remote URL is not ${kind} content (${contentType})`)
        }

        const contentLength = Number(res.headers.get('content-length') || '0')
        if (contentLength > MEDIA_CONFIG[kind].maxRemoteBytes) {
            throw new Error(`Remote ${kind} is too large`)
        }

        const arrayBuffer = await res.arrayBuffer()
        if (arrayBuffer.byteLength > MEDIA_CONFIG[kind].maxRemoteBytes) {
            throw new Error(`Remote ${kind} is too large`)
        }

        return { data: Buffer.from(arrayBuffer), mimeType: contentType || undefined }
    } finally {
        clearTimeout(timeout)
    }
}

export function materializeMediaBuffer(
    data: Buffer | ArrayBuffer,
    mimeType: string | undefined,
    conversationId: string,
    kind: MediaArtifactKind,
): MediaArtifact {
    const ext = mediaExtFromMime(mimeType, kind) || MEDIA_CONFIG[kind].defaultExt
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
    return writeArtifact(conversationId, buffer, ext, kind, mimeType)
}

export async function materializeMediaArtifact(
    source: string,
    conversationId: string,
    kind: MediaArtifactKind,
): Promise<MediaArtifact> {
    const fileUrlPath = extractFilePathFromFileUrl(source)
    if (fileUrlPath) {
        return copyArtifact(conversationId, fileUrlPath, kind)
    }

    if (isAbsolute(source)) {
        return copyArtifact(conversationId, source, kind)
    }

    const dataUrlMatch = source.match(new RegExp(`^data:(${kind}\\/[^;,]+)(?:;[^,]*)?;base64,(.+)$`, 'i'))
    if (dataUrlMatch) {
        const mimeType = dataUrlMatch[1]
        return materializeMediaBuffer(Buffer.from(dataUrlMatch[2], 'base64'), mimeType, conversationId, kind)
    }

    if (source.startsWith('http://') || source.startsWith('https://')) {
        const { data, mimeType } = await fetchRemoteMedia(source, kind)
        const ext = mediaExtFromMime(mimeType, kind) || extFromPath(source, kind) || MEDIA_CONFIG[kind].defaultExt
        return writeArtifact(conversationId, data, ext, kind, mimeType)
    }

    throw new Error(`Unsupported ${kind} source`)
}

export async function materializeMediaArtifacts(
    sources: string[],
    conversationId: string,
    kind: MediaArtifactKind,
): Promise<MediaArtifact[]> {
    const artifacts: MediaArtifact[] = []
    for (const source of sources) {
        artifacts.push(await materializeMediaArtifact(source, conversationId, kind))
    }
    return artifacts
}

export async function materializeImageArtifact(source: string, conversationId: string): Promise<ImageArtifact> {
    return materializeMediaArtifact(source, conversationId, 'image')
}

export async function materializeImageArtifacts(sources: string[], conversationId: string): Promise<ImageArtifact[]> {
    return materializeMediaArtifacts(sources, conversationId, 'image')
}

export async function materializeAudioArtifacts(sources: string[], conversationId: string): Promise<MediaArtifact[]> {
    return materializeMediaArtifacts(sources, conversationId, 'audio')
}

export async function materializeVideoArtifacts(sources: string[], conversationId: string): Promise<MediaArtifact[]> {
    return materializeMediaArtifacts(sources, conversationId, 'video')
}

export function artifactFileUrlToDataUrl(source: string): string | null {
    if (source.startsWith('data:')) return source
    const filePath = extractFilePathFromFileUrl(source)
    if (!filePath || !existsSync(filePath)) return null
    const ext = extname(filePath).toLowerCase()
    for (const config of Object.values(MEDIA_CONFIG)) {
        if (!config.extensions.has(ext)) continue
        const mimeType = mimeTypeFromExt(ext) || config.defaultMime
        try {
            return `data:${mimeType};base64,${readFileSync(filePath).toString('base64')}`
        } catch {
            return null
        }
    }
    return null
}

function mimeTypeFromExt(ext: string): string | null {
    switch (ext) {
        case '.png': return 'image/png'
        case '.jpg':
        case '.jpeg': return 'image/jpeg'
        case '.gif': return 'image/gif'
        case '.webp': return 'image/webp'
        case '.bmp': return 'image/bmp'
        case '.svg': return 'image/svg+xml'
        case '.avif': return 'image/avif'
        case '.mp4': return 'video/mp4'
        case '.webm': return 'video/webm'
        case '.mov': return 'video/quicktime'
        case '.ogg': return 'audio/ogg'
        case '.mp3': return 'audio/mpeg'
        case '.wav': return 'audio/wav'
        case '.flac': return 'audio/flac'
        case '.m4a': return 'audio/mp4'
        case '.aac': return 'audio/aac'
        default: return null
    }
}
