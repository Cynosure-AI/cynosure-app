import type { FastifyInstance } from 'fastify'
import { getUserSettings, MAX_USER_INSTRUCTIONS_LENGTH, saveUserSettings } from '../core/user-settings.js'

export async function registerUserSettingsRoutes(app: FastifyInstance) {
    app.get('/', async () => getUserSettings())

    app.put<{ Body: { name?: unknown; avatarUrl?: unknown; instructions?: unknown } }>('/', async (request, reply) => {
        const { name, avatarUrl, instructions } = request.body || {}
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
        if (instructions !== undefined && typeof instructions !== 'string') {
            return reply.status(400).send({ error: 'Instructions must be a string' })
        }
        // Rejected rather than truncated: silently dropping the end of an instruction changes its meaning.
        if (typeof instructions === 'string' && instructions.trim().length > MAX_USER_INSTRUCTIONS_LENGTH) {
            return reply.status(400).send({ error: `Instructions must be at most ${MAX_USER_INSTRUCTIONS_LENGTH} characters` })
        }
        if (name === undefined && avatarUrl === undefined && instructions === undefined) {
            return reply.status(400).send({ error: 'No profile changes provided' })
        }

        return saveUserSettings({
            name: typeof name === 'string' ? name : undefined,
            avatarUrl: typeof avatarUrl === 'string' || avatarUrl === null ? avatarUrl : undefined,
            instructions: typeof instructions === 'string' ? instructions : undefined,
        })
    })
}
