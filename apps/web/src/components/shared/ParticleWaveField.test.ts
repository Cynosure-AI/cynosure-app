import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import ParticleWaveField from './ParticleWaveField.vue'

describe('ParticleWaveField', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('renders a decorative canvas hidden from assistive tech', () => {
    const wrapper = mount(ParticleWaveField)
    const canvas = wrapper.get('canvas')

    expect(canvas.attributes('aria-hidden')).toBe('true')
    expect(canvas.classes()).toContain('pointer-events-none')
    wrapper.unmount()
  })

  test('removes its pointer listener on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fill: vi.fn(),
    } as unknown as CanvasRenderingContext2D)

    const wrapper = mount(ParticleWaveField)
    const handler = add.mock.calls.find(([type]) => type === 'pointermove')?.[1]
    expect(handler).toBeDefined()

    wrapper.unmount()
    expect(remove).toHaveBeenCalledWith('pointermove', handler)
  })
})
