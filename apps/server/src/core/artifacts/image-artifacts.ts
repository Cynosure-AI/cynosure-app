import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { basename, extname, isAbsolute, join, resolve } from 'path'
import { getAppDataDir } from '../data-dir.js'
import { nanoid } from 'nanoid'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])
const MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024

export interface ImageArtifact {
    path: string
    url: string
    mimeType?: string
}

export function getConversationArtifactsDir(conversationId: string): string {
    return join(getAppDataDir(), 'artifacts', 'conversations', conversationId)
}

function getConversationImagesDir(conversationId: string): string {
    const dir = join(getConversationArtifactsDir(conversationId), 'images')
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
    const lower = mimeType?.toLowerCase()
    switch (lower) {
        case 'image/png': return 'png'
        case 'image/jpeg':
        case 'image/jpg': return 'jpg'
        case 'image/gif': return 'gif'
        case 'image/webp': return 'webp'
        case 'image/bmp': return 'bmp'
        case 'image/svg+xml': return 'svg'
        default: return null
    }
}

function extFromPath(pathOrUrl: string): string | null {
    try {
        const sourcePath = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')
            ? new URL(pathOrUrl).pathname
            : pathOrUrl
        const ext = extname(sourcePath).toLowerCase()
        if (!IMAGE_EXTENSIONS.has(ext)) return null
        return ext.slice(1).replace('jpeg', 'jpg')
    } catch {
        return null
    }
}

function safeFilename(ext: string): string {
    return `${Date.now()}-${nanoid()}.${ext}`
}

function artifactForExistingPath(filePath: string): ImageArtifact {
    return { path: filePath, url: toFileUrl(filePath) }
}

function isInsideDirectory(filePath: string, dir: string): boolean {
    const resolvedFile = resolve(filePath)
    const resolvedDir = resolve(dir)
    return resolvedFile === resolvedDir || resolvedFile.startsWith(`${resolvedDir}/`)
}

function writeArtifact(conversationId: string, data: Buffer, ext: string, mimeType?: string): ImageArtifact {
    const dir = getConversationImagesDir(conversationId)
    const filePath = join(dir, safeFilename(ext))
    writeFileSync(filePath, data)
    return { path: filePath, url: toFileUrl(filePath), mimeType }
}

function copyArtifact(conversationId: string, sourcePath: string): ImageArtifact {
    const dir = getConversationImagesDir(conversationId)
    if (isInsideDirectory(sourcePath, dir)) return artifactForExistingPath(sourcePath)

    const ext = extFromPath(sourcePath) || 'png'
    const hash = createHash('sha1').update(sourcePath).digest('hex').slice(0, 10)
    const filename = `${Date.now()}-${hash}-${basename(sourcePath).replace(/[^A-Za-z0-9._-]/g, '_') || `image.${ext}`}`
    const targetPath = join(dir, filename.endsWith(`.${ext}`) ? filename : `${filename}.${ext}`)
    copyFileSync(sourcePath, targetPath)
    return artifactForExistingPath(targetPath)
}

async function fetchRemoteImage(source: string): Promise<{ data: Buffer; mimeType?: string }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
        const res = await fetch(source, { signal: controller.signal })
        if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`)

        const contentType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
        if (contentType && !contentType.startsWith('image/')) {
            throw new Error(`Remote URL is not an image (${contentType})`)
        }

        const contentLength = Number(res.headers.get('content-length') || '0')
        if (contentLength > MAX_REMOTE_IMAGE_BYTES) {
            throw new Error('Remote image is too large')
        }

        const arrayBuffer = await res.arrayBuffer()
        if (arrayBuffer.byteLength > MAX_REMOTE_IMAGE_BYTES) {
            throw new Error('Remote image is too large')
        }

        return { data: Buffer.from(arrayBuffer), mimeType: contentType || undefined }
    } finally {
        clearTimeout(timeout)
    }
}

export async function materializeImageArtifact(source: string, conversationId: string): Promise<ImageArtifact> {
    const fileUrlPath = extractFilePathFromFileUrl(source)
    if (fileUrlPath) {
        return copyArtifact(conversationId, fileUrlPath)
    }

    if (isAbsolute(source)) {
        return copyArtifact(conversationId, source)
    }

    const dataUrlMatch = source.match(/^data:(image\/[^;,]+)(?:;[^,]*)?;base64,(.+)$/)
    if (dataUrlMatch) {
        const mimeType = dataUrlMatch[1]
        const ext = mimeToExt(mimeType) || 'png'
        return writeArtifact(conversationId, Buffer.from(dataUrlMatch[2], 'base64'), ext, mimeType)
    }

    if (source.startsWith('http://') || source.startsWith('https://')) {
        const { data, mimeType } = await fetchRemoteImage(source)
        const ext = mimeToExt(mimeType) || extFromPath(source) || 'png'
        return writeArtifact(conversationId, data, ext, mimeType)
    }

    throw new Error('Unsupported image source')
}

export async function materializeImageArtifacts(sources: string[], conversationId: string): Promise<ImageArtifact[]> {
    const artifacts: ImageArtifact[] = []
    for (const source of sources) {
        artifacts.push(await materializeImageArtifact(source, conversationId))
    }
    return artifacts
}
