import type { FastifyInstance } from 'fastify'
import { getUserSettings, saveUserSettings } from '../core/user-settings.js'

export async function registerUserSettingsRoutes(app: FastifyInstance) {
    app.get('/', async () => getUserSettings())

    app.put<{ Body: { name?: unknown; avatarUrl?: unknown } }>('/', async (request, reply) => {
        const { name, avatarUrl } = request.body || {}
        if (name !== undefined && typeof name !== 'string') {
            return reply.status(400).send({ error: 'Name must be a string' })
        }
        if (avatarUrl !== undefined && avatarUrl !== null && typeof avatarUrl !== 'string') {
            return reply.status(400).send({ error: 'Avatar must be an image or null' })
        }
        if (typeof avatarUrl === 'string' && (
            avatarUrl.length > 2 * 1024 * 1024
            || !/^data:image\/(?:png|jpe?g|webp);base64,/i.test(avatarUrl)
        )) {
            return reply.status(400).send({ error: 'Avatar must be a supported image smaller than 2 MB' })
        }
        if (name === undefined && avatarUrl === undefined) {
            return reply.status(400).send({ error: 'No profile changes provided' })
        }

        return saveUserSettings({
            name: typeof name === 'string' ? name : undefined,
            avatarUrl: typeof avatarUrl === 'string' || avatarUrl === null ? avatarUrl : undefined,
        })
    })
}
