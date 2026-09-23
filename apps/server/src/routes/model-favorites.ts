import type { FastifyInstance } from 'fastify'
import { getModelFavorites, saveModelFavorites, type ModelFavorite } from '../core/model-favorites.js'

export async function registerModelFavoritesRoutes(app: FastifyInstance) {
    app.get('/', async () => getModelFavorites())

    app.put<{ Body: { favorites?: unknown } }>('/', async (request, reply) => {
        const favorites = request.body?.favorites
        if (!Array.isArray(favorites) || favorites.length > 500 || !favorites.every((item): item is ModelFavorite =>
            item !== null && typeof item === 'object'
            && typeof item.providerId === 'string' && item.providerId.length > 0 && item.providerId.length <= 200
            && typeof item.model === 'string' && item.model.length > 0 && item.model.length <= 500
            && typeof item.modelType === 'string' && item.modelType.length <= 50
            && typeof item.label === 'string' && item.label.length <= 500
        )) {
            return reply.status(400).send({ error: 'Invalid model favorites' })
        }
        return { favorites: saveModelFavorites(favorites) }
    })
}
