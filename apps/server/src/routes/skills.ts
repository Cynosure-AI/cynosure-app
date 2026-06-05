import type { FastifyInstance } from 'fastify'
import {
    createSkill,
    deleteSkill,
    getSkill,
    listSkills,
    updateSkill,
    type CreateSkillInput,
    type UpdateSkillInput,
} from '../core/skills/skill-store.js'

export async function registerSkillRoutes(app: FastifyInstance): Promise<void> {
    app.get('/', async () => listSkills())

    app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
        const skill = getSkill(req.params.id)
        if (!skill) {
            reply.code(404)
            return { error: 'Skill not found' }
        }
        return skill
    })

    app.post<{ Body: CreateSkillInput }>('/', async (req, reply) => {
        try {
            return createSkill(req.body)
        } catch (err) {
            return reply.status(400).send({ error: (err as Error).message })
        }
    })

    app.put<{ Params: { id: string }; Body: UpdateSkillInput }>('/:id', async (req, reply) => {
        try {
            const skill = updateSkill(req.params.id, req.body)
            if (!skill) {
                reply.code(404)
                return { error: 'Skill not found' }
            }
            return skill
        } catch (err) {
            return reply.status(400).send({ error: (err as Error).message })
        }
    })

    app.delete<{ Params: { id: string } }>('/:id', async (req) => {
        return { success: deleteSkill(req.params.id) }
    })
}
