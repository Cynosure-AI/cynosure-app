import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, test } from 'vitest'
import ArtifactPreviewModal from './ArtifactPreviewModal.vue'

describe('ArtifactPreviewModal', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('previews an image and offers the original as a download', () => {
    const artifact = {
      href: '/api/files?path=%2Ftmp%2Fresult.png',
      label: 'result.png',
      kind: 'image' as const,
      ext: 'PNG',
    }
    mount(ArtifactPreviewModal, {
      props: { artifact },
      attachTo: document.body,
      global: { stubs: { Icon: true } },
    })

    expect(document.body.querySelector<HTMLImageElement>('img')?.getAttribute('src')).toBe(artifact.href)
    const download = document.body.querySelector<HTMLAnchorElement>('a[download]')
    expect(download?.getAttribute('href')).toBe(artifact.href)
    expect(download?.getAttribute('download')).toBe(artifact.label)
  })

  test('uses a sandboxed inline preview for supported documents', () => {
    mount(ArtifactPreviewModal, {
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

    const preview = document.body.querySelector<HTMLIFrameElement>('iframe')
    expect(preview?.getAttribute('src')).toContain('notes.md')
    expect(preview?.hasAttribute('sandbox')).toBe(true)
  })

  test('emits close from the modal action', async () => {
    const wrapper = mount(ArtifactPreviewModal, {
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
    mount(ArtifactPreviewModal, {
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
    expect(chatLink?.getAttribute('href')).toBe('/triggers/chat/conversation-1')
  })
})
