import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { beforeEach, describe, expect, test } from 'vitest'
import type { MemoryCategory } from '../../api/types'
import MemoryDocumentsSection from './MemoryDocumentsSection.vue'

const DOCUMENT_DRAG_MIME = 'application/x-cynosure-memory-documents'

const spaces: MemoryCategory[] = [
  {
    id: 'uncategorized',
    name: 'Uncategorized',
    description: '',
    directoryPath: '/memory',
    categoryPath: '',
    sortOrder: 0,
    isUncategorized: true,
    createdAt: 1,
    fileCount: 1,
  },
  {
    id: 'archive',
    name: 'Archive',
    description: '',
    directoryPath: '/memory/archive',
    categoryPath: 'archive',
    sortOrder: 1,
    isUncategorized: false,
    createdAt: 1,
    fileCount: 0,
  },
]

const MemoryDocumentListStub = defineComponent({
  name: 'MemoryDocumentList',
  setup(_, { expose }) {
    expose({ ingestFiles: () => undefined, moveDocumentsToCategory: () => undefined })
    return () => null
  },
})

function dragEvent(type: string, types: string[]): DragEvent {
  const event = new DragEvent(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types,
      files: [],
      dropEffect: 'none',
      getData: () => '',
    },
  })
  return event
}

function mountSection(memorySpaces = spaces) {
  return mount(MemoryDocumentsSection, {
    props: {
      spaces: memorySpaces,
      spacesLoading: false,
      selectedCategoryId: 'uncategorized',
      selectedCategory: spaces[0],
    },
    global: {
      stubs: { MemoryDocumentList: MemoryDocumentListStub },
    },
  })
}

describe('MemoryDocumentsSection drag targets', () => {
  beforeEach(() => sessionStorage.clear())

  test('collapses document folders initially and restores opened folders during the session', async () => {
    const nestedSpaces: MemoryCategory[] = [
      ...spaces,
      { ...spaces[1], id: 'projects', name: 'Projects', categoryPath: 'projects', directoryPath: '/memory/projects' },
      { ...spaces[1], id: 'acme', name: 'Acme', categoryPath: 'projects/acme', directoryPath: '/memory/projects/acme' },
    ]
    const first = mountSection(nestedSpaces)
    expect(first.find('[data-space-id="acme"]').exists()).toBe(false)

    await first.get('[aria-label="Expand Projects"]').trigger('click')
    expect(first.find('[data-space-id="acme"]').exists()).toBe(true)
    first.unmount()

    const restored = mountSection(nestedSpaces)
    expect(restored.find('[data-space-id="acme"]').exists()).toBe(true)
  })

  test('presents Uncategorized as the root and indents physical categories beneath it', () => {
    const wrapper = mountSection()
    const root = wrapper.get('[data-space-id="uncategorized"]')
    const archive = wrapper.get('[data-space-id="archive"]')

    expect(root.attributes('data-category-depth')).toBe('0')
    expect(root.text()).toContain('Root')
    expect(archive.attributes('data-category-depth')).toBe('1')
    expect(archive.get('[aria-hidden="true"]').attributes('style')).toContain('width: 12px')
  })

  test('shows the upload treatment only for file drags over the document pane', async () => {
    const wrapper = mountSection()
    const dropZone = wrapper.get('[data-testid="memory-document-drop-zone"]')

    dropZone.element.dispatchEvent(dragEvent('dragenter', ['Files']))
    await nextTick()
    expect(dropZone.text()).toContain('Drop files into Uncategorized')

    dropZone.element.dispatchEvent(dragEvent('dragleave', ['Files']))
    dropZone.element.dispatchEvent(dragEvent('dragenter', [DOCUMENT_DRAG_MIME]))
    await nextTick()
    expect(dropZone.text()).not.toContain('Drop files into Uncategorized')
  })

  test('excludes the source folder while allowing another folder as a move target', async () => {
    const wrapper = mountSection()
    const selectedFolder = wrapper.get('[data-space-id="uncategorized"]')
    const archiveFolder = wrapper.get('[data-space-id="archive"]')

    selectedFolder.element.dispatchEvent(dragEvent('dragenter', [DOCUMENT_DRAG_MIME]))
    await nextTick()
    expect(selectedFolder.classes()).not.toContain('ring-1')

    archiveFolder.element.dispatchEvent(dragEvent('dragenter', [DOCUMENT_DRAG_MIME]))
    await nextTick()
    expect(archiveFolder.classes()).toContain('ring-1')
  })
})
