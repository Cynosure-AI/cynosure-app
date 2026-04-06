import { pipeline } from '@huggingface/transformers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transcriber: any = null
let loadedModel = ''
let loadedDtype = ''

type DType = 'q4' | 'q8' | 'fp16' | 'fp32'

type WorkerMessage =
    | { type: 'load'; model: string; dtype: string }
    | { type: 'transcribe'; audio: Float32Array; language: string }

self.addEventListener('message', async (e: MessageEvent<WorkerMessage>) => {
    const msg = e.data

    if (msg.type === 'load') {
        const modelId = msg.model || 'onnx-community/whisper-base'
        const dtype = msg.dtype || 'q8'

        // If same model + dtype is already loaded, skip
        if (transcriber && loadedModel === modelId && loadedDtype === dtype) {
            self.postMessage({ status: 'ready' })
            return
        }

        try {
            transcriber = null
            loadedModel = ''
            loadedDtype = ''
            self.postMessage({ status: 'loading', message: `Downloading ${modelId} (${dtype})…` })
            transcriber = await pipeline('automatic-speech-recognition', modelId, {
                dtype: dtype as DType,
                progress_callback: (p: Record<string, unknown>) => {
                    self.postMessage({
                        status: 'progress',
                        fileStatus: p.status,
                        file: p.file,
                        progress: p.progress,
                        loaded: p.loaded,
                        total: p.total,
                    })
                },
            })
            loadedModel = modelId
            loadedDtype = dtype
            self.postMessage({ status: 'ready' })
        } catch (err) {
            self.postMessage({ status: 'error', error: String(err) })
        }
        return
    }

    if (msg.type === 'transcribe') {
        if (!transcriber) {
            self.postMessage({ status: 'error', error: 'Model not loaded' })
            return
        }
        try {
            self.postMessage({ status: 'transcribing' })
            const result = await transcriber(msg.audio, {
                language: msg.language || 'english',
                task: 'transcribe',
            })
            const text = Array.isArray(result) ? result.map((r: { text: string }) => r.text).join(' ') : result.text
            self.postMessage({ status: 'result', text: text.trim() })
        } catch (err) {
            self.postMessage({ status: 'error', error: String(err) })
        }
    }
})
