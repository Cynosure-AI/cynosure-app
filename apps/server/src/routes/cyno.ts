import type { FastifyInstance } from 'fastify'
import { CynoProfileError, defaultCynoProfile, getCynoProfile, saveCynoProfile } from '../core/cyno/cyno-profile.js'

export async function registerCynoRoutes(app: FastifyInstance) {
    // GET /api/cyno — the default assistant's profile
    app.get('/', async () => getCynoProfile())

    // GET /api/cyno/defaults — factory values, for "reset" actions in the UI
    app.get('/defaults', async () => defaultCynoProfile())

    // PUT /api/cyno — partial update
    app.put<{ Body: Record<string, unknown> }>('/', async (request, reply) => {
        const body = request.body
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return reply.status(400).send({ error: 'Expected a profile object' })
        }
        try {
            return saveCynoProfile(body)
        } catch (error) {
            if (error instanceof CynoProfileError) return reply.status(400).send({ error: error.message })
            throw error
        }
    })
}
