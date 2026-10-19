import type { FastifyInstance } from 'fastify'
import type { VoiceOutputSettings } from '@shared/types'
import { getVoiceOutputSettings, MAX_SPEECH_SPEED, MIN_SPEECH_SPEED, saveVoiceOutputSettings } from '../core/tts/voice-settings.js'
import { deleteVoice, isValidVoiceId, listVoices, startVoiceDownload } from '../core/tts/voice-catalog.js'
import { MAX_SPEECH_TEXT_LENGTH, SpeechError, synthesizeSpeech, unloadVoice } from '../core/tts/piper-engine.js'

type BroadcastFn = (event: string, data: unknown) => void

export async function registerTtsRoutes(app: FastifyInstance, broadcast?: BroadcastFn): Promise<void> {
    // GET /api/tts/settings — the voice every client and channel speaks with
    app.get('/settings', async () => getVoiceOutputSettings())

    // PUT /api/tts/settings — update some or all voice output settings
    app.put<{ Body: Partial<VoiceOutputSettings> }>('/settings', async (req, reply) => {
        if (!req.body || typeof req.body !== 'object') {
            return reply.status(400).send({ error: 'Expected a settings object' })
        }
        if (req.body.voiceId !== undefined && req.body.voiceId !== '' && !isValidVoiceId(req.body.voiceId)) {
            return reply.status(400).send({ error: 'Unknown voice' })
        }
        return saveVoiceOutputSettings(req.body)
    })

    // GET /api/tts/voices — downloadable and installed voices, with running downloads
    app.get('/voices', async () => listVoices())

    // POST /api/tts/voices/:id/download — progress arrives as tts:download-progress events
    app.post<{ Params: { id: string } }>('/voices/:id/download', async (req, reply) => {
        if (!isValidVoiceId(req.params.id)) return reply.status(400).send({ error: 'Unknown voice' })
        try {
            const download = await startVoiceDownload(req.params.id, (progress) => broadcast?.('tts:download-progress', progress))
            return reply.status(202).send(download)
        } catch (err) {
            return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) })
        }
    })

    // DELETE /api/tts/voices/:id — remove an installed voice
    app.delete<{ Params: { id: string } }>('/voices/:id', async (req, reply) => {
        if (!isValidVoiceId(req.params.id)) return reply.status(400).send({ error: 'Unknown voice' })
        unloadVoice(req.params.id)
        if (!deleteVoice(req.params.id)) return reply.status(404).send({ error: 'Voice is not installed' })
        if (getVoiceOutputSettings().voiceId === req.params.id) saveVoiceOutputSettings({ voiceId: '', speakerId: 0 })
        return { deleted: true }
    })

    // POST /api/tts/speak — synthesize text (usually one sentence) as WAV
    app.post<{ Body: { text?: unknown; voiceId?: unknown; speakerId?: unknown; speed?: unknown } }>('/speak', async (req, reply) => {
        const { text, voiceId, speakerId, speed } = req.body || {}
        if (typeof text !== 'string' || !text.trim()) return reply.status(400).send({ error: 'Text is required' })
        if (text.length > MAX_SPEECH_TEXT_LENGTH) {
            return reply.status(400).send({ error: `Text must be at most ${MAX_SPEECH_TEXT_LENGTH} characters` })
        }
        if (voiceId !== undefined && !isValidVoiceId(voiceId)) return reply.status(400).send({ error: 'Unknown voice' })

        const settings = getVoiceOutputSettings()
        const voice = voiceId ?? settings.voiceId
        if (!voice) return reply.status(409).send({ error: 'Choose a voice in Settings → Voice first' })
        try {
            const audio = await synthesizeSpeech({
                text: text.trim(),
                voiceId: voice,
                // The saved speaker belongs to the saved voice; another voice starts at its first speaker.
                speakerId: Number.isSafeInteger(speakerId) ? speakerId as number : voice === settings.voiceId ? settings.speakerId : 0,
                speed: typeof speed === 'number' && Number.isFinite(speed)
                    ? Math.min(MAX_SPEECH_SPEED, Math.max(MIN_SPEECH_SPEED, speed))
                    : settings.speed,
            })
            return reply.type('audio/wav').header('Cache-Control', 'no-store').send(audio)
        } catch (err) {
            if (err instanceof SpeechError) return reply.status(err.statusCode).send({ error: err.message })
            throw err
        }
    })
}
