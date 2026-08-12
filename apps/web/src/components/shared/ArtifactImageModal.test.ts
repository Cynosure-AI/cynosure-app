import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, test } from 'vitest'
import ArtifactImageModal from './ArtifactImageModal.vue'

describe('ArtifactImageModal', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('offers the full-size artifact as a named download', () => {
    const src = '/api/files?path=%2Ftmp%2Fgenerated%20image.png'
    mount(ArtifactImageModal, {
      props: { src },
      attachTo: document.body,
      global: { stubs: { Icon: true } },
    })

    const download = document.body.querySelector<HTMLAnchorElement>('a[download]')
    expect(download?.getAttribute('href')).toBe(src)
    expect(download?.getAttribute('download')).toBe('generated image.png')
    expect(download?.getAttribute('aria-label')).toBe('Download image')
  })

  test('emits close from the close button', async () => {
    const wrapper = mount(ArtifactImageModal, {
      props: { src: 'data:image/png;base64,abc' },
      attachTo: document.body,
      global: { stubs: { Icon: true } },
    })

    const closeButton = document.body.querySelector<HTMLButtonElement>('button[aria-label="Close image preview"]')
    closeButton?.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
