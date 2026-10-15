import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import WaterRippleField from './WaterRippleField.vue'
import * as rippleSurface from './rippleSurface'

function mockCanvas() {
  // jsdom has no Path2D; the field paints its resting lattice as soon as it mounts.
  const rect = vi.fn()
  vi.stubGlobal('Path2D', class { rect = rect })
  const drawImage = vi.fn()
  const createRadialGradient = vi.fn((..._args: number[]) => ({ addColorStop: vi.fn() }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    drawImage,
    createRadialGradient,
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 100))
  return { rect, drawImage, createRadialGradient }
}

/** Swaps in a real surface whose drop and press can be watched. */
function spySurface() {
  const surface = rippleSurface.createRippleSurface(23, 12)
  vi.spyOn(rippleSurface, 'createRippleSurface').mockReturnValue(surface)
  return surface
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

  test('pointer movement disturbs the water only after the cursor enters', () => {
    mockCanvas()
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    const press = vi.spyOn(spySurface(), 'press')
    const wrapper = mount(WaterRippleField)

    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 50 }))
    expect(press).not.toHaveBeenCalled()
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 80, clientY: 50 }))
    expect(press).toHaveBeenCalled()
    wrapper.unmount()
  })

  test('clicking the background drops a ripple, but clicking a control does not', () => {
    mockCanvas()
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    const drop = vi.spyOn(spySurface(), 'drop')
    const button = document.createElement('button')
    document.body.append(button)
    const wrapper = mount(WaterRippleField)

    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 50 }))
    expect(drop).not.toHaveBeenCalled()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 50 }))
    expect(drop).toHaveBeenCalledOnce()

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

  test('a resting field breathes from its cached lattice at a reduced frame rate', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { rect, drawImage, createRadialGradient } = mockCanvas()
    const frames = mockFrames()
    const wrapper = mount(WaterRippleField)
    expect(frames.raf).toHaveBeenCalled()
    expect(rect).toHaveBeenCalled()

    rect.mockClear()
    drawImage.mockClear()
    for (let t = 0; t < 1000; t += 10) frames.advance(10)
    // The lattice is never rebuilt; each repaint only redraws the cache under a new breath.
    expect(rect).not.toHaveBeenCalled()
    expect(drawImage.mock.calls.length).toBeGreaterThan(20)
    expect(drawImage.mock.calls.length).toBeLessThan(40)

    const swell = () => createRadialGradient.mock.calls.at(-1)?.[5]
    const first = swell()
    for (let t = 0; t < 3000; t += 50) frames.advance(50)
    expect(swell()).not.toBeCloseTo(first!)

    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a delayed flare runs even when the underlying ripple has already settled', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { rect, drawImage } = mockCanvas()
    const frames = mockFrames()
    // Isolate the after-response from water motion: the simulation stays at rest.
    vi.spyOn(spySurface(), 'drop').mockImplementation(() => {})
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
    drawImage.mockClear()
    frames.advance(50)
    expect(rect).not.toHaveBeenCalled()
    expect(drawImage).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  test('low intensity keeps flares far shorter', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { rect } = mockCanvas()
    const frames = mockFrames()

    const peakBarAfterClick = (intensity: number) => {
      const wrapper = mount(WaterRippleField, { props: { intensity } })
      window.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 90, clientY: 60 }))
      let peak = 0
      for (let t = 0; t < 1200; t += 50) {
        rect.mockClear()
        frames.advance(50)
        for (const [, , , height] of rect.mock.calls) peak = Math.max(peak, height)
      }
      wrapper.unmount()
      return peak
    }

    const quiet = peakBarAfterClick(0.2)
    const full = peakBarAfterClick(1)
    expect(quiet - 1.5).toBeLessThan((full - 1.5) / 2)
  })

  test('changing intensity repaints the lattice while it fades, then only breathes', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { rect, drawImage } = mockCanvas()
    const frames = mockFrames()
    const wrapper = mount(WaterRippleField, { props: { intensity: 0.35 } })
    for (let t = 0; t < 500; t += 50) frames.advance(50)

    rect.mockClear()
    await wrapper.setProps({ intensity: 1 })
    frames.advance(50)
    expect(rect).toHaveBeenCalled()

    for (let t = 0; t < 2000; t += 50) frames.advance(50)
    rect.mockClear()
    drawImage.mockClear()
    frames.advance(50)
    expect(rect).not.toHaveBeenCalled()
    expect(drawImage).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  test('reduced motion holds one still frame and responds to preference changes', () => {
    vi.useFakeTimers()
    const { drawImage } = mockCanvas()
    const frames = mockFrames()
    const query = new EventTarget() as MediaQueryList
    Object.defineProperty(query, 'matches', { configurable: true, value: true })
    vi.spyOn(window, 'matchMedia').mockReturnValue(query)
    const wrapper = mount(WaterRippleField)
    expect(drawImage).toHaveBeenCalled()

    window.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 40, clientY: 50 }))
    frames.advance(10000)
    expect(frames.raf).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    Object.defineProperty(query, 'matches', { value: false })
    query.dispatchEvent(new Event('change'))
    expect(frames.raf).toHaveBeenCalledOnce()

    Object.defineProperty(query, 'matches', { value: true })
    query.dispatchEvent(new Event('change'))
    expect(frames.cancel).toHaveBeenCalled()
    wrapper.unmount()
  })

  test('hidden tabs cancel animation and resume breathing when visible', () => {
    vi.useFakeTimers()
    mockCanvas()
    const frames = mockFrames()
    const wrapper = mount(WaterRippleField)
    expect(frames.raf).toHaveBeenCalledOnce()

    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.cancel).toHaveBeenCalled()
    frames.advance(10000)
    expect(frames.raf).toHaveBeenCalledOnce()

    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.raf).toHaveBeenCalledTimes(2)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
