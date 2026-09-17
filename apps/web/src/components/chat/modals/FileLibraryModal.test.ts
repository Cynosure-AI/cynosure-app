import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import FileLibraryModal from './FileLibraryModal.vue'

const mocks = vi.hoisted(() => ({
  listUploads: vi.fn(),
  resolveUploads: vi.fn(),
  resolveArtifacts: vi.fn(),
  listActivity: vi.fn(),
}))

vi.mock('../../../api/client', () => ({
  api: {
    chat: {
      listUploads: mocks.listUploads,
      resolveUploads: mocks.resolveUploads,
      resolveArtifacts: mocks.resolveArtifacts,
    },
    activity: { list: mocks.listActivity },
  },
}))

function mountModal() {
  return mount(FileLibraryModal, {
    props: { show: false },
    global: {
      stubs: {
        Icon: true,
        ModalDialog: { template: '<div><slot /></div>' },
      },
    },
  })
}

describe('FileLibraryModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listUploads.mockResolvedValue({ items: [], total: 0 })
    mocks.listActivity.mockResolvedValue({
      items: [{
        id: 'artifact:message-1',
        kind: 'artifact',
        title: 'Generated concept.png',
        description: 'Design chat',
        createdAt: 10,
        agentId: null,
        agentName: null,
        agentIconUrl: null,
        conversationId: 'conversation-1',
        artifacts: [{ href: '/api/files?path=concept.png', label: 'concept.png', kind: 'image', ext: 'PNG' }],
      }],
      hasMore: false,
    })
    mocks.resolveArtifacts.mockResolvedValue({
      images: [{ id: 'artifact:message-1:0', name: 'concept.png', url: 'data:image/png;base64,image' }],
      audio: [],
      files: [],
    })
  })

  test('selects a generated file from the Generated tab', async () => {
    const wrapper = mountModal()
    await wrapper.setProps({ show: true })
    await flushPromises()

    const artifactsTab = wrapper.findAll('[role="tab"]').find((button) => button.text().includes('Generated'))
    expect(artifactsTab).toBeTruthy()
    await artifactsTab!.trigger('click')
    await flushPromises()

    expect(mocks.listActivity).toHaveBeenCalledWith(expect.objectContaining({ types: ['artifact'] }))
    const artifactButton = wrapper.findAll('button').find((button) => button.text().includes('concept.png'))
    expect(artifactButton).toBeTruthy()
    await artifactButton!.trigger('click')
    const addButton = wrapper.findAll('button').find((button) => button.text().includes('Add (1)'))
    await addButton!.trigger('click')
    await flushPromises()

    expect(mocks.resolveArtifacts).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'artifact:message-1:0', kind: 'image', label: 'concept.png' }),
    ])
    expect(wrapper.emitted('add')?.[0]).toEqual([{
      images: [{ id: 'artifact:message-1:0', name: 'concept.png', url: 'data:image/png;base64,image' }],
      audio: [],
      files: [],
    }])
  })

  test('shows video artifacts but prevents selecting them', async () => {
    mocks.listActivity.mockResolvedValue({
      items: [{
        id: 'artifact:video-message',
        kind: 'artifact',
        title: 'Generated clip',
        description: 'Video chat',
        createdAt: 10,
        agentId: null,
        agentName: null,
        agentIconUrl: null,
        conversationId: 'conversation-1',
        artifacts: [{ href: '/api/files?path=clip.mp4', label: 'clip.mp4', kind: 'video', ext: 'MP4' }],
      }],
      hasMore: false,
    })
    const wrapper = mountModal()
    await wrapper.setProps({ show: true })
    await flushPromises()
    await wrapper.findAll('[role="tab"]').find((button) => button.text().includes('Generated'))!.trigger('click')
    await flushPromises()

    const videoButton = wrapper.findAll('button').find((button) => button.text().includes('clip.mp4'))
    expect(videoButton?.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Video context is not supported yet')
  })
})
