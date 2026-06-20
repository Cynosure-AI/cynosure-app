import { ref, computed, onUnmounted } from 'vue'
import { usePreferencesStore } from '../stores/preferences.store'
import { SK_WHISPER_DOWNLOADED } from '../utils/storage-keys'
import { api } from '../api/client'

export type WhisperStatus = 'idle' | 'loading' | 'ready' | 'recording' | 'transcribing' | 'error'

export interface FileDownloadProgress {
    progress: number
    loaded: number
    total: number
    done: boolean
}

function loadDownloadedModels(): { model: string; quantization: string }[] {
    try {
        return JSON.parse(localStorage.getItem(SK_WHISPER_DOWNLOADED) || '[]')
    } catch { return [] }
}

export function useWhisper() {
    const prefs = usePreferencesStore()
    const status = ref<WhisperStatus>('idle')
    const fileProgress = ref<Record<string, FileDownloadProgress>>({})
    const errorMessage = ref('')
    const downloadedModels = ref(loadDownloadedModels())

    // Overall progress computed from per-file progress (used by InputBar)
    const progress = computed(() => {
        const entries = Object.values(fileProgress.value)
        if (entries.length === 0) return 0
        const sum = entries.reduce((acc, f) => acc + f.progress, 0)
        return Math.round(sum / entries.length)
    })

    const progressFile = computed(() => {
        const active = Object.entries(fileProgress.value).find(([, f]) => !f.done && f.progress > 0)
        return active ? active[0] : ''
    })

    let worker: Worker | null = null
    let mediaStream: MediaStream | null = null
    let mediaRecorder: MediaRecorder | null = null
    let audioChunks: Blob[] = []
    let resolveTranscription: ((text: string) => void) | null = null
    let rejectTranscription: ((err: Error) => void) | null = null
    let activeMode: 'local' | 'remote' = 'local'

    function getWorker(): Worker {
        if (!worker) {
            worker = new Worker(new URL('../workers/whisper-worker.ts', import.meta.url), {
                type: 'module',
            })
            worker.addEventListener('message', onWorkerMessage)
        }
        return worker
    }

    function onWorkerMessage(e: MessageEvent): void {
        const data = e.data

        switch (data.status) {
            case 'loading':
                status.value = 'loading'
                fileProgress.value = {}
                break
            case 'progress': {
                const file = data.file as string
                if (!file) break
                const fileStatus = data.fileStatus as string
                if (fileStatus === 'initiate' || fileStatus === 'download') {
                    fileProgress.value = {
                        ...fileProgress.value,
                        [file]: { progress: 0, loaded: 0, total: 0, done: false },
                    }
                } else if (fileStatus === 'progress') {
                    fileProgress.value = {
                        ...fileProgress.value,
                        [file]: {
                            progress: (data.progress as number) ?? 0,
                            loaded: (data.loaded as number) ?? 0,
                            total: (data.total as number) ?? 0,
                            done: false,
                        },
                    }
                } else if (fileStatus === 'done') {
                    const existing = fileProgress.value[file]
                    if (existing) {
                        fileProgress.value = {
                            ...fileProgress.value,
                            [file]: { ...existing, progress: 100, done: true },
                        }
                    }
                }
                break
            }
            case 'ready':
                status.value = 'ready'
                // Mark all files as done
                const completed: Record<string, FileDownloadProgress> = {}
                for (const [f, p] of Object.entries(fileProgress.value)) {
                    completed[f] = { ...p, progress: 100, done: true }
                }
                fileProgress.value = completed
                // Track this model+quant as downloaded
                saveDownloadedModel(prefs.whisperModel, prefs.whisperQuantization)
                break
            case 'transcribing':
                status.value = 'transcribing'
                break
            case 'result':
                status.value = 'ready'
                resolveTranscription?.(data.text ?? '')
                resolveTranscription = null
                rejectTranscription = null
                break
            case 'error':
                status.value = 'error'
                errorMessage.value = data.error ?? 'Unknown error'
                rejectTranscription?.(new Error(data.error))
                resolveTranscription = null
                rejectTranscription = null
                break
        }
    }

    function saveDownloadedModel(model: string, quantization: string): void {
        const list = downloadedModels.value
        if (!list.some(d => d.model === model && d.quantization === quantization)) {
            list.push({ model, quantization })
            localStorage.setItem(SK_WHISPER_DOWNLOADED, JSON.stringify(list))
        }
    }

    function clearDownloadedModels(): void {
        downloadedModels.value = []
        localStorage.removeItem(SK_WHISPER_DOWNLOADED)
    }

    function loadModel(modelOverride?: string): void {
        if (status.value === 'loading') return
        const model = modelOverride || prefs.whisperModel
        const dtype = prefs.whisperQuantization
        getWorker().postMessage({ type: 'load', model, dtype })
    }

    async function startRecording(deviceId?: string): Promise<void> {
        activeMode = prefs.voiceTranscriptionMode
        // Ensure model is loaded
        if (activeMode === 'local' && status.value !== 'ready') {
            loadModel()
            await new Promise<void>((resolve, reject) => {
                const check = setInterval(() => {
                    if (status.value === 'ready') { clearInterval(check); resolve() }
                    if (status.value === 'error') { clearInterval(check); reject(new Error(errorMessage.value)) }
                }, 200)
            })
        }

        const audioConstraints: boolean | MediaTrackConstraints = deviceId
            ? { deviceId: { exact: deviceId } }
            : true
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
        audioChunks = []
        mediaRecorder = new MediaRecorder(mediaStream)
        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunks.push(e.data)
        }
        mediaRecorder.start()
        status.value = 'recording'
    }

    async function stopRecording(): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            if (!mediaRecorder || mediaRecorder.state !== 'recording') {
                resolve('')
                return
            }

            resolveTranscription = resolve
            rejectTranscription = reject

            mediaRecorder.onstop = async () => {
                mediaStream?.getTracks().forEach(t => t.stop())
                mediaStream = null

                const blob = new Blob(audioChunks, { type: 'audio/webm' })
                try {
                    if (activeMode === 'remote') {
                        status.value = 'transcribing'
                        const result = await transcribeRemote(blob)
                        status.value = 'ready'
                        resolve(result)
                        resolveTranscription = null
                        rejectTranscription = null
                    } else {
                        const float32 = await blobToFloat32(blob)
                        getWorker().postMessage({ type: 'transcribe', audio: float32, language: prefs.whisperLanguage })
                    }
                } catch (err) {
                    status.value = 'error'
                    errorMessage.value = err instanceof Error ? err.message : String(err)
                    reject(err)
                    resolveTranscription = null
                    rejectTranscription = null
                }
            }
            mediaRecorder.stop()
        })
    }

    function languageCode(language: string): string | undefined {
        const codes: Record<string, string> = {
            english: 'en',
            german: 'de',
            french: 'fr',
            spanish: 'es',
            italian: 'it',
            portuguese: 'pt',
            dutch: 'nl',
            polish: 'pl',
            russian: 'ru',
            chinese: 'zh',
            japanese: 'ja',
            korean: 'ko',
            arabic: 'ar',
            hindi: 'hi',
            turkish: 'tr',
            swedish: 'sv',
            danish: 'da',
            norwegian: 'no',
            finnish: 'fi',
            czech: 'cs',
            romanian: 'ro',
            hungarian: 'hu',
            greek: 'el',
            ukrainian: 'uk',
            indonesian: 'id',
            vietnamese: 'vi',
            thai: 'th',
            hebrew: 'he',
            catalan: 'ca',
            malay: 'ms',
        }
        return codes[language]
    }

    async function blobToBase64(blob: Blob): Promise<string> {
        const buffer = await blob.arrayBuffer()
        let binary = ''
        const bytes = new Uint8Array(buffer)
        const chunkSize = 0x8000
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
        }
        return btoa(binary)
    }

    async function transcribeRemote(blob: Blob): Promise<string> {
        const providerId = prefs.remoteTranscriptionProviderId
        const model = prefs.remoteTranscriptionModel
        if (!providerId || !model) {
            throw new Error('Select a remote transcription provider and model in Settings > Voice.')
        }
        const data = await blobToBase64(blob)
        const response = await api.provider.transcribeAudio(providerId, {
            model,
            inputAudio: { data, format: 'webm' },
            language: languageCode(prefs.whisperLanguage),
        })
        return response.text ?? ''
    }

    async function blobToFloat32(blob: Blob): Promise<Float32Array> {
        const arrayBuffer = await blob.arrayBuffer()
        const audioCtx = new AudioContext({ sampleRate: 16000 })
        const decoded = await audioCtx.decodeAudioData(arrayBuffer)
        const channelData = decoded.getChannelData(0)
        await audioCtx.close()
        return channelData
    }

    function cancelRecording(): void {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop()
        }
        mediaStream?.getTracks().forEach(t => t.stop())
        mediaStream = null
        audioChunks = []
        resolveTranscription = null
        rejectTranscription = null
        if (status.value === 'recording') status.value = 'ready'
    }

    function dispose(): void {
        cancelRecording()
        worker?.terminate()
        worker = null
        status.value = 'idle'
    }

    onUnmounted(dispose)

    return {
        status,
        progress,
        progressFile,
        fileProgress,
        downloadedModels,
        errorMessage,
        loadModel,
        startRecording,
        stopRecording,
        cancelRecording,
        clearDownloadedModels,
        dispose,
    }
}
