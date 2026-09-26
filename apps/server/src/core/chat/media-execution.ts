import type { VideoGenerationJob, VideoGenerationModelInfo, VideoGenerationRequest } from '../gateway/providers/base.provider.js'
import type { getGateway } from '../gateway/gateway.js'
import { materializeMediaBuffer } from '../artifacts/image-artifacts.js'
import { imageParameters, planMediaParameters, videoParameters, type MediaParameterPlan } from './media-parameters.js'

type Gateway = ReturnType<typeof getGateway>

export interface MediaExecutionInput {
  gateway: Gateway
  conversationId: string
  model: string
  providerId: string
  prompt: string
  imageDataUrls?: string[]
  audioDataUrls?: string[]
  planner?: { providerId: string; model: string }
  signal: AbortSignal
}

export interface MediaExecutionResult {
  content: string
  videos?: string[]
  images?: string[]
  promptTokens?: number
  completionTokens?: number
  contextTokens?: number
}

export async function executeVideoModel(input: MediaExecutionInput): Promise<MediaExecutionResult> {
  const { gateway, providerId, model, signal } = input
  const videoModel = await gateway.listVideoModels(providerId)
    .then((models) => models.find((item) => item.id === model || item.canonical_slug === model))
    .catch(() => undefined)
  const plan = videoParameters(await planMediaParameters({ gateway, kind: 'video', prompt: input.prompt,
    planner: input.planner, signal }), videoModel)
  const submittedJob = await gateway.generateVideo(buildVideoGenerationRequest({
    model, prompt: input.prompt, imageDataUrls: input.imageDataUrls, videoModel, plan, signal,
  }), providerId)
  const completedJob = await pollVideoGeneration(gateway, providerId, submittedJob, signal)
  signal.throwIfAborted()
  const videoContent = await gateway.getVideoGenerationContent(completedJob.id, 0, providerId)
  signal.throwIfAborted()
  const artifact = materializeMediaBuffer(videoContent.data, videoContent.contentType, input.conversationId, 'video')
  const settings = [plan.duration != null ? `${plan.duration}s` : null, plan.resolution,
    plan.aspect_ratio, plan.generate_audio === false ? 'no audio' : plan.generate_audio === true ? 'with audio' : null]
    .filter(Boolean).join(', ')
  return { content: `Generated video${settings ? ` (${settings})` : ''}.`, videos: [artifact.url] }
}

export async function executeImageModel(input: MediaExecutionInput): Promise<MediaExecutionResult> {
  const { gateway, providerId, model, signal } = input
  const imageModel = await gateway.listImageGenerationModels(providerId)
    .then((models) => models.find((item) => item.id === model))
  if (!imageModel) throw new Error(`Image model ${model} is unavailable on the dedicated image API`)
  const plan = imageParameters(await planMediaParameters({ gateway, kind: 'image', prompt: input.prompt,
    planner: input.planner, signal }), imageModel)
  const references = input.imageDataUrls?.filter((url) => typeof url === 'string' && url.trim())
    .map((url) => ({ type: 'image_url' as const, image_url: { url } }))
  const response = await gateway.generateImage({
    model, prompt: input.prompt, signal,
    ...(plan.resolution ? { resolution: plan.resolution } : {}),
    ...(plan.aspect_ratio ? { aspect_ratio: plan.aspect_ratio } : {}),
    ...(plan.n != null ? { n: plan.n } : {}),
    ...(references?.length ? { input_references: references } : {}),
  }, providerId)
  signal.throwIfAborted()
  if (!response.data?.length) throw new Error('Image generation returned no images')
  const images = response.data.map((item) => {
    if (!item.b64_json) throw new Error('Image generation returned an empty image')
    const artifact = materializeMediaBuffer(Buffer.from(item.b64_json, 'base64'),
      item.media_type || 'image/png', input.conversationId, 'image')
    return artifact.url
  })
  const settings = [plan.resolution, plan.aspect_ratio].filter(Boolean).join(', ')
  return { content: `Generated ${images.length} image${images.length === 1 ? '' : 's'}${settings ? ` (${settings})` : ''}.`, images,
    promptTokens: response.usage?.prompt_tokens, completionTokens: response.usage?.completion_tokens,
    contextTokens: response.usage?.total_tokens }
}

