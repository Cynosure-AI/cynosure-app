import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import IconUpload from './IconUpload.vue'

// happy-dom does not decode images; resolve every load so only our logic is under test.
class LoadingImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 1
  naturalHeight = 1
  set src(_value: string) { queueMicrotask(() => this.onload?.()) }
}

afterEach(() => vi.unstubAllGlobals())

async function upload(file: File) {
  vi.stubGlobal('Image', LoadingImage)
  const wrapper = mount(IconUpload, { props: { iconUrl: null } })
  const input = wrapper.get('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [file] })
  await input.trigger('change')
  await vi.waitFor(async () => {
    await flushPromises()
    expect(wrapper.emitted('update') || wrapper.find('.text-status-danger').exists()).toBeTruthy()
  })
  return wrapper
}

describe('IconUpload', () => {
  test('keeps an animated GIF as uploaded instead of flattening it', async () => {
    const gif = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])], 'dance.gif', { type: 'image/gif' })
    const wrapper = await upload(gif)
    expect(wrapper.emitted('update')?.[0]?.[0]).toBe('data:image/gif;base64,R0lGODlh')
  })

  test('explains the size limit for GIFs too large to keep as they are', async () => {
    const gif = new File([new Uint8Array(1.6 * 1024 * 1024)], 'big.gif', { type: 'image/gif' })
    const wrapper = await upload(gif)
    expect(wrapper.emitted('update')).toBeUndefined()
    expect(wrapper.text()).toContain('under 1.5 MB')
  })
})
