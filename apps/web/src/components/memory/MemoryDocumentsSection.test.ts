import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { beforeEach, describe, expect, test } from 'vitest'
import type { MemoryFolder } from '../../api/types'
import MemoryDocumentsSection from './MemoryDocumentsSection.vue'

const DOCUMENT_DRAG_MIME = 'application/x-cynosure-memory-documents'

const spaces: MemoryFolder[] = [
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

function mountSection(memorySpaces = spaces, extraProps: Record<string, unknown> = {}) {
  return mount(MemoryDocumentsSection, {
    props: {
      spaces: memorySpaces,
      spacesLoading: false,
      selectedCategoryId: 'uncategorized',
      selectedCategory: spaces[0],
      ...extraProps,
    },
    global: {
      stubs: { MemoryDocumentList: MemoryDocumentListStub },
    },
  })
}

describe('MemoryDocumentsSection drag targets', () => {
  beforeEach(() => sessionStorage.clear())

  test('collapses document folders initially and restores opened folders during the session', async () => {
    const nestedSpaces: MemoryFolder[] = [
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

  test('reveals the linked category and keeps drag highlighting when MIME inspection is unavailable', async () => {
    const nestedSpaces: MemoryFolder[] = [
      ...spaces,
      { ...spaces[1], id: 'projects', name: 'Projects', categoryPath: 'projects', directoryPath: '/memory/projects' },
      { ...spaces[1], id: 'acme', name: 'Acme', categoryPath: 'projects/acme', directoryPath: '/memory/projects/acme' },
    ]
    const wrapper = mountSection(nestedSpaces, {
      selectedCategoryId: 'acme',
      selectedCategory: nestedSpaces[3],
      focusFile: 'notes.md',
    })
    expect(wrapper.find('[data-space-id="acme"]').exists()).toBe(true)

    wrapper.getComponent(MemoryDocumentListStub).vm.$emit('documentDragState', true, {
      sourceCategoryId: 'acme', sourceFiles: ['notes.md'],
    })
    wrapper.get('[data-space-id="archive"]').element.dispatchEvent(dragEvent('dragover', []))
    await nextTick()
    expect(wrapper.get('[data-space-id="archive"]').classes()).toContain('ring-1')
  })

  test('presents Uncategorized as the root and indents physical folders beneath it', () => {
    const wrapper = mountSection()
    const root = wrapper.get('[data-space-id="uncategorized"]')
    const archive = wrapper.get('[data-space-id="archive"]')

    expect(root.attributes('data-category-depth')).toBe('0')
    expect(root.text()).toContain('Root')
    expect(archive.attributes('data-category-depth')).toBe('1')
    expect(archive.get('[aria-hidden="true"]').attributes('style')).toContain('width: 12px')
  })

  test('marks direct folder clicks as navigation so a consumed file deep link can be cleared', async () => {
    const wrapper = mountSection()
    await wrapper.get('[data-space-id="archive"] button.min-w-0').trigger('click')
    expect(wrapper.emitted('update:selectedCategoryId')).toContainEqual(['archive'])
    expect(wrapper.emitted('category-navigation')).toHaveLength(1)
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
