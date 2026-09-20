import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { MemoryFolder } from '../../api/types'
import MemoryDocumentsSection from './MemoryDocumentsSection.vue'

const ingestFiles = vi.fn()

const spaces: MemoryFolder[] = [
  {
    id: 'uncategorized', name: 'Uncategorized', description: '', directoryPath: '/memory',
    folderPath: '', sortOrder: 0, isUncategorized: true, createdAt: 1, fileCount: 1,
  },
  {
    id: 'archive', name: 'Archive', description: '', directoryPath: '/memory/archive',
    folderPath: 'archive', sortOrder: 1, isUncategorized: false, createdAt: 1, fileCount: 0,
  },
]

const MemoryDocumentListStub = defineComponent({
  name: 'MemoryDocumentList',
  emits: [
    'navigateFolder', 'createFolder', 'editFolder', 'deleteFolder',
    'toggleAutoMemoryExclusion', 'spacesChanged', 'openGlobalDocument',
  ],
  setup(_, { expose }) {
    expose({ ingestFiles, openDocument: vi.fn() })
    return () => null
  },
})

function mountSection(activeSidebarView: 'folder' | 'recent' | 'trash' = 'folder') {
  return mount(MemoryDocumentsSection, {
    props: {
      spaces,
      spacesLoading: false,
      selectedFolderId: 'uncategorized',
      selectedFolder: spaces[0],
      activeSidebarView,
    },
    slots: {
      recent: '<div data-testid="recent-content">Recent content</div>',
      trash: '<div data-testid="trash-content">Trash content</div>',
    },
    global: { stubs: { MemoryDocumentList: MemoryDocumentListStub } },
  })
}

function fileDrag(type: string, files: File[] = []): DragEvent {
  const event = new DragEvent(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files, dropEffect: 'none' },
  })
  return event
}

describe('MemoryDocumentsSection explorer shell', () => {
  beforeEach(() => ingestFiles.mockReset())

  test('uses one full-width explorer and keeps Recent and Trash as compact views', async () => {
    const wrapper = mountSection()
    expect(wrapper.find('[data-testid="memory-folder-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="memory-document-drop-zone"]').exists()).toBe(true)

    await wrapper.get('[data-testid="memory-recent-view"]').trigger('click')
    expect(wrapper.emitted('select-sidebar-view')).toContainEqual(['recent'])
    await wrapper.setProps({ activeSidebarView: 'recent' })
    expect(wrapper.get('[data-testid="recent-content"]').text()).toBe('Recent content')

    await wrapper.get('[data-testid="memory-trash-view"]').trigger('click')
    expect(wrapper.emitted('select-sidebar-view')).toContainEqual(['trash'])
    await wrapper.setProps({ activeSidebarView: 'trash' })
    expect(wrapper.get('[data-testid="trash-content"]').text()).toBe('Trash content')
  })

  test('forwards explorer folder navigation and clears a consumed deep link', async () => {
    const wrapper = mountSection()
    wrapper.getComponent(MemoryDocumentListStub).vm.$emit('navigateFolder', 'archive')
    await nextTick()

    expect(wrapper.emitted('update:selectedFolderId')).toContainEqual(['archive'])
    expect(wrapper.emitted('select-sidebar-view')).toContainEqual(['folder'])
    expect(wrapper.emitted('folder-navigation')).toHaveLength(1)
  })

  test('keeps operating-system file drop upload on the explorer surface', async () => {
    const wrapper = mountSection()
    const dropZone = wrapper.get('[data-testid="memory-document-drop-zone"]')
    const file = new File(['notes'], 'notes.md', { type: 'text/markdown' })

    dropZone.element.dispatchEvent(fileDrag('dragenter'))
    await nextTick()
    expect(dropZone.text()).toContain('Drop files into Uncategorized')

    dropZone.element.dispatchEvent(fileDrag('drop', [file]))
    await nextTick()
    expect(ingestFiles).toHaveBeenCalledWith([file])
  })

  test('forwards folder actions from the explorer', async () => {
    const wrapper = mountSection()
    const list = wrapper.getComponent(MemoryDocumentListStub)
    list.vm.$emit('createFolder', spaces[1])
    list.vm.$emit('editFolder', spaces[1])
    list.vm.$emit('deleteFolder', spaces[1])
    list.vm.$emit('toggleAutoMemoryExclusion', spaces[1])
    await nextTick()

    expect(wrapper.emitted('create-folder')).toEqual([[spaces[1]]])
    expect(wrapper.emitted('edit-folder')).toEqual([[spaces[1]]])
    expect(wrapper.emitted('delete-folder')).toEqual([[spaces[1]]])
    expect(wrapper.emitted('toggle-auto-memory-exclusion')).toEqual([[spaces[1]]])
  })
})
