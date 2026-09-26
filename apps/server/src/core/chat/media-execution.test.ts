import { describe, expect, test, vi } from 'vitest'
import type { getGateway } from '../gateway/gateway.js'
import { executeImageModel, executeTranscriptionModel, executeVideoModel } from './media-execution.js'

vi.mock('../artifacts/image-artifacts.js', () => ({
  materializeMediaBuffer: vi.fn((_data, _type, _conversationId, kind) => ({ url: `/media/${kind}` })),
}))

describe('executeTranscriptionModel', () => {
  test('combines multiple clips and their usage', async () => {
    const transcribeAudio = vi.fn()
      .mockResolvedValueOnce({ text: ' first ', usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } })
      .mockResolvedValueOnce({ text: 'second', usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 } })
    const gateway = { transcribeAudio } as unknown as ReturnType<typeof getGateway>
    const result = await executeTranscriptionModel({
      gateway, conversationId: 'c1', model: 'transcriber', providerId: 'p1', prompt: '',
      audioDataUrls: ['data:audio/mpeg;base64,YQ==', 'data:audio/wave;base64,Yg=='],
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ content: 'first\n\nsecond', promptTokens: 6, completionTokens: 9, contextTokens: 15 })
    expect(transcribeAudio.mock.calls[0][0].inputAudio).toEqual({ format: 'mp3', data: 'YQ==' })
    expect(transcribeAudio.mock.calls[1][0].inputAudio).toEqual({ format: 'wav', data: 'Yg==' })
  })
})

describe('media generation requests', () => {
  const signal = new AbortController().signal

  test('passes requested video settings and first/last frames to OpenRouter', async () => {
    const generateVideo = vi.fn().mockResolvedValue({ id: 'job', status: 'completed' })
    const gateway = {
      listVideoModels: vi.fn().mockResolvedValue([{
        id: 'video-model', supported_durations: [4, 6, 8], supported_resolutions: ['720p', '1080p'],
        supported_aspect_ratios: ['16:9', '9:16'], supported_frame_images: ['first_frame', 'last_frame'],
      }]),
      generateVideo,
      getVideoGenerationContent: vi.fn().mockResolvedValue({ data: new ArrayBuffer(2), contentType: 'video/mp4' }),
    } as unknown as ReturnType<typeof getGateway>
    const result = await executeVideoModel({ gateway, conversationId: 'c1', providerId: 'p1',
      model: 'video-model', prompt: 'Make an 8-second portrait video at 1080p with no audio. Use the first and last frames.',
      imageDataUrls: ['data:image/png;base64,YQ==', 'data:image/png;base64,Yg=='], signal })
    expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      duration: 8, resolution: '1080p', aspect_ratio: '9:16', generate_audio: false,
      frame_images: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' }, frame_type: 'first_frame' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,Yg==' }, frame_type: 'last_frame' },
      ],
    }), 'p1')
    expect(result.videos).toEqual(['/media/video'])
  })

  test('keeps video defaults and supports an explicit last frame', async () => {
    const generateVideo = vi.fn().mockResolvedValue({ id: 'job', status: 'completed' })
    const gateway = {
      listVideoModels: vi.fn().mockResolvedValue([{ id: 'video-model', supported_frame_images: ['first_frame', 'last_frame'] }]),
      generateVideo,
      getVideoGenerationContent: vi.fn().mockResolvedValue({ data: new ArrayBuffer(1), contentType: 'video/mp4' }),
    } as unknown as ReturnType<typeof getGateway>
    await executeVideoModel({ gateway, conversationId: 'c1', providerId: 'p1', model: 'video-model',
      prompt: 'Use this as the last frame.', imageDataUrls: ['data:image/png;base64,YQ=='], signal })
    expect(generateVideo.mock.calls[0][0].frame_images).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' }, frame_type: 'last_frame' },
    ])
    expect(generateVideo.mock.calls[0][0].duration).toBeUndefined()
  })

  test('sends explicit style references as references even when frames are supported', async () => {
    const generateVideo = vi.fn().mockResolvedValue({ id: 'job', status: 'completed' })
    const gateway = {
      listVideoModels: vi.fn().mockResolvedValue([{ id: 'video-model', supported_frame_images: ['first_frame', 'last_frame'] }]),
      generateVideo,
      getVideoGenerationContent: vi.fn().mockResolvedValue({ data: new ArrayBuffer(1), contentType: 'video/mp4' }),
    } as unknown as ReturnType<typeof getGateway>
    await executeVideoModel({ gateway, conversationId: 'c1', providerId: 'p1', model: 'video-model',
      prompt: 'Use this as a style reference image.', imageDataUrls: ['data:image/png;base64,YQ=='], signal })
    expect(generateVideo.mock.calls[0][0].input_references).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } },
    ])
    expect(generateVideo.mock.calls[0][0].frame_images).toBeUndefined()
  })

  test('passes supported image settings and returns every generated image', async () => {
    const generateImage = vi.fn().mockResolvedValue({
      data: [{ b64_json: 'YQ==', media_type: 'image/png' }, { b64_json: 'Yg==', media_type: 'image/png' }],
      usage: { prompt_tokens: 4, completion_tokens: 9, total_tokens: 13 },
    })
    const gateway = {
      listImageGenerationModels: vi.fn().mockResolvedValue([{ id: 'image-model', supported_parameters: {
        resolution: { type: 'enum', values: ['1K', '2K'] },
        aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] },
        n: { type: 'range', min: 1, max: 4 },
      } }]),
      generateImage,
    } as unknown as ReturnType<typeof getGateway>
    const result = await executeImageModel({ gateway, conversationId: 'c1', providerId: 'p1',
      model: 'image-model', prompt: 'Generate 2 landscape images in 2K', signal })
    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      n: 2, resolution: '2K', aspect_ratio: '16:9',
    }), 'p1')
    expect(result).toMatchObject({ images: ['/media/image', '/media/image'], promptTokens: 4,
      completionTokens: 9, contextTokens: 13 })
  })

  test('reports image settings rejected by model capabilities', async () => {
    const generateImage = vi.fn().mockResolvedValue({ data: [{ b64_json: 'YQ==', media_type: 'image/png' }] })
    const gateway = {
      listImageGenerationModels: vi.fn().mockResolvedValue([{ id: 'image-model', supported_parameters: {
        resolution: { type: 'enum', values: ['1K'] },
      } }]), generateImage,
    } as unknown as ReturnType<typeof getGateway>
    await expect(executeImageModel({ gateway, conversationId: 'c1', providerId: 'p1', model: 'image-model',
      prompt: 'Generate 3 portrait 4K images', signal })).rejects.toThrow('does not support resolution 4K')
    expect(generateImage).not.toHaveBeenCalled()
  })
})
