import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { describe, expect, test } from 'vitest'
import type { MemorySpace } from '../../api/types'
import MemoryDocumentsSection from './MemoryDocumentsSection.vue'

const DOCUMENT_DRAG_MIME = 'application/x-cynosure-memory-documents'

const spaces: MemorySpace[] = [
  {
    id: 'default',
    name: 'Default',
    description: '',
    folderPath: '/memory',
    relativePath: '',
    sortOrder: 0,
    isDefault: true,
    createdAt: 1,
    fileCount: 1,
  },
  {
    id: 'archive',
    name: 'Archive',
    description: '',
    folderPath: '/memory/archive',
    relativePath: 'archive',
    sortOrder: 1,
    isDefault: false,
    createdAt: 1,
    fileCount: 0,
  },
]

const MemoryDocumentListStub = defineComponent({
  name: 'MemoryDocumentList',
  setup(_, { expose }) {
    expose({ ingestFiles: () => undefined, moveGroupsToSpace: () => undefined })
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

function mountSection() {
  return mount(MemoryDocumentsSection, {
    props: {
      spaces,
      spacesLoading: false,
      selectedSpaceId: 'default',
      selectedSpace: spaces[0],
    },
    global: {
      stubs: { MemoryDocumentList: MemoryDocumentListStub },
    },
  })
}

describe('MemoryDocumentsSection drag targets', () => {
  test('shows the upload treatment only for file drags over the document pane', async () => {
    const wrapper = mountSection()
    const dropZone = wrapper.get('[data-testid="memory-document-drop-zone"]')

    dropZone.element.dispatchEvent(dragEvent('dragenter', ['Files']))
    await nextTick()
    expect(dropZone.text()).toContain('Drop files into Default')

    dropZone.element.dispatchEvent(dragEvent('dragleave', ['Files']))
    dropZone.element.dispatchEvent(dragEvent('dragenter', [DOCUMENT_DRAG_MIME]))
    await nextTick()
    expect(dropZone.text()).not.toContain('Drop files into Default')
  })

  test('excludes the source folder while allowing another folder as a move target', async () => {
    const wrapper = mountSection()
    const selectedFolder = wrapper.get('[data-space-id="default"]')
    const archiveFolder = wrapper.get('[data-space-id="archive"]')

    selectedFolder.element.dispatchEvent(dragEvent('dragenter', [DOCUMENT_DRAG_MIME]))
    await nextTick()
    expect(selectedFolder.classes()).not.toContain('ring-1')

    archiveFolder.element.dispatchEvent(dragEvent('dragenter', [DOCUMENT_DRAG_MIME]))
    await nextTick()
    expect(archiveFolder.classes()).toContain('ring-1')
  })
})
