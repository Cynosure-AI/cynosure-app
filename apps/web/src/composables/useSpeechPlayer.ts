import { reactive, readonly } from 'vue'
import { api } from '../api/client'
import { SpeechStreamChunker, splitSentences, toSpeakableText } from '../utils/speech-text'

export type SpeechPhase = 'idle' | 'loading' | 'playing'

export interface SpeechOptions {
    voiceId?: string
    speakerId?: number
    speed?: number
}

export interface SpeechStream {
    push(delta: string): void
    /** The model restarted its answer; forget text that was not spoken yet. */
    reset(): void
    end(): void
}

/** One thing speaks at a time across the app; `key` names it (a message ID, a stream, a preview). */
const state = reactive({ key: null as string | null, phase: 'idle' as SpeechPhase, error: '', errorKey: null as string | null })

/**
 * Plays sentences in order. Each sentence is synthesized on the server while
 * the previous one plays, so speech flows without gaps.
 */
class SpeechSession {
    private readonly sentences: string[] = []
    private ended = false
    private stopped = false
    private wake: (() => void) | null = null
    private readonly controller = new AbortController()
    private readonly pending = new Map<number, Promise<Blob>>()
    private audio: HTMLAudioElement | null = null
    private finishPlayback: (() => void) | null = null
    private resolveStopped: () => void = () => {}
    /** Settles on stop, so a slow synthesis request cannot hold the session open. */
    private readonly stoppedSignal = new Promise<null>((resolve) => { this.resolveStopped = () => resolve(null) })

    constructor(readonly key: string, private readonly options: SpeechOptions) {}

    add(sentences: string[]): void {
        if (this.stopped || !sentences.length) return
        this.sentences.push(...sentences)
        this.wake?.()
    }

    end(): void {
        this.ended = true
        this.wake?.()
    }

    stop(): void {
        this.stopped = true
        this.controller.abort()
        this.audio?.pause()
        this.finishPlayback?.()
        this.wake?.()
        this.resolveStopped()
    }

    get active(): boolean {
        return !this.stopped
    }

    private synthesize(index: number): void {
        if (index >= this.sentences.length || this.pending.has(index)) return
        const request = api.tts.speak(this.sentences[index], this.options, this.controller.signal)
        request.catch(() => undefined)
        this.pending.set(index, request)
    }

    private waitForText(): Promise<void> {
        return new Promise((resolve) => {
            this.wake = () => {
                this.wake = null
                resolve()
            }
        })
    }

    private play(blob: Blob): Promise<void> {
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        this.audio = audio
        return new Promise<void>((resolve) => {
            const done = () => {
                this.finishPlayback = null
                this.audio = null
                URL.revokeObjectURL(url)
                resolve()
            }
            this.finishPlayback = done
            audio.addEventListener('ended', done, { once: true })
            audio.addEventListener('error', done, { once: true })
            audio.play().catch(done)
        })
    }

    async run(onPhase: (phase: SpeechPhase) => void, onError: (message: string) => void): Promise<void> {
        for (let index = 0; !this.stopped; index++) {
            while (index >= this.sentences.length && !this.ended && !this.stopped) await this.waitForText()
            if (this.stopped || index >= this.sentences.length) break
            this.synthesize(index)
            this.synthesize(index + 1)
            let blob: Blob | null
            try {
                blob = await Promise.race([this.pending.get(index)!, this.stoppedSignal])
            } catch (err) {
                if (!this.stopped) onError(err instanceof Error ? err.message : String(err))
                break
            }
            this.pending.delete(index)
            if (!blob || this.stopped) break
            onPhase('playing')
            await this.play(blob)
        }
    }
}

let session: SpeechSession | null = null

function begin(key: string, options: SpeechOptions): SpeechSession {
    session?.stop()
    const current = new SpeechSession(key, options)
    session = current
    state.key = key
    state.phase = 'loading'
    state.error = ''
    state.errorKey = null
    void current.run(
        (phase) => { if (session === current) state.phase = phase },
        (message) => {
            if (session !== current) return
            state.error = message
            state.errorKey = key
        },
    ).finally(() => {
        if (session !== current) return
        session = null
        state.key = null
        state.phase = 'idle'
    })
    return current
}

/** Read Markdown aloud, replacing whatever is speaking now. */
function speak(key: string, markdown: string, options: SpeechOptions = {}): void {
    const current = begin(key, options)
    current.add(splitSentences(toSpeakableText(markdown)))
    current.end()
}

/** Speak a reply while it streams in, sentence by sentence. */
function startStream(key: string, options: SpeechOptions = {}): SpeechStream {
    const current = begin(key, options)
    const chunker = new SpeechStreamChunker()
    return {
        push: (delta) => { if (current.active) current.add(chunker.push(delta)) },
        reset: () => chunker.reset(),
        end: () => {
            current.add(chunker.flush())
            current.end()
        },
    }
}

function stop(): void {
    session?.stop()
}

export function useSpeechPlayer() {
    return {
        state: readonly(state),
        speak,
        startStream,
        stop,
        isSpeaking: (key: string | undefined) => key !== undefined && state.key === key,
    }
}
