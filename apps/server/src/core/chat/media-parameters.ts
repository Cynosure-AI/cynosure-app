import type { MediaGenerationSettings } from '@shared/types'
import type { ImageGenerationModelInfo, VideoGenerationModelInfo } from '../gateway/providers/base.provider.js'

export type MediaParameterPlan = Omit<MediaGenerationSettings, 'kind'>

export function videoParameters(settings: MediaParameterPlan, model?: VideoGenerationModelInfo): MediaParameterPlan {
  const result: MediaParameterPlan = {}
  if (settings.duration != null) {
    if (!Number.isInteger(settings.duration) || settings.duration < 1) {
      throw new Error('Video duration must be a positive whole number of seconds')
    }
    result.duration = settings.duration
  }
  if (settings.resolution != null) {
    if (typeof settings.resolution !== 'string' || !settings.resolution.trim()) throw new Error('Invalid video resolution')
    result.resolution = settings.resolution
  }
  if (settings.aspect_ratio != null) {
    if (typeof settings.aspect_ratio !== 'string' || !settings.aspect_ratio.trim()) throw new Error('Invalid video aspect ratio')
    result.aspect_ratio = settings.aspect_ratio
  }
  if (settings.generate_audio != null) {
    if (typeof settings.generate_audio !== 'boolean') throw new Error('Video audio setting must be on or off')
    result.generate_audio = settings.generate_audio
  }
  if (settings.frame_mode && settings.frame_mode !== 'auto') {
    if (!['first', 'last', 'first_last', 'reference'].includes(settings.frame_mode)) {
      throw new Error('Invalid video frame setting')
    }
    result.frame_mode = settings.frame_mode
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
  return result
}

export function imageParameters(settings: MediaParameterPlan, model?: ImageGenerationModelInfo): MediaParameterPlan {
  const result: MediaParameterPlan = {}
  const supported = model?.supported_parameters
  for (const key of ['resolution', 'aspect_ratio'] as const) {
    const value = settings[key]
    if (value == null) continue
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid image ${key}`)
    const descriptor = supported?.[key]
    if (supported && (!descriptor || (descriptor.values?.length && !descriptor.values.includes(value)))) {
      throw new Error(`This image model does not support ${key} ${value}${descriptor?.values?.length ? `. Supported values: ${descriptor.values.join(', ')}` : ''}`)
    }
    result[key] = value
  }
  if (settings.n != null) {
    if (!Number.isInteger(settings.n) || settings.n < 1 || settings.n > 10 ||
      (supported && !supported.n && settings.n !== 1) ||
      (supported?.n?.max != null && settings.n > supported.n.max) ||
      (supported?.n?.min != null && settings.n < supported.n.min)) {
      throw new Error('This image model does not support the requested image count')
    }
    if (supported?.n || !supported) result.n = settings.n
  }
  return result
}
