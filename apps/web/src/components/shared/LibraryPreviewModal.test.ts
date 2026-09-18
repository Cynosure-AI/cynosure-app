import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import LibraryPreviewModal from './LibraryPreviewModal.vue'

const fetchMock = vi.fn()

describe('LibraryPreviewModal', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  test('previews an image and offers the original as a download', () => {
    const artifact = {
      href: '/api/files?path=%2Ftmp%2Fresult.png',
      label: 'result.png',
      kind: 'image' as const,
      ext: 'PNG',
    }
    mount(LibraryPreviewModal, {
      props: { artifact },
      attachTo: document.body,
      global: { stubs: { Icon: true } },
    })

    expect(document.body.querySelector<HTMLImageElement>('img')?.getAttribute('src')).toBe(artifact.href)
    const download = document.body.querySelector<HTMLAnchorElement>('a[download]')
    expect(download?.getAttribute('href')).toBe(artifact.href)
    expect(download?.getAttribute('download')).toBe(artifact.label)
  })

  test('renders text documents inline with themed styling', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response('# notes\ncontent', { status: 200 }))
    mount(LibraryPreviewModal, {
      props: {
        artifact: {
          href: 'about:blank#notes.md',
          label: 'notes.md',
          kind: 'file',
          ext: 'MD',
        },
      },
      attachTo: document.body,
      global: { stubs: { Icon: true } },
    })
    await flushPromises()

    const preview = document.body.querySelector('pre.library-text-preview')
    expect(preview?.textContent).toContain('content')
    expect(document.body.querySelector('iframe')).toBeNull()
  })

  test('emits close from the modal action', async () => {
    const wrapper = mount(LibraryPreviewModal, {
      props: {
        artifact: {
          href: '/api/files?path=%2Ftmp%2Freport.docx',
          label: 'report.docx',
          kind: 'file',
          ext: 'DOCX',
        },
      },
      attachTo: document.body,
      global: { stubs: { Icon: true } },
    })

    const close = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Close')
    close?.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  test('links back to the originating chat when available', () => {
    mount(LibraryPreviewModal, {
      props: {
        artifact: {
          href: '/api/files?path=%2Ftmp%2Fgenerated.png',
          label: 'generated.png',
          kind: 'image',
          ext: 'PNG',
        },
        conversationId: 'conversation-1',
      },
      attachTo: document.body,
      global: {
        stubs: {
          Icon: true,
          RouterLink: {
            template: '<a :href="to"><slot /></a>',
            props: ['to'],
          },
        },
      },
    })

    const chatLink = [...document.body.querySelectorAll('a')]
      .find((link) => link.textContent?.includes('Go to chat'))
    expect(chatLink?.getAttribute('href')).toBe('/chat/conversation-1')
  })
})
