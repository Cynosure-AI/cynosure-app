import { describe, expect, test } from 'vitest'
import { imageParameters, videoParameters } from './media-parameters.js'

describe('explicit media parameters', () => {
  test('leaves provider defaults unset', () => {
    expect(imageParameters({}, { id: 'image-model', supported_parameters: {} })).toEqual({})
    expect(videoParameters({}, { id: 'video-model' })).toEqual({})
  })

  test('reports unsupported video values before submitting a job', () => {
    expect(() => videoParameters({ duration: 12 }, { id: 'video-model', supported_durations: [4, 6, 8] }))
      .toThrow('Supported values: 4, 6, 8')
  })

  test('reports unsupported image values before submitting a request', () => {
    expect(() => imageParameters({ resolution: '4K' }, { id: 'image-model', supported_parameters: {
      resolution: { type: 'enum', values: ['1K'] },
    } })).toThrow('Supported values: 1K')
  })
})
