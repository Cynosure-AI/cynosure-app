import type { FastifyInstance, FastifyReply } from 'fastify'
import { existsSync, createReadStream, statSync, type Stats } from 'fs'
import { basename, resolve, extname, isAbsolute } from 'path'
import { canRenderDocumentThumbnail, getDocumentThumbnail } from '../core/artifacts/document-thumbnails.js'

const ALLOWED_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif',
    '.mp4', '.webm', '.mov', '.ogg', '.mp3', '.wav', '.flac', '.m4a', '.aac',
    '.pdf', '.docx', '.doc', '.odt', '.rtf', '.txt', '.md', '.csv', '.tsv',
    '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.json'
])

const MIME_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.avif': 'image/avif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.ogg': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.rtf': 'application/rtf',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.tsv': 'text/tab-separated-values; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.zip': 'application/zip'
}

type ResolvedFile = { resolved: string; ext: string; stat: Stats }

/** Validates the `path` query parameter, sending the error response itself when it fails. */
function resolveAllowedFile(filePath: unknown, reply: FastifyReply): ResolvedFile | null {
    if (!filePath || typeof filePath !== 'string') {
        reply.status(400).send({ error: 'Missing "path" query parameter' })
        return null
    }

    // Validate: must be absolute and contain no traversal segments
    if (!isAbsolute(filePath) || filePath.includes('..')) {
        reply.status(400).send({ error: 'Invalid file path' })
        return null
    }
    const resolved = resolve(filePath)

    const ext = extname(resolved).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        reply.status(403).send({ error: 'File type not allowed' })
        return null
    }

    if (!existsSync(resolved)) {
        reply.status(404).send({ error: 'File not found' })
        return null
    }

    const stat = statSync(resolved)
    if (!stat.isFile()) {
        reply.status(400).send({ error: 'Not a file' })
        return null
    }

    return { resolved, ext, stat }
}

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
    app.get('/', async (req, reply) => {
        const { path: filePath, name } = req.query as { path?: string; name?: string }
        const file = resolveAllowedFile(filePath, reply)
        if (!file) return reply
        const { resolved, ext, stat } = file

        const mime = MIME_TYPES[ext] || 'application/octet-stream'
        reply.header('Content-Type', mime)
        const inlineDocument = ext === '.pdf' || ext === '.txt' || ext === '.md' || ext === '.csv' || ext === '.tsv' || ext === '.json'
        if (!mime.startsWith('image/') && !mime.startsWith('audio/') && !mime.startsWith('video/') && !inlineDocument) {
            const downloadName = basename(name || resolved).replace(/["\r\n]/g, '') || 'download'
            const asciiName = downloadName.replace(/[^\x20-\x7E]/g, '_')
            reply.header('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`)
        }
        reply.header('Content-Length', stat.size)
        reply.header('Cache-Control', 'public, max-age=3600')

        return reply.send(createReadStream(resolved))
    })

    app.get('/thumbnail', async (req, reply) => {
        const { path: filePath } = req.query as { path?: string }
        const file = resolveAllowedFile(filePath, reply)
        if (!file) return reply
        const { resolved, stat } = file

        if (!canRenderDocumentThumbnail(resolved, stat.size)) {
            return reply.status(415).send({ error: 'No thumbnail available for this file' })
        }

        let thumbnail
        try {
            thumbnail = await getDocumentThumbnail({ path: resolved, sizeBytes: stat.size, modifiedMs: stat.mtimeMs })
        } catch (error) {
            req.log.warn({ err: error, path: resolved }, 'Failed to render document thumbnail')
            return reply.status(422).send({ error: 'Could not render a thumbnail for this file' })
        }

        // The URL only names the path, so revalidate each time; the ETag tracks file changes.
        const etag = `"${thumbnail.etag}"`
        reply.header('ETag', etag)
        reply.header('Cache-Control', 'private, no-cache')
        if (req.headers['if-none-match'] === etag) return reply.status(304).send()

        reply.header('Content-Type', 'image/webp')
        return reply.send(thumbnail.data)
    })
}
