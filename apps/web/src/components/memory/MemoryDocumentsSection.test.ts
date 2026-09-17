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

  test('shows direct and descendant document counts for each folder', () => {
    const wrapper = mountSection([
      { ...spaces[0], fileCount: 2, descendantFileCount: 56 },
      { ...spaces[1], fileCount: 4, descendantFileCount: 0 },
    ])

    expect(wrapper.get('[data-space-id="uncategorized"]').text()).toContain('2 (56)')
    expect(wrapper.get('[data-space-id="archive"]').text()).toContain('4')
    expect(wrapper.get('[data-space-id="archive"]').text()).not.toContain('(0)')
  })

  test('marks direct folder clicks as navigation so a consumed file deep link can be cleared', async () => {
    const wrapper = mountSection()
    await wrapper.get('[data-space-id="archive"] button.min-w-0').trigger('click')
    expect(wrapper.emitted('update:selectedCategoryId')).toContainEqual(['archive'])
    expect(wrapper.emitted('category-navigation')).toHaveLength(1)
  })

  test('uses folder-first navigation with a back button on mobile', async () => {
    const wrapper = mountSection()
    expect(wrapper.get('[data-testid="memory-folder-pane"]').classes()).toContain('block')
    expect(wrapper.get('[data-testid="memory-document-drop-zone"]').classes()).toContain('hidden')

    await wrapper.get('[data-space-id="archive"] button.min-w-0').trigger('click')
    expect(wrapper.get('[data-testid="memory-folder-pane"]').classes()).toContain('hidden')
    expect(wrapper.get('[data-testid="memory-document-drop-zone"]').classes()).toContain('block')

    await wrapper.get('[data-testid="memory-mobile-folder-back"]').trigger('click')
    expect(wrapper.get('[data-testid="memory-folder-pane"]').classes()).toContain('block')
    expect(wrapper.get('[data-testid="memory-document-drop-zone"]').classes()).toContain('hidden')
  })

  test('opens the document pane immediately for a linked file', () => {
    const wrapper = mountSection(spaces, { focusFile: 'notes.md' })
    expect(wrapper.get('[data-testid="memory-folder-pane"]').classes()).toContain('hidden')
    expect(wrapper.get('[data-testid="memory-document-drop-zone"]').classes()).toContain('block')
  })

  test('groups folder actions behind an ellipsis menu', async () => {
    const wrapper = mountSection()
    const archive = wrapper.get('[data-space-id="archive"]')
    expect(archive.find('[aria-label="Folder options"]').exists()).toBe(true)
    expect(archive.text()).not.toContain('Add subfolder')

    await archive.get('[aria-label="Folder options"]').trigger('click')
    const menu = document.body.querySelector('[data-testid="memory-folder-menu"]')
    expect(menu?.textContent).toContain('Add subfolder')
    expect(menu?.textContent).toContain('Rename')
    expect(menu?.textContent).toContain('Delete')

    const deleteButton = menu?.querySelector('[data-testid="delete-memory-folder"]') as HTMLButtonElement
    deleteButton.click()
    await nextTick()
    expect(wrapper.emitted('delete-folder')).toEqual([[spaces[1]]])
  })

  test('does not allow the Uncategorized folder to be renamed', async () => {
    const wrapper = mountSection()
    await wrapper.get('[data-space-id="uncategorized"] [aria-label="Folder options"]').trigger('click')

    const rename = document.body.querySelector('[data-testid="rename-memory-folder"]') as HTMLButtonElement | null
    expect(rename?.disabled).toBe(true)
    expect(rename?.title).toBe('The Uncategorized folder cannot be renamed')
  })

  test('opens a bottom folder menu above its trigger and outside the clipped sidebar', async () => {
    const wrapper = mountSection()
    const button = wrapper.get('[data-space-id="archive"] [aria-label="Folder options"]')
    button.element.getBoundingClientRect = () => ({
      top: 740, bottom: 764, left: 280, right: 304, width: 24, height: 24, x: 280, y: 740,
      toJSON: () => undefined,
    })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 })

    await button.trigger('click')

    const menu = document.body.querySelector('[data-testid="memory-folder-menu"]') as HTMLElement | null
    expect(menu?.parentElement).toBe(document.body)
    expect(menu?.style.bottom).toBe('32px')
    expect(menu?.style.top).toBe('')
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