export async function executeTranscriptionModel(input: MediaExecutionInput): Promise<MediaExecutionResult> {
  if (!input.audioDataUrls?.length) throw new Error('Transcription models require an attached audio file.')
  const transcripts: string[] = []
  let promptTokens = 0
  let completionTokens = 0
  let contextTokens = 0
  for (const audioUrl of input.audioDataUrls) {
    input.signal.throwIfAborted()
    const transcription = await input.gateway.transcribeAudio({
      model: input.model, inputAudio: audioInputFromDataUrl(audioUrl), signal: input.signal,
    }, input.providerId)
    input.signal.throwIfAborted()
    if (transcription.text.trim()) transcripts.push(transcription.text.trim())
    promptTokens += transcription.usage?.input_tokens ?? 0
    completionTokens += transcription.usage?.output_tokens ?? 0
    contextTokens += transcription.usage?.total_tokens ?? 0
  }
  return { content: transcripts.length ? transcripts.join('\n\n') : '(No transcription text returned.)',
    promptTokens, completionTokens, contextTokens }
}

function audioInputFromDataUrl(dataUrl: string): { data: string; format?: string } {
  const match = /^data:audio\/([^;,]+)(?:;[^,]*)?;base64,(.+)$/i.exec(dataUrl)
  if (!match) throw new Error('Attached audio must be a base64 audio data URL')
  const aliases: Record<string, string> = {
    mpeg: 'mp3', mp4: 'm4a', 'x-m4a': 'm4a', 'x-wav': 'wav', wave: 'wav', vorbis: 'ogg',
  }
  const format = match[1].toLowerCase()
  return { format: aliases[format] || format, data: match[2] }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

async function pollVideoGeneration(gateway: Gateway, providerId: string, initialJob: VideoGenerationJob, signal?: AbortSignal): Promise<VideoGenerationJob> {
  let job = initialJob
  const deadline = Date.now() + 10 * 60 * 1000
  while (!['completed', 'failed', 'cancelled', 'expired'].includes(job.status.toLowerCase()) && Date.now() < deadline) {
    await sleep(4_000, signal)
    job = await gateway.getVideoGenerationJob(job.id, providerId)
  }
  if (!['completed', 'failed', 'cancelled', 'expired'].includes(job.status.toLowerCase())) {
    throw new Error('Video generation did not finish before the polling timeout')
  }
  if (job.status.toLowerCase() !== 'completed') throw new Error(job.error || `Video generation ${job.status}`)
  return job
}

function buildVideoGenerationRequest(input: {
  model: string
  prompt: string
  imageDataUrls?: string[]
  videoModel?: VideoGenerationModelInfo
  plan: MediaParameterPlan
  signal?: AbortSignal
}): VideoGenerationRequest {
  const request: VideoGenerationRequest = { model: input.model, prompt: input.prompt, signal: input.signal }
  if (input.plan.duration != null) request.duration = input.plan.duration
  if (input.plan.resolution) request.resolution = input.plan.resolution
  if (input.plan.aspect_ratio) request.aspect_ratio = input.plan.aspect_ratio
  if (input.plan.generate_audio != null) request.generate_audio = input.plan.generate_audio
  const images = (input.imageDataUrls || []).filter((url) => typeof url === 'string' && url.trim())
  if (input.plan.frame_mode && !images.length) throw new Error('Attach an image for the requested video frame or reference')
  if (input.plan.frame_mode === 'first_last' && images.length < 2) {
    throw new Error('First and last frame generation requires two attached images')
  }
  if (!images.length) return request
  const frameMode = input.plan.frame_mode
  const supportedFrames = new Set(input.videoModel?.supported_frame_images ||
    (frameMode && frameMode !== 'reference' ? ['first_frame', 'last_frame'] : []))
  if (frameMode !== 'reference' && (supportedFrames.has('first_frame') || supportedFrames.has('last_frame'))) {
    const frames: NonNullable<VideoGenerationRequest['frame_images']> = []
    if (frameMode === 'last' && supportedFrames.has('last_frame')) {
      frames.push({ type: 'image_url', image_url: { url: images[0] }, frame_type: 'last_frame' })
    } else if (supportedFrames.has('first_frame')) {
      frames.push({ type: 'image_url', image_url: { url: images[0] }, frame_type: 'first_frame' })
      if (images[1] && supportedFrames.has('last_frame') && frameMode !== 'first') {
        frames.push({ type: 'image_url', image_url: { url: images[1] }, frame_type: 'last_frame' })
      }
    }
    if (frames.length) request.frame_images = frames
    else request.input_references = images.map((url) => ({ type: 'image_url', image_url: { url } }))
    return request
  }
  request.input_references = images.map((url) => ({ type: 'image_url', image_url: { url } }))
  return request
}
