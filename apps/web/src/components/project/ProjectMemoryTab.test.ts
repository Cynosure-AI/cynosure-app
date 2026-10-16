import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import ProjectMemoryTab from './ProjectMemoryTab.vue'
import type { MemoryFolder } from '../../api/types'
import type { ProjectDto } from '@shared/types'

function folder(id: string, folderPath: string, parentFolderPath: string | null = null): MemoryFolder {
  return {
    id, name: folderPath.split('/').at(-1) || 'Memory', description: '', directoryPath: `/memory/${folderPath}`,
    folderPath, parentFolderPath, sortOrder: 0, isUncategorized: !folderPath, createdAt: 1, fileCount: 0,
  }
}

const chatStore = reactive({
  memoryFolders: [
    folder('root', ''),
    folder('garden', 'Garden'),
    folder('beds', 'Garden/Beds', 'Garden'),
    folder('gardening-tools', 'Gardening Tools'),
  ],
  loadMemoryFolders: vi.fn().mockResolvedValue(undefined),
})

const route = reactive<{ query: Record<string, string | undefined> }>({ query: { tab: 'memories' } })
const replace = vi.fn((location: { query: Record<string, string | undefined> }) => {
  route.query = Object.fromEntries(Object.entries(location.query).filter(([, value]) => value !== undefined))
  return Promise.resolve()
})

vi.mock('../../stores/chat.store', () => ({ useChatStore: () => chatStore }))
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ replace }) }))

function mountTab(memoryFolderId: string | null) {
  return mount(ProjectMemoryTab, {
    props: { project: { id: 'project-1', name: 'Garden Planner', memoryFolderId } as ProjectDto },
    global: {
      stubs: {
        Icon: true,
        RouterLink: { template: '<a><slot /></a>' },
        MemoryDocumentSection: { name: 'MemoryDocumentSection', props: ['spaces', 'rootFolderId', 'selectedFolderId'], template: '<div />' },
        MemoryFolderDialogs: true,
      },
    },
  })
}

describe('ProjectMemoryTab', () => {
  beforeEach(() => {
    route.query = { tab: 'memories' }
    replace.mockClear()
  })

  test('offers project settings when no memory folder is linked', async () => {
    const wrapper = mountTab(null)
    await flushPromises()

    expect(wrapper.findComponent({ name: 'MemoryDocumentSection' }).exists()).toBe(false)
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('openSettings')).toHaveLength(1)
  })

  test('shows only the project folder and its subfolders, starting at the project folder', async () => {
    const wrapper = mountTab('garden')
    await flushPromises()

    const section = wrapper.getComponent({ name: 'MemoryDocumentSection' })
    expect((section.props('spaces') as MemoryFolder[]).map((item) => item.id)).toEqual(['garden', 'beds'])
    expect(section.props('rootFolderId')).toBe('garden')
    expect(section.props('selectedFolderId')).toBe('garden')
    expect(chatStore.loadMemoryFolders).toHaveBeenCalled()
  })

  test('keeps the open subfolder in the address and restores it on load', async () => {
    const wrapper = mountTab('garden')
    await flushPromises()
    const section = wrapper.getComponent({ name: 'MemoryDocumentSection' })

    section.vm.$emit('update:selectedFolderId', 'beds')
    await flushPromises()
    expect(route.query).toEqual({ tab: 'memories', folder: 'beds' })

    section.vm.$emit('update:selectedFolderId', 'garden')
    await flushPromises()
    expect(route.query).toEqual({ tab: 'memories' })
    wrapper.unmount()

    route.query = { tab: 'memories', folder: 'beds' }
    const reloaded = mountTab('garden')
    await flushPromises()
    expect(reloaded.getComponent({ name: 'MemoryDocumentSection' }).props('selectedFolderId')).toBe('beds')
  })

  test('falls back to the project folder for a linked folder outside the project', async () => {
    route.query = { tab: 'memories', folder: 'gardening-tools' }
    const wrapper = mountTab('garden')
    await flushPromises()

    expect(wrapper.getComponent({ name: 'MemoryDocumentSection' }).props('selectedFolderId')).toBe('garden')
    expect(route.query).toEqual({ tab: 'memories' })
  })
})
