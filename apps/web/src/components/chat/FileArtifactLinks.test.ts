import { describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import FileArtifactLinks from './FileArtifactLinks.vue'

vi.mock('../shared/LibraryPreviewModal.vue', () => ({
  default: defineComponent({
    name: 'LibraryPreviewModal',
    props: { artifact: { type: Object, default: null } },
    emits: ['close'],
    template: '<div />',
  }),
}))

const artifacts = [{ href: '/api/files?path=%2Fdata%2Fkuchen.md', label: 'kuchen.md', ext: 'MD' }]

function mountLinks(options: { attachTo?: HTMLElement } = {}) {
  return mount(FileArtifactLinks, {
    ...options,
    props: { artifacts },
    global: { stubs: { Icon: true } },
  })
}

describe('FileArtifactLinks', () => {
  test('opens the preview modal on a plain click', async () => {
    const wrapper = mountLinks()
    const modal = wrapper.findComponent({ name: 'LibraryPreviewModal' })
    expect(modal.props('artifact')).toBeNull()

    await wrapper.find('a').trigger('click', { button: 0 })

    expect(modal.props('artifact')).toEqual({ ...artifacts[0], kind: 'file' })
  })

  test('leaves modified clicks to the browser', async () => {
    const wrapper = mountLinks({ attachTo: document.body })
    let defaultPrevented: boolean | null = null
    const recordAndCancel = (event: Event) => {
      defaultPrevented = event.defaultPrevented
      event.preventDefault()
    }
    document.addEventListener('click', recordAndCancel)

    await wrapper.find('a').trigger('click', { button: 0, ctrlKey: true })
    document.removeEventListener('click', recordAndCancel)
    wrapper.unmount()

    expect(defaultPrevented).toBe(false)
    expect(wrapper.findComponent({ name: 'LibraryPreviewModal' }).props('artifact')).toBeNull()
  })
})
