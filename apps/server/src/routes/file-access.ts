import type { FastifyInstance } from 'fastify'
import { addFileAccessRoot, listFileAccessRoots, removeFileAccessRoot } from '../core/tools/builtin/file-access-policy.js'

export async function registerFileAccessRoutes(app: FastifyInstance): Promise<void> {
    app.get('/', async () => ({ folders: listFileAccessRoots() }))

    app.post<{ Body: { path?: unknown } }>('/', async (request, reply) => {
        if (typeof request.body?.path !== 'string') return reply.status(400).send({ error: 'Enter an absolute folder path.' })
        try {
            return { folders: await addFileAccessRoot(request.body.path) }
        } catch (error) {
            return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) })
        }
    })

    app.delete<{ Querystring: { path?: string } }>('/', async (request, reply) => {
        if (typeof request.query?.path !== 'string') return reply.status(400).send({ error: 'Folder path is required.' })
        try {
            return { folders: removeFileAccessRoot(request.query.path) }
        } catch (error) {
            return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) })
        }
    })
}
