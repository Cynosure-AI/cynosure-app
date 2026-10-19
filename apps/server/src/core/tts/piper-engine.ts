import { availableParallelism } from 'node:os'
import { getInstalledVoicePaths } from './voice-catalog.js'

/** Most of a reply is spoken one sentence at a time; this bounds a single request. */
export const MAX_SPEECH_TEXT_LENGTH = 2_000
/** Loading a voice takes about a second, so keep the last few in memory. */
const MAX_LOADED_VOICES = 2

interface GeneratedAudio {
    samples: Float32Array
    sampleRate: number
}

interface SherpaOfflineTts {
    readonly numSpeakers: number
    generateAsync(request: { text: string; sid: number; speed: number }): Promise<GeneratedAudio>
}

interface SherpaModule {
    OfflineTts: new (config: {
        model: { vits: { model: string; tokens: string; dataDir: string }; numThreads: number; provider: string }
        maxNumSentences: number
    }) => SherpaOfflineTts
}

interface LoadedVoice {
    tts: SherpaOfflineTts
    /** Synthesis runs one request at a time per voice. */
    queue: Promise<unknown>
}

export class SpeechError extends Error {
    constructor(message: string, readonly statusCode: number) {
        super(message)
    }
}

let sherpaModule: Promise<SherpaModule> | null = null
const loadedVoices = new Map<string, Promise<LoadedVoice>>()

/** Imported on first use, so a missing native binary only disables speech. */
function loadSherpa(): Promise<SherpaModule> {
    sherpaModule ??= import('sherpa-onnx-node')
        .then((mod: { default?: SherpaModule } & Partial<SherpaModule>) => (mod.default ?? mod) as SherpaModule)
        .catch((err: unknown) => {
            sherpaModule = null
            throw new SpeechError(`Speech engine unavailable: ${err instanceof Error ? err.message : String(err)}`, 503)
        })
    return sherpaModule
}

function loadVoice(voiceId: string): Promise<LoadedVoice> {
    const cached = loadedVoices.get(voiceId)
    if (cached) {
        // Re-insert to mark it most recently used.
        loadedVoices.delete(voiceId)
        loadedVoices.set(voiceId, cached)
        return cached
    }
    const paths = getInstalledVoicePaths(voiceId)
    if (!paths) return Promise.reject(new SpeechError(`Voice ${voiceId} is not installed`, 404))

    const loading = loadSherpa().then((sherpa) => ({
        tts: new sherpa.OfflineTts({
            model: {
                vits: { model: paths.model, tokens: paths.tokens, dataDir: paths.dataDir },
                numThreads: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
                provider: 'cpu',
            },
            maxNumSentences: 1,
        }),
        queue: Promise.resolve(),
    }))
    loading.catch(() => loadedVoices.delete(voiceId))
    loadedVoices.set(voiceId, loading)
    while (loadedVoices.size > MAX_LOADED_VOICES) {
        loadedVoices.delete(loadedVoices.keys().next().value!)
    }
    return loading
}

export function unloadVoice(voiceId: string): void {
    loadedVoices.delete(voiceId)
}

/** 16-bit mono PCM WAV, which every browser can play. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
    const buffer = Buffer.alloc(44 + samples.length * 2)
    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36 + samples.length * 2, 4)
    buffer.write('WAVE', 8)
    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20)
    buffer.writeUInt16LE(1, 22)
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(sampleRate * 2, 28)
    buffer.writeUInt16LE(2, 32)
    buffer.writeUInt16LE(16, 34)
    buffer.write('data', 36)
    buffer.writeUInt32LE(samples.length * 2, 40)
    for (let i = 0; i < samples.length; i++) {
        const sample = Math.max(-1, Math.min(1, samples[i]))
        buffer.writeInt16LE(Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), 44 + i * 2)
    }
    return buffer
}

export async function synthesizeSpeech(request: { text: string; voiceId: string; speakerId: number; speed: number }): Promise<Buffer> {
    const voice = await loadVoice(request.voiceId)
    const sid = Math.min(Math.max(0, request.speakerId), Math.max(0, voice.tts.numSpeakers - 1))
    const run = voice.queue.then(() => voice.tts.generateAsync({ text: request.text, sid, speed: request.speed }))
    voice.queue = run.catch(() => undefined)
    const audio = await run
    return encodeWav(audio.samples, audio.sampleRate)
}
