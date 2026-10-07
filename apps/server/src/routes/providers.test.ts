import Fastify, { type FastifyInstance } from 'fastify'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { closeDb, getDb } from '../db/database.js'
import { getGateway } from '../core/gateway/gateway.js'
import { registerProviderRoutes } from './providers.js'

const localProvider = {
    name: 'LM Studio',
    type: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1/v1',
    defaultModel: 'local-model',
    availableModels: [],
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsVision: true,
}

describe('provider routes', () => {
    let directory: string
    let app: FastifyInstance
    let modelServer: Server | undefined

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'cynosure-providers-'))
        process.env.CYNOSURE_DATA_DIR = directory
        app = Fastify()
        await app.register(registerProviderRoutes, { prefix: '/providers' })
    })

    afterEach(async () => {
        await app.close()
        await new Promise<void>((resolve) => modelServer ? modelServer.close(() => resolve()) : resolve())
        modelServer = undefined
        for (const id of (getDb().prepare('SELECT id FROM providers').all() as { id: string }[]).map((row) => row.id)) {
            getGateway().removeProvider(id)
        }
        closeDb()
        delete process.env.CYNOSURE_DATA_DIR
        await rm(directory, { recursive: true, force: true })
    })

    function storedProviders() {
        return getDb().prepare('SELECT id, name, is_last_used, created_at FROM providers ORDER BY created_at').all() as {
            id: string; name: string; is_last_used: number; created_at: number
        }[]
    }

    test('rejects an unknown provider type without storing it', async () => {
        const response = await app.inject({ method: 'POST', url: '/providers', payload: { ...localProvider, type: 'bogus' } })
        expect(response.statusCode).toBe(400)
        expect(response.json().error).toContain('Unknown provider type')
        expect(storedProviders()).toEqual([])
    })

    test('requires an API key for hosted providers', async () => {
        const response = await app.inject({
            method: 'POST', url: '/providers',
            payload: { ...localProvider, type: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: '  ' },
        })
        expect(response.statusCode).toBe(400)
        expect(response.json().error).toBe('An API key is required for this provider.')
        expect(storedProviders()).toEqual([])
    })

    test('requires both a base URL and an API key for Unsloth Studio', async () => {
        const unsloth = { ...localProvider, type: 'unsloth', name: 'Unsloth Studio', baseUrl: 'http://127.0.0.1:1/v1' }
        const withoutKey = await app.inject({ method: 'POST', url: '/providers', payload: unsloth })
        expect(withoutKey.statusCode).toBe(400)
        expect(withoutKey.json().error).toBe('An API key is required for this provider.')

        const withoutUrl = await app.inject({
            method: 'POST', url: '/providers', payload: { ...unsloth, baseUrl: '', apiKey: 'sk-unsloth-test' },
        })
        expect(withoutUrl.statusCode).toBe(400)
        expect(withoutUrl.json().error).toBe('A base URL is required for local providers.')
        expect(storedProviders()).toEqual([])
    })

    test('rejects missing names, models, and malformed base URLs', async () => {
        for (const payload of [
            { ...localProvider, name: '' },
            { ...localProvider, defaultModel: '' },
            { ...localProvider, baseUrl: 'not a url' },
            { ...localProvider, baseUrl: 'file:///etc/passwd' },
        ]) {
            expect((await app.inject({ method: 'POST', url: '/providers', payload })).statusCode).toBe(400)
        }
        expect(storedProviders()).toEqual([])
    })

    test('editing the default provider keeps it the default and keeps its position', async () => {
        const first = (await app.inject({ method: 'POST', url: '/providers', payload: { ...localProvider, name: 'First' } })).json().id
        const second = (await app.inject({ method: 'POST', url: '/providers', payload: { ...localProvider, name: 'Second' } })).json().id
        await app.inject({ method: 'PUT', url: '/providers/active', payload: { id: second } })
        const before = storedProviders()

        const response = await app.inject({ method: 'POST', url: '/providers', payload: { ...localProvider, id: second, name: 'Renamed' } })

        expect(response.statusCode).toBe(200)
        const after = storedProviders()
        expect(after.map((row) => row.id)).toEqual([first, second])
        expect(after[1]).toMatchObject({ name: 'Renamed', is_last_used: 1, created_at: before[1].created_at })
        expect(getGateway().getLastUsedProviderId()).toBe(second)
    })

    test('previews the models of an unsaved provider without storing it', async () => {
        modelServer = createServer((req, res) => {
            res.setHeader('content-type', 'application/json')
            if (req.url === '/api/v1/models') {
                res.end(JSON.stringify({ models: [
                    { type: 'llm', key: 'chat-b', display_name: 'B' },
                    { type: 'llm', key: 'chat-a', display_name: 'A' },
                    { type: 'embedding', key: 'embed', display_name: 'E' },
                ] }))
                return
            }
            res.statusCode = 404
            res.end('{}')
        })
        await new Promise<void>((resolve) => modelServer!.listen(0, '127.0.0.1', resolve))
        const port = (modelServer.address() as { port: number }).port

        const response = await app.inject({
            method: 'POST', url: '/providers/models/preview',
            payload: { config: { type: 'lmstudio', baseUrl: `http://127.0.0.1:${port}/v1` }, types: ['llm'] },
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({ models: ['chat-a', 'chat-b'] })
        expect(storedProviders()).toEqual([])
    })

    test('reports an unreachable provider instead of returning an empty model list', async () => {
        const response = await app.inject({
            method: 'POST', url: '/providers/models/preview',
            payload: { config: { type: 'lmstudio', baseUrl: 'http://127.0.0.1:1/v1' }, types: ['llm'] },
        })
        expect(response.statusCode).toBe(502)
        expect(response.json().error).toBeTruthy()
        expect(storedProviders()).toEqual([])
    })
})
