import { describe, expect, test, vi } from 'vitest'
import type { getGateway } from '../gateway/gateway.js'
import { executeTranscriptionModel } from './media-execution.js'

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
