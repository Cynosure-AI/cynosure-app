import { describe, expect, test, vi } from 'vitest'
import type { getGateway } from '../gateway/gateway.js'
import { planMediaParameters, videoParameters } from './media-parameters.js'

describe('media parameter planning', () => {
  test('uses a text model to interpret a natural language request', async () => {
    const complete = vi.fn().mockResolvedValue({ content: '```json\n{"duration":6,"aspect_ratio":"9:16","generate_audio":false}\n```' })
    const gateway = { complete } as unknown as ReturnType<typeof getGateway>
    const result = await planMediaParameters({ gateway, kind: 'video', prompt: 'Make a six-second silent clip for a phone story',
      planner: { providerId: 'text-provider', model: 'text-model' }, signal: new AbortController().signal })
    expect(result).toMatchObject({ duration: 6, aspect_ratio: '9:16', generate_audio: false })
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'text-model' }), 'text-provider')
  })

  test('preserves defaults when no settings are requested', async () => {
    const gateway = { complete: vi.fn().mockResolvedValue({ content: '{}' }) } as unknown as ReturnType<typeof getGateway>
    const result = await planMediaParameters({ gateway, kind: 'image', prompt: 'A cat by a window',
      planner: { providerId: 'text-provider', model: 'text-model' }, signal: new AbortController().signal })
    expect(result).toEqual({})
  })

  test('reports unsupported video values before submitting a job', () => {
    expect(() => videoParameters({ duration: 12 }, { id: 'video-model', supported_durations: [4, 6, 8] }))
      .toThrow('Supported values: 4, 6, 8')
  })
})
