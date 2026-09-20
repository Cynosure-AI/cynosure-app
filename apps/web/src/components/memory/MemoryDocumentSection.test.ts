import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { MemoryFolder } from '../../api/types'
import MemoryDocumentSection from './MemoryDocumentSection.vue'

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

const MemoryFileExplorerStub = defineComponent({
  name: 'MemoryFileExplorer',
  emits: [
    'navigateFolder', 'createFolder', 'editFolder', 'deleteFolder',
    'toggleAutoMemoryExclusion', 'spacesChanged', 'openGlobalDocument', 'selectView',
  ],
  setup(_, { expose }) {
    expose({ ingestFiles, openDocument: vi.fn() })
    return () => null
  },
})

const MemoryVirtualExplorerStub = defineComponent({
  name: 'MemoryVirtualExplorer',
  props: { mode: String },
  emits: ['home', 'openDocument', 'restored'],
  template: '<div data-testid="virtual-explorer">{{ mode }}</div>',
})

function mountSection(activeView: 'folder' | 'recent' | 'trash' = 'folder') {
  return mount(MemoryDocumentSection, {
    props: {
      spaces,
      spacesLoading: false,
      selectedFolderId: 'uncategorized',
      selectedFolder: spaces[0],
      activeView,
    },
    global: { stubs: {
      MemoryFileExplorer: MemoryFileExplorerStub,
      MemoryVirtualExplorer: MemoryVirtualExplorerStub,
    } },
  })
}

function fileDrag(type: string, files: File[] = []): DragEvent {
  const event = new DragEvent(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files, dropEffect: 'none' },
  })
  return event
}

describe('MemoryDocumentSection explorer shell', () => {
  beforeEach(() => ingestFiles.mockReset())

  test('opens Recent and Trash from virtual folders in the full-width explorer', async () => {
    const wrapper = mountSection()
    expect(wrapper.find('[data-testid="memory-folder-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="memory-document-drop-zone"]').exists()).toBe(true)

    wrapper.getComponent(MemoryFileExplorerStub).vm.$emit('selectView', 'recent')
    await nextTick()
    expect(wrapper.emitted('select-view')).toContainEqual(['recent'])
    await wrapper.setProps({ activeView: 'recent' })
    expect(wrapper.get('[data-testid="memory-special-content"]').text()).toBe('recent')

    await wrapper.setProps({ activeView: 'trash' })
    expect(wrapper.get('[data-testid="memory-special-content"]').text()).toBe('trash')
  })

  test('returns virtual views to the memory root', async () => {
    const wrapper = mountSection('recent')
    wrapper.getComponent(MemoryVirtualExplorerStub).vm.$emit('home')
    await nextTick()

    expect(wrapper.emitted('update:selectedFolderId')).toContainEqual(['uncategorized'])
    expect(wrapper.emitted('select-view')).toContainEqual(['folder'])
    expect(wrapper.emitted('folder-navigation')).toHaveLength(1)
  })

  test('forwards explorer folder navigation and clears a consumed deep link', async () => {
    const wrapper = mountSection()
    wrapper.getComponent(MemoryFileExplorerStub).vm.$emit('navigateFolder', 'archive')
    await nextTick()

    expect(wrapper.emitted('update:selectedFolderId')).toContainEqual(['archive'])
    expect(wrapper.emitted('select-view')).toContainEqual(['folder'])
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
    const list = wrapper.getComponent(MemoryFileExplorerStub)
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
