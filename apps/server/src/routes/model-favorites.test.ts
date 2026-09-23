import Fastify from 'fastify'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const favoritesMocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }))
vi.mock('../core/model-favorites.js', () => ({
    getModelFavorites: favoritesMocks.get,
    saveModelFavorites: favoritesMocks.save,
}))
import { registerModelFavoritesRoutes } from './model-favorites.js'

describe('model favorite routes', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        favoritesMocks.get.mockReturnValue({ initialized: false, favorites: [] })
        favoritesMocks.save.mockImplementation(favorites => favorites)
    })

    test('reads and saves favorites in app settings', async () => {
        const app = Fastify()
        await app.register(registerModelFavoritesRoutes, { prefix: '/model-favorites' })
        const favorite = { providerId: 'provider', model: 'model', modelType: 'llm', label: 'model' }
        expect((await app.inject({ method: 'GET', url: '/model-favorites' })).json())
            .toEqual({ initialized: false, favorites: [] })
        const response = await app.inject({ method: 'PUT', url: '/model-favorites', payload: { favorites: [favorite] } })
        expect(response.statusCode).toBe(200)
        expect(favoritesMocks.save).toHaveBeenCalledWith([favorite])
        await app.close()
    })

    test('rejects invalid favorites', async () => {
        const app = Fastify()
        await app.register(registerModelFavoritesRoutes, { prefix: '/model-favorites' })
        const response = await app.inject({ method: 'PUT', url: '/model-favorites', payload: { favorites: [{ model: 'missing-provider' }] } })
        expect(response.statusCode).toBe(400)
        expect(favoritesMocks.save).not.toHaveBeenCalled()
        await app.close()
    })
})
