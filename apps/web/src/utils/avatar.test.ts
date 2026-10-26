import { describe, expect, test } from 'vitest'
import { agentAvatarSrc, blobatarProps, compactAvatarConfig, EMPTY_AVATAR_CONFIG } from './avatar'

describe('blobatarProps', () => {
  test('uses the name until a seed overrides it', () => {
    expect(blobatarProps('Scout', null)).toEqual({ name: 'Scout', hue: undefined, tone: undefined, traits: undefined })
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
