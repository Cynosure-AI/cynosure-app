import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useStickyScroll } from './useStickyScroll'

let resize: () => void
const observe = vi.fn()
const disconnect = vi.fn()

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe = observe
    disconnect = disconnect
  })
})

afterEach(() => vi.unstubAllGlobals())

async function setup() {
  let controls!: ReturnType<typeof useStickyScroll>
  const wrapper = mount(defineComponent({
    setup() {
      const container = ref<HTMLElement | null>(null)
      const content = ref<HTMLElement | null>(null)
      const showContent = ref(true)
      controls = useStickyScroll(container, content)
      return { container, content, showContent, ...controls }
    },
    template: '<div ref="container" @scroll="onScroll"><div v-if="showContent" ref="content" /></div>',
  }))
  const el = wrapper.element as HTMLElement
  let height = 1000
  let viewportHeight = 400
  let top = 600
  // Happy DOM does not perform layout or clamp scrollTop like a browser.
  Object.defineProperties(el, {
    scrollHeight: { get: () => height, configurable: true },
    clientHeight: { get: () => viewportHeight, configurable: true },
    scrollTop: {
      get: () => top,
      set: (value: number) => { top = Math.max(0, Math.min(value, height - viewportHeight)) },
      configurable: true,
    },
  })
  await nextTick()
  await wrapper.trigger('scroll')
  return {
    wrapper, el, controls,
    setHeight: (value: number) => { height = value },
    setViewportHeight: (value: number) => { viewportHeight = value },
  }
}

describe('sticky chat scrolling', () => {
  test('follows a HITL gate larger than the bottom threshold, including later layout growth', async () => {
    const { el, setHeight } = await setup()
    setHeight(1600)
    resize()
    expect(el.scrollTop).toBe(1200)
    setHeight(1950)
    resize()
    expect(el.scrollTop).toBe(1550)
  })

  test('keeps following after a gate is removed and streaming resumes', async () => {
    const { el, setHeight } = await setup()
    setHeight(1600)
    resize()
    setHeight(1000)
    resize()
    el.dispatchEvent(new Event('scroll'))
    setHeight(1300)
    resize()
    expect(el.scrollTop).toBe(900)
  })

  test('preserves the reading position when the user has scrolled up', async () => {
    const { wrapper, el, setHeight, controls } = await setup()
    el.scrollTop = 200
    await wrapper.trigger('scroll')
    setHeight(1600)
    resize()
    controls.scrollToBottomIfFollowing()
    await nextTick()
    expect(el.scrollTop).toBe(200)
  })

  test('resumes following when the user returns within the bottom threshold', async () => {
    const { wrapper, el, setHeight } = await setup()
    el.scrollTop = 200
    await wrapper.trigger('scroll')
    el.scrollTop = 550
    await wrapper.trigger('scroll')
    setHeight(1600)
    resize()
    expect(el.scrollTop).toBe(1200)
  })

  test('cancels a queued follow if the user scrolls up before it runs', async () => {
    const { el, controls } = await setup()
    controls.scrollToBottomIfFollowing()
    el.scrollTop = 200
    el.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(el.scrollTop).toBe(200)
  })

  test('follows viewport resizing while reading along', async () => {
    const { el, setViewportHeight } = await setup()
    setViewportHeight(200)
    resize()
    expect(el.scrollTop).toBe(800)
  })

  test('allows search navigation to pause following and conversation loading to reset it', async () => {
    const { el, controls, setHeight } = await setup()
    controls.stopFollowing()
    setHeight(1600)
    resize()
    expect(el.scrollTop).toBe(600)
    controls.scrollToBottom()
    await nextTick()
    expect(el.scrollTop).toBe(1200)
    setHeight(1800)
    resize()
    expect(el.scrollTop).toBe(1400)
  })

  test('observes the viewport and replaced transcript, then disconnects on unmount', async () => {
    const { wrapper, el } = await setup()
    expect(observe).toHaveBeenCalledWith(el)
    expect(observe).toHaveBeenCalledWith(el.firstElementChild)
    wrapper.vm.showContent = false
    await nextTick()
    observe.mockClear()
    wrapper.vm.showContent = true
    await nextTick()
    expect(observe).toHaveBeenCalledWith(el.firstElementChild)
    disconnect.mockClear()
    wrapper.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
