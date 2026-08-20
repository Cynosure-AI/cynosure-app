import type { FastifyInstance } from 'fastify'
import { getUserSettings, saveUserSettings } from '../core/user-settings.js'

export async function registerUserSettingsRoutes(app: FastifyInstance) {
    app.get('/', async () => getUserSettings())

    app.put<{ Body: { name?: unknown } }>('/', async (request, reply) => {
        if (typeof request.body?.name !== 'string') {
            return reply.status(400).send({ error: 'Name must be a string' })
        }

        return saveUserSettings({ name: request.body.name })
    })
}
