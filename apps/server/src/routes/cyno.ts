import type { FastifyInstance } from 'fastify'
import type { CynoProfile, CynoProfileView } from '@shared/types'
import { CynoProfileError, defaultCynoProfile, getCynoProfile, saveCynoProfile } from '../core/cyno/cyno-profile.js'
import { cynoExecutionConfig } from '../core/cyno/cyno-run.js'

/** The profile with its unset tools and memory resolved, so clients use the same defaults as the server. */
function withEffectiveDefaults(profile: CynoProfile): CynoProfileView {
    const config = cynoExecutionConfig(profile)
    return { ...profile, effective: { tools: config.allowedTools, memoryFolders: config.memoryFolderIds } }
}

export async function registerCynoRoutes(app: FastifyInstance) {
    // GET /api/cyno — the default assistant's profile
    app.get('/', async () => withEffectiveDefaults(getCynoProfile()))

    // GET /api/cyno/defaults — factory values, for "reset" actions in the UI
    app.get('/defaults', async () => withEffectiveDefaults(defaultCynoProfile()))

    // PUT /api/cyno — partial update
    app.put<{ Body: Record<string, unknown> }>('/', async (request, reply) => {
        const body = request.body
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return reply.status(400).send({ error: 'Expected a profile object' })
        }
        try {
            return withEffectiveDefaults(saveCynoProfile(body))
        } catch (error) {
            if (error instanceof CynoProfileError) return reply.status(400).send({ error: error.message })
            throw error
        }
    })
}
