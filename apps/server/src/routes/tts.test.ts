import Fastify from 'fastify'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    settings: { enabled: true, voiceId: 'en_GB-aru-medium', speakerId: 3, speed: 1.2, autoRead: 'voice' },
    save: vi.fn(),
    synthesize: vi.fn(),
    startDownload: vi.fn(),
    deleteVoice: vi.fn(),
}))

vi.mock('../core/tts/voice-settings.js', () => ({
    MIN_SPEECH_SPEED: 0.5,
    MAX_SPEECH_SPEED: 2,
    getVoiceOutputSettings: () => mocks.settings,
    saveVoiceOutputSettings: mocks.save,
}))

vi.mock('../core/tts/voice-catalog.js', async () => {
    const actual = await vi.importActual<typeof import('../core/tts/voice-catalog.js')>('../core/tts/voice-catalog.js')
    return {
        isValidVoiceId: actual.isValidVoiceId,
        listVoices: vi.fn(async () => ({ voices: [], downloads: [] })),
        startVoiceDownload: mocks.startDownload,
        deleteVoice: mocks.deleteVoice,
    }
})

vi.mock('../core/tts/piper-engine.js', async () => {
    const actual = await vi.importActual<typeof import('../core/tts/piper-engine.js')>('../core/tts/piper-engine.js')
    return {
        MAX_SPEECH_TEXT_LENGTH: 2_000,
        SpeechError: actual.SpeechError,
        synthesizeSpeech: mocks.synthesize,
        unloadVoice: vi.fn(),
    }
})

import { SpeechError } from '../core/tts/piper-engine.js'
import { registerTtsRoutes } from './tts.js'

async function createApp(broadcast = vi.fn()) {
    const app = Fastify()
    await app.register(async (instance) => registerTtsRoutes(instance, broadcast), { prefix: '/tts' })
    return app
}

describe('tts routes', () => {
    beforeEach(() => {
        mocks.save.mockImplementation((input) => ({ ...mocks.settings, ...input }))
        mocks.synthesize.mockResolvedValue(Buffer.from('RIFF'))
    })

    test('speaks with the saved voice, speaker and speed', async () => {
        const app = await createApp()

        const response = await app.inject({ method: 'POST', url: '/tts/speak', payload: { text: '  Hello there.  ' } })

        expect(response.statusCode).toBe(200)
        expect(response.headers['content-type']).toBe('audio/wav')
        expect(response.rawPayload.toString()).toBe('RIFF')
        expect(mocks.synthesize).toHaveBeenCalledWith({ text: 'Hello there.', voiceId: 'en_GB-aru-medium', speakerId: 3, speed: 1.2 })
        await app.close()
    })

    test('previews another voice from its first speaker', async () => {
        const app = await createApp()

        await app.inject({ method: 'POST', url: '/tts/speak', payload: { text: 'Hallo.', voiceId: 'de_DE-thorsten-medium', speed: 5 } })

        expect(mocks.synthesize).toHaveBeenCalledWith({ text: 'Hallo.', voiceId: 'de_DE-thorsten-medium', speakerId: 0, speed: 2 })
        await app.close()
    })

    test('rejects empty text, path-like voices and missing voices', async () => {
        const app = await createApp()

        expect((await app.inject({ method: 'POST', url: '/tts/speak', payload: { text: ' ' } })).statusCode).toBe(400)
        expect((await app.inject({ method: 'POST', url: '/tts/speak', payload: { text: 'x', voiceId: '../x' } })).statusCode).toBe(400)
        expect((await app.inject({ method: 'POST', url: '/tts/speak', payload: { text: 'x'.repeat(2_001) } })).statusCode).toBe(400)
        mocks.synthesize.mockRejectedValueOnce(new SpeechError('Voice en_GB-aru-medium is not installed', 404))
        expect((await app.inject({ method: 'POST', url: '/tts/speak', payload: { text: 'x' } })).statusCode).toBe(404)
        expect(mocks.synthesize).toHaveBeenCalledTimes(1)
        await app.close()
    })

    test('reports download progress over the broadcast channel', async () => {
        const broadcast = vi.fn()
        mocks.startDownload.mockImplementation(async (voiceId, onProgress) => {
            const progress = { voiceId, status: 'downloading', loaded: 0, total: 10 }
            onProgress(progress)
            return progress
        })
        const app = await createApp(broadcast)

        const response = await app.inject({ method: 'POST', url: '/tts/voices/en_GB-aru-medium/download' })

        expect(response.statusCode).toBe(202)
        expect(broadcast).toHaveBeenCalledWith('tts:download-progress', { voiceId: 'en_GB-aru-medium', status: 'downloading', loaded: 0, total: 10 })
        await app.close()
    })

    test('deleting the selected voice clears it from the settings', async () => {
        mocks.deleteVoice.mockReturnValue(true)
        const app = await createApp()

        const response = await app.inject({ method: 'DELETE', url: '/tts/voices/en_GB-aru-medium' })

        expect(response.statusCode).toBe(200)
        expect(mocks.save).toHaveBeenCalledWith({ voiceId: '', speakerId: 0 })
        await app.close()
    })

    test('refuses settings that name an invalid voice', async () => {
        const app = await createApp()

        expect((await app.inject({ method: 'PUT', url: '/tts/settings', payload: { voiceId: '../../etc' } })).statusCode).toBe(400)
        expect((await app.inject({ method: 'PUT', url: '/tts/settings', payload: { autoRead: 'always' } })).json()).toMatchObject({ autoRead: 'always' })
        await app.close()
    })
})
