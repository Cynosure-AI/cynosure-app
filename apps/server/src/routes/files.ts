import type { FastifyInstance } from 'fastify'
import { existsSync, createReadStream, statSync } from 'fs'
import { basename, resolve, extname, isAbsolute } from 'path'

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

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
    app.get('/', async (req, reply) => {
        const { path: filePath, name } = req.query as { path?: string; name?: string }

        if (!filePath || typeof filePath !== 'string') {
            return reply.status(400).send({ error: 'Missing "path" query parameter' })
        }

        // Validate: must be absolute and contain no traversal segments
        if (!isAbsolute(filePath) || filePath.includes('..')) {
            return reply.status(400).send({ error: 'Invalid file path' })
        }
        const resolved = resolve(filePath)

        const ext = extname(resolved).toLowerCase()
        if (!ALLOWED_EXTENSIONS.has(ext)) {
            return reply.status(403).send({ error: 'File type not allowed' })
        }

        if (!existsSync(resolved)) {
            return reply.status(404).send({ error: 'File not found' })
        }

        const stat = statSync(resolved)
        if (!stat.isFile()) {
            return reply.status(400).send({ error: 'Not a file' })
        }

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
}
