import Fastify from 'fastify'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const settingsMocks = vi.hoisted(() => ({
    get: vi.fn(),
    save: vi.fn(),
}))

vi.mock('../core/user-settings.js', () => ({
    MAX_USER_INSTRUCTIONS_LENGTH: 4_000,
    getUserSettings: settingsMocks.get,
    saveUserSettings: settingsMocks.save,
}))

import { registerUserSettingsRoutes } from './user-settings.js'

describe('user settings routes', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        settingsMocks.get.mockReturnValue({ name: '', avatarUrl: null })
        settingsMocks.save.mockImplementation(profile => profile)
    })

    test('saves a supported user avatar with the profile', async () => {
        const app = Fastify()
        await app.register(registerUserSettingsRoutes, { prefix: '/user-settings' })

        const response = await app.inject({
            method: 'PUT',
            url: '/user-settings',
            payload: { name: 'Ada', avatarUrl: 'data:image/webp;base64,AAAA' },
        })

        expect(response.statusCode).toBe(200)
        expect(settingsMocks.save).toHaveBeenCalledWith({
            name: 'Ada',
            avatarUrl: 'data:image/webp;base64,AAAA',
        })
        await app.close()
    })

    test('saves instructions on their own', async () => {
        const app = Fastify()
        await app.register(registerUserSettingsRoutes, { prefix: '/user-settings' })

        const response = await app.inject({
            method: 'PUT',
            url: '/user-settings',
            payload: { instructions: 'Keep answers short.' },
        })

        expect(response.statusCode).toBe(200)
        expect(settingsMocks.save).toHaveBeenCalledWith({
            name: undefined,
            avatarUrl: undefined,
            instructions: 'Keep answers short.',
        })
        await app.close()
    })

    test('rejects instructions over the length limit instead of truncating them', async () => {
        const app = Fastify()
        await app.register(registerUserSettingsRoutes, { prefix: '/user-settings' })

        const response = await app.inject({
            method: 'PUT',
            url: '/user-settings',
            payload: { instructions: 'x'.repeat(4_001) },
        })

        expect(response.statusCode).toBe(400)
        expect(settingsMocks.save).not.toHaveBeenCalled()
        await app.close()
    })

    test('rejects unsupported image data', async () => {
        const app = Fastify()
        await app.register(registerUserSettingsRoutes, { prefix: '/user-settings' })

        const response = await app.inject({
            method: 'PUT',
            url: '/user-settings',
            payload: { name: 'Ada', avatarUrl: 'data:image/svg+xml;base64,AAAA' },
        })

        expect(response.statusCode).toBe(400)
        expect(settingsMocks.save).not.toHaveBeenCalled()
        await app.close()
    })
})
