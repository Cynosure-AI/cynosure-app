import type { FastifyInstance } from 'fastify'
import { existsSync, createReadStream, statSync } from 'fs'
import { resolve, extname, isAbsolute } from 'path'

const ALLOWED_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
    '.mp4', '.webm', '.ogg', '.mp3', '.wav', '.flac',
    '.pdf'
])

const MIME_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogg': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.pdf': 'application/pdf'
}

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
    app.get('/', async (req, reply) => {
        const { path: filePath } = req.query as { path?: string }

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
        reply.header('Content-Length', stat.size)
        reply.header('Cache-Control', 'public, max-age=3600')

        return reply.send(createReadStream(resolved))
    })
}
