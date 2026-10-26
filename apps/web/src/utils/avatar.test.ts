import { describe, expect, test } from 'vitest'
import { _layout } from 'blobatar'
import { agentAvatarSrc, blobatarProps, compactAvatarConfig, EMPTY_AVATAR_CONFIG } from './avatar'

describe('blobatarProps', () => {
  test('uses the name until a seed overrides it', () => {
    expect(blobatarProps('agent-0', null)).toEqual({ name: 'agent-0', hue: undefined, tone: undefined, traits: undefined })
    expect(blobatarProps('Scout', { ...EMPTY_AVATAR_CONFIG, seed: 'pebble' }).name).toBe('pebble')
  })

  test('pins shape, hue and tone, keeping the ink tone below the wrap-around edge', () => {
    expect(blobatarProps('Scout', { seed: null, hue: 120, tone: 1, shape: 'sun' }))
      .toEqual({ name: 'Scout', hue: 120, tone: 0.999, traits: { shape: 0.965 } })
  })
})

describe('compactAvatarConfig', () => {
  test('collapses an uncustomised config to null', () => {
    expect(compactAvatarConfig(EMPTY_AVATAR_CONFIG)).toBeNull()
    expect(compactAvatarConfig({ ...EMPTY_AVATAR_CONFIG, hue: 0 })).toEqual({ ...EMPTY_AVATAR_CONFIG, hue: 0 })
  })
})

describe('agentAvatarSrc', () => {
  test('prefers the uploaded icon and otherwise renders the same face for the same name', () => {
    expect(agentAvatarSrc('Scout', '/api/agents/a/icon', null)).toBe('/api/agents/a/icon')
    const generated = agentAvatarSrc('Scout', null, null)
    expect(generated.startsWith('data:image/svg+xml,')).toBe(true)
    expect(agentAvatarSrc('Scout', null, null)).toBe(generated)
    expect(agentAvatarSrc('Other', null, null)).not.toBe(generated)
  })
})

describe('generated shapes', () => {
  const names = Array.from({ length: 2000 }, (_, index) => `agent-${index}`)
  const shapeOf = (name: string) => {
    const { name: seed, ...options } = blobatarProps(name, null)
    return _layout(seed, options).shape
  }

  test('names never land on nub or sun by themselves', () => {
    const shapes = new Set(names.map(shapeOf))
    expect(shapes.has('nub')).toBe(false)
    expect(shapes.has('sun')).toBe(false)
    expect(shapes.size).toBe(8)
  })

  test('every other name keeps the shape blobatar gives it', () => {
    for (const name of names) {
      const natural = _layout(name).shape
      if (natural !== 'nub' && natural !== 'sun') expect(shapeOf(name)).toBe(natural)
    }
  })

  test('nub and sun remain available as a manual pick', () => {
    for (const shape of ['nub', 'sun'] as const) {
      const { name, ...options } = blobatarProps('agent-0', { ...EMPTY_AVATAR_CONFIG, shape })
      expect(_layout(name, options).shape).toBe(shape)
    }
  })
})
