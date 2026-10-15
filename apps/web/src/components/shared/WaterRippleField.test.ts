import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import WaterRippleField from './WaterRippleField.vue'
import * as rippleSurface from './rippleSurface'

function mockCanvas() {
  // jsdom has no Path2D; the field draws its resting lattice as soon as it mounts.
  const rect = vi.fn()
  vi.stubGlobal('Path2D', class { rect = rect })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fill: vi.fn(),
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 100))
  return { rect }
}

function mockFrames() {
  let frame: FrameRequestCallback | undefined
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    frame = callback
    return 1
  })
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { frame = undefined })
  return {
    raf,
    cancel,
    advance(ms: number) {
      vi.advanceTimersByTime(ms)
      const callback = frame
      frame = undefined
      callback?.(performance.now())
    },
  }
}

describe('WaterRippleField', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  test('renders a decorative canvas hidden from assistive tech', () => {
    const wrapper = mount(WaterRippleField)
    const canvas = wrapper.get('canvas')

    expect(canvas.attributes('aria-hidden')).toBe('true')
    expect(canvas.classes()).toContain('pointer-events-none')
    wrapper.unmount()
  })

  test('pointer movement wakes the field after the cursor enters', () => {
    mockCanvas()
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    const wrapper = mount(WaterRippleField)
    expect(raf).not.toHaveBeenCalled()

    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 50 }))
    expect(raf).not.toHaveBeenCalled()
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 80, clientY: 50 }))
    expect(raf).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  test('clicking the background drops a ripple, but clicking a control does not', () => {
    mockCanvas()
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    const button = document.createElement('button')
    document.body.append(button)
    const wrapper = mount(WaterRippleField)

    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 50 }))
    expect(raf).not.toHaveBeenCalled()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 50 }))
    expect(raf).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    button.remove()
  })

  test('removes its pointer listeners on unmount', () => {
    mockCanvas()
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')

    const wrapper = mount(WaterRippleField)
    const move = add.mock.calls.find(([type]) => type === 'pointermove')?.[1]
    const down = add.mock.calls.find(([type]) => type === 'pointerdown')?.[1]
    expect(move).toBeDefined()
    expect(down).toBeDefined()

    wrapper.unmount()
    expect(remove).toHaveBeenCalledWith('pointermove', move)
    expect(remove).toHaveBeenCalledWith('pointerdown', down)
  })

  test('idle pulses stretch data bars, then the animation sleeps again', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { rect } = mockCanvas()
    const frames = mockFrames()
    const wrapper = mount(WaterRippleField)
    const restingDots = rect.mock.calls.map(args => [...args])

    frames.advance(4600)
    rect.mockClear()
    frames.advance(650)
    expect(rect.mock.calls.some(([, , , height]) => height > 1.5)).toBe(true)

    frames.advance(1400)
    rect.mockClear()
    frames.advance(17)
    expect(rect.mock.calls).toEqual(restingDots)
    const count = frames.raf.mock.calls.length
    frames.advance(100)
    expect(frames.raf).toHaveBeenCalledTimes(count)

    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a delayed flare runs even when the underlying ripple has already settled', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { rect } = mockCanvas()
    const frames = mockFrames()
    // Isolate the after-response from water motion: the simulation stays at rest.
    const surface = rippleSurface.createRippleSurface(23, 12)
    vi.spyOn(surface, 'drop').mockImplementation(() => {})
    vi.spyOn(rippleSurface, 'createRippleSurface').mockReturnValue(surface)
    const wrapper = mount(WaterRippleField)
    const restingDots = rect.mock.calls.map(args => [...args])

    window.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 90, clientY: 60 }))
    rect.mockClear()
    frames.advance(100)
    expect(rect.mock.calls).toEqual(restingDots)

    rect.mockClear()
    frames.advance(650)
    expect(rect.mock.calls.some(([, , , height]) => height > 1.5)).toBe(true)

    frames.advance(600)
    rect.mockClear()
    frames.advance(17)
    expect(rect.mock.calls).toEqual(restingDots)
    wrapper.unmount()
  })

  test('low intensity skips ambient pulses and keeps flares far shorter', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { rect } = mockCanvas()
    const frames = mockFrames()

    const peakBarAfterClick = (intensity: number) => {
      const wrapper = mount(WaterRippleField, { props: { intensity } })
      const timers = vi.getTimerCount()
      window.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 90, clientY: 60 }))
      let peak = 0
      for (let t = 0; t < 1200; t += 50) {
        rect.mockClear()
        frames.advance(50)
        for (const [, , , height] of rect.mock.calls) peak = Math.max(peak, height)
      }
      wrapper.unmount()
      return { peak, timers }
    }

    const quiet = peakBarAfterClick(0.2)
    const full = peakBarAfterClick(1)
    expect(quiet.timers).toBe(0)
    expect(full.timers).toBe(1)
    expect(quiet.peak - 1.5).toBeLessThan((full.peak - 1.5) / 2)

    const wrapper = mount(WaterRippleField, { props: { intensity: 0.2 } })
    await wrapper.setProps({ intensity: 0.35 })
    expect(vi.getTimerCount()).toBe(1)
    await wrapper.setProps({ intensity: 0.2 })
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })

  test('changing intensity fades in over a few frames, then sleeps', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { rect } = mockCanvas()
    const frames = mockFrames()
    const wrapper = mount(WaterRippleField, { props: { intensity: 0.35 } })
    const quiet = rect.mock.calls.length

    await wrapper.setProps({ intensity: 1 })
    expect(frames.raf).toHaveBeenCalled()
    for (let t = 0; t < 2000; t += 50) frames.advance(50)
    const calls = frames.raf.mock.calls.length
    rect.mockClear()
    frames.advance(100)
    expect(frames.raf).toHaveBeenCalledTimes(calls)
    expect(quiet).toBeGreaterThan(0)
    wrapper.unmount()
  })

  test('reduced motion stays static and responds to preference changes', () => {
    vi.useFakeTimers()
    mockCanvas()
    const frames = mockFrames()
    const query = new EventTarget() as MediaQueryList
    Object.defineProperty(query, 'matches', { configurable: true, value: true })
    vi.spyOn(window, 'matchMedia').mockReturnValue(query)
    const wrapper = mount(WaterRippleField)

    window.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 40, clientY: 50 }))
    frames.advance(10000)
    expect(frames.raf).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    Object.defineProperty(query, 'matches', { value: false })
    query.dispatchEvent(new Event('change'))
    window.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 40, clientY: 50 }))
    expect(frames.raf).toHaveBeenCalledOnce()

    Object.defineProperty(query, 'matches', { value: true })
    query.dispatchEvent(new Event('change'))
    expect(frames.cancel).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })

  test('hidden tabs cancel animation and resume ambient scheduling when visible', () => {
    vi.useFakeTimers()
    mockCanvas()
    const frames = mockFrames()
    const wrapper = mount(WaterRippleField)
    window.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 40, clientY: 50 }))

    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.cancel).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    frames.advance(10000)
    expect(frames.raf).toHaveBeenCalledOnce()

    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(1)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
