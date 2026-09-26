import type { ImageGenerationModelInfo, VideoGenerationModelInfo } from '../gateway/providers/base.provider.js'
import type { getGateway } from '../gateway/gateway.js'

type Gateway = ReturnType<typeof getGateway>

export interface MediaParameterPlan {
  resolution?: string
  aspect_ratio?: string
  duration?: number
  generate_audio?: boolean
  n?: number
  frame_mode?: 'first' | 'last' | 'first_last' | 'reference'
}

function explicitParameters(prompt: string, kind: 'image' | 'video'): MediaParameterPlan {
  const plan: MediaParameterPlan = {}
  const ratio = prompt.match(/\b(\d{1,2})\s*:\s*(\d{1,2})\b/)
  if (ratio) plan.aspect_ratio = `${ratio[1]}:${ratio[2]}`
  else if (/\b(?:portrait|vertical)\b/i.test(prompt)) plan.aspect_ratio = '9:16'
  else if (/\b(?:landscape|widescreen|horizontal)\b/i.test(prompt)) plan.aspect_ratio = '16:9'
  else if (/\bsquare\b/i.test(prompt)) plan.aspect_ratio = '1:1'

  if (kind === 'video') {
    const resolution = prompt.match(/\b(480p|720p|768p|1080p|1k|2k|4k)\b/i)
    if (resolution) plan.resolution = resolution[1].replace(/k$/i, 'K')
    const duration = prompt.match(/\b(\d{1,3})[\s-]*(?:seconds?|secs?|s)\b/i)
    if (duration) plan.duration = Number(duration[1])
    if (/\b(?:no audio|without audio|silent|mute)\b/i.test(prompt)) plan.generate_audio = false
    else if (/\b(?:with audio|generate audio|include audio|with sound)\b/i.test(prompt)) plan.generate_audio = true
    if (/\b(?:reference image|reference photo|style reference)\b/i.test(prompt)) plan.frame_mode = 'reference'
    else if (/\b(?:first|starting|start)\s+(?:and\s+)?(?:last|ending|end)\s+frames?\b/i.test(prompt)) plan.frame_mode = 'first_last'
    else if (/\b(?:last|ending|end)\s+frame\b/i.test(prompt)) plan.frame_mode = 'last'
    else if (/\b(?:first|starting|start)\s+frame\b/i.test(prompt)) plan.frame_mode = 'first'
  } else {
    const resolution = prompt.match(/\b(512|1k|2k|4k)\b/i)
    if (resolution) plan.resolution = resolution[1].replace(/k$/i, 'K')
    const count = prompt.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+\w+){0,3}\s+(?:images?|pictures?|variations?)\b/i)
    if (count) {
      const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
      plan.n = /^\d/.test(count[1]) ? Number(count[1]) : words.indexOf(count[1].toLowerCase()) + 1
    }
  }
  return plan
}

export async function planMediaParameters(input: {
  gateway: Gateway
  kind: 'image' | 'video'
  prompt: string
  planner?: { providerId: string; model: string }
  signal: AbortSignal
}): Promise<MediaParameterPlan> {
  const fallback = explicitParameters(input.prompt, input.kind)
  if (!input.planner) return fallback
  try {
    const response = await input.gateway.complete({
      model: input.planner.model, signal: input.signal, temperature: 0, maxTokens: 180,
      messages: [
        { role: 'system', content: `Extract requested ${input.kind} generation settings. Return only a JSON object. Keys: resolution, aspect_ratio, ${input.kind === 'video' ? 'duration, generate_audio, frame_mode' : 'n'}. Omit settings the user did not request. Infer portrait=9:16, landscape=16:9, square=1:1. For video frame_mode use first, last, first_last, or reference only when the user specifies how attached images should be used. Never invent a setting.` },
        { role: 'user', content: input.prompt },
      ],
    }, input.planner.providerId)
    const json = response.content.match(/\{[\s\S]*\}/)?.[0]
    if (!json) return fallback
    const value = JSON.parse(json) as Record<string, unknown>
    const plan: MediaParameterPlan = { ...fallback }
    if (typeof value.resolution === 'string') plan.resolution = value.resolution
    if (typeof value.aspect_ratio === 'string') plan.aspect_ratio = value.aspect_ratio
    if (input.kind === 'video') {
      if (Number.isInteger(value.duration)) plan.duration = value.duration as number
      if (typeof value.generate_audio === 'boolean') plan.generate_audio = value.generate_audio
      if (['first', 'last', 'first_last', 'reference'].includes(String(value.frame_mode))) {
        plan.frame_mode = value.frame_mode as MediaParameterPlan['frame_mode']
      }
    } else if (Number.isInteger(value.n)) plan.n = value.n as number
    return plan
  } catch (err) {
    if (input.signal.aborted) throw err
    return fallback
  }
}

export function videoParameters(plan: MediaParameterPlan, model?: VideoGenerationModelInfo): MediaParameterPlan {
  const result: MediaParameterPlan = { ...plan }
  if (result.resolution) result.resolution = result.resolution.replace(/k$/i, 'K')
  if (result.aspect_ratio) result.aspect_ratio = result.aspect_ratio.replace(/\s/g, '')
  if (result.duration != null && (!Number.isInteger(result.duration) || result.duration < 1)) {
    throw new Error('Video duration must be a positive whole number of seconds')
  }
  for (const [key, supported] of [
    ['duration', model?.supported_durations],
    ['resolution', model?.supported_resolutions],
    ['aspect_ratio', model?.supported_aspect_ratios],
  ] as const) {
    const value = result[key]
    if (value != null && supported?.length && !(supported as readonly (string | number)[]).includes(value)) {
      throw new Error(`This video model does not support ${key} ${value}. Supported values: ${supported.join(', ')}`)
    }
  }
  const frames = model?.supported_frame_images
  if (Array.isArray(frames) && ((result.frame_mode === 'last' && !frames.includes('last_frame')) ||
    (result.frame_mode === 'first' && !frames.includes('first_frame')) ||
    (result.frame_mode === 'first_last' && (!frames.includes('first_frame') || !frames.includes('last_frame'))))) {
    throw new Error('This video model does not support the requested first/last frame arrangement')
  }
  delete result.n
  return result
}

export function imageParameters(plan: MediaParameterPlan, model?: ImageGenerationModelInfo): MediaParameterPlan {
  const result: MediaParameterPlan = { ...plan }
  if (result.resolution) result.resolution = result.resolution.replace(/k$/i, 'K')
  if (result.aspect_ratio) result.aspect_ratio = result.aspect_ratio.replace(/\s/g, '')
  const supported = model?.supported_parameters
  for (const key of ['resolution', 'aspect_ratio'] as const) {
    const descriptor = supported?.[key]
    if (result[key] && supported && (!descriptor || (descriptor.values?.length && !descriptor.values.includes(result[key])))) {
      throw new Error(`This image model does not support ${key} ${result[key]}${descriptor?.values?.length ? `. Supported values: ${descriptor.values.join(', ')}` : ''}`)
    }
  }
  if (result.n === 1 && supported && !supported.n) delete result.n
  if (result.n != null && (!Number.isInteger(result.n) || result.n < 1 || result.n > 10 ||
    (supported && !supported.n) || (supported?.n?.max != null && result.n > supported.n.max))) {
    throw new Error('This image model does not support the requested image count')
  }
  delete result.duration
  delete result.generate_audio
  delete result.frame_mode
  return result
}
