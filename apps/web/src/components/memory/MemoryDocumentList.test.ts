import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { defineComponent } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import MemoryDocumentList from './MemoryDocumentList.vue'

const mocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
  listJobs: vi.fn(),
  searchFiles: vi.fn(),
  startReindexFile: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    memory: {
      onGraphReset: () => () => undefined,
      onDreamUpdated: () => () => undefined,
    },
    memoryFolders: {
      listFiles: mocks.listFiles,
      listJobs: mocks.listJobs,
      searchFiles: mocks.searchFiles,
      startReindexFile: mocks.startReindexFile,
    },
  },
}))

const EditorStub = defineComponent({
  name: 'MemoryDocumentEditorModal',
  props: {
    show: Boolean,
    sourceFile: { type: String, default: '' },
  },
  template: '<div data-testid="editor-state">{{ show }}:{{ sourceFile }}</div>',
})

function mountList(focusFile?: string) {
  return mount(MemoryDocumentList, {
    props: {
      folderId: 'category',
      spaces: [{
        id: 'category', name: 'Notes', description: '', directoryPath: '/notes',
        folderPath: 'notes', sortOrder: 0, isUncategorized: false, createdAt: 1, fileCount: 1,
      }],
      focusFile,
    },
    global: {
      plugins: [createPinia()],
      stubs: {
        Icon: true,
        DataTable: true,
        HoverTooltip: true,
        SplitButton: true,
        MemoryDocumentMoveDialog: true,
        MemoryDocumentEditorModal: EditorStub,
      },
    },
  })
}

describe('MemoryDocumentList navigation and search', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.listFiles.mockResolvedValue([{
      fileName: 'notes.md', extension: '.md', size: 12, modifiedAt: 1,
      supported: true, textDirect: true, status: 'indexed', chunkCount: 1,
      deepResearched: false, analysisStatus: 'not_analyzed', analysisChunkLimit: 100, tags: [],
    }])
    mocks.listJobs.mockResolvedValue([])
    mocks.searchFiles.mockResolvedValue([])
    mocks.startReindexFile.mockResolvedValue({
      id: 'job-1', kind: 'reindex', folderId: 'category', fileName: 'notes.md',
      status: 'queued', progressCurrent: 0, progressTotal: 0, createdAt: 1, updatedAt: 1,
    })
  })

  test('opens a linked document while leaving the always-visible search empty', async () => {
    const wrapper = mountList('notes.md')
    await flushPromises()

    expect(wrapper.get('[data-testid="editor-state"]').text()).toBe('true:notes.md')
    expect((wrapper.get('input[placeholder="Search this folder and subfolders…"]').element as HTMLInputElement).value).toBe('')
    expect(mocks.searchFiles).not.toHaveBeenCalled()
  })

  test('shows a clear button only for a query and restores the unfiltered list', async () => {
    const wrapper = mountList()
    await flushPromises()
    const input = wrapper.get('input[placeholder="Search this folder and subfolders…"]')

    expect(wrapper.find('[aria-label="Clear document search"]').exists()).toBe(false)
    await input.setValue('notes')
    expect(wrapper.find('[aria-label="Clear document search"]').exists()).toBe(true)

    await wrapper.get('[aria-label="Clear document search"]').trigger('click')
    expect((input.element as HTMLInputElement).value).toBe('')
    expect(wrapper.find('[aria-label="Clear document search"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('1 file')
  })

  test('reruns the current query as semantic search when the toggle is enabled', async () => {
    const wrapper = mountList()
    await flushPromises()
    const toggle = wrapper.get('[aria-label="Toggle semantic search"]')

    expect(toggle.attributes('aria-pressed')).toBe('false')
    await toggle.trigger('click')
    await wrapper.get('input[placeholder="Search this folder and subfolders…"]').setValue('deployment guidance')
    await new Promise((resolve) => window.setTimeout(resolve, 250))
    await flushPromises()

    expect(toggle.attributes('aria-pressed')).toBe('true')
    expect(mocks.searchFiles).toHaveBeenLastCalledWith('deployment guidance', {
      folderId: 'category',
      semantic: true,
    })
  })

  test('warns before indexing a file estimated above 100 chunks and proceeds after confirmation', async () => {
    mocks.listFiles.mockResolvedValue([{
      fileName: 'notes.md', extension: '.md', size: 12, modifiedAt: 1,
      supported: true, textDirect: true, status: 'not_indexed', estimatedChunkCount: 101,
      deepResearched: false, analysisStatus: 'not_analyzed', analysisChunkLimit: 100, tags: [],
    }])
    const wrapper = mountList()
    await flushPromises()

    await wrapper.get('button[title="Indexing files makes them available for semantic searching."]').trigger('click')
    await flushPromises()

    expect(document.body.textContent).toContain('estimated to produce 101 chunks')
    expect(mocks.startReindexFile).not.toHaveBeenCalled()

    const confirm = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Index anyway') as HTMLButtonElement
    confirm.click()
    await flushPromises()

    expect(mocks.startReindexFile).toHaveBeenCalledWith('category', 'notes.md')
  })

  test('indexes without warning at the 100 chunk threshold', async () => {
    mocks.listFiles.mockResolvedValue([{
      fileName: 'notes.md', extension: '.md', size: 12, modifiedAt: 1,
      supported: true, textDirect: true, status: 'not_indexed', estimatedChunkCount: 100,
      deepResearched: false, analysisStatus: 'not_analyzed', analysisChunkLimit: 100, tags: [],
    }])
    const wrapper = mountList()
    await flushPromises()

    await wrapper.get('button[title="Indexing files makes them available for semantic searching."]').trigger('click')
    await flushPromises()

    expect(document.body.textContent).not.toContain('Index a large document?')
    expect(mocks.startReindexFile).toHaveBeenCalledWith('category', 'notes.md')
  })

  test('shows immediate subfolders in the explorer and opens them on click', async () => {
    const child = {
      id: 'child', name: 'Projects', description: '', directoryPath: '/notes/projects',
      folderPath: 'notes/projects', parentFolderPath: 'notes', sortOrder: 0,
      isUncategorized: false, createdAt: 2, fileCount: 3,
    }
    const wrapper = mount(MemoryDocumentList, {
      props: {
        folderId: 'category',
        spaces: [{
          id: 'category', name: 'Notes', description: '', directoryPath: '/notes',
          folderPath: 'notes', sortOrder: 0, isUncategorized: false, createdAt: 1, fileCount: 1,
        }, child],
      },
      global: {
        plugins: [createPinia()],
        stubs: {
          Icon: true, DataTable: true, HoverTooltip: true, SplitButton: true,
          MemoryDocumentMoveDialog: true, MemoryDocumentEditorModal: EditorStub,
        },
      },
    })
    await flushPromises()

    await wrapper.get('[aria-label="Grid view"]').trigger('click')
    expect(wrapper.get('[data-testid="memory-explorer-grid"]').text()).toContain('Projects')
    expect(localStorage.getItem('cy-memory-explorer-view')).toBe('grid')
    await wrapper.get('[aria-label="List view"]').trigger('click')

    const folderRow = wrapper.get('[data-testid="memory-explorer-folders"] button')
    expect(folderRow.text()).toContain('Projects')
    await folderRow.trigger('click')
    expect(wrapper.emitted('navigateFolder')).toEqual([['child']])

    await folderRow.trigger('contextmenu', { clientX: 20, clientY: 20 })
    const settings = [...document.body.querySelectorAll('[data-memory-context-menu] button')]
      .find((button) => button.textContent?.includes('Folder settings')) as HTMLButtonElement
    settings.click()
    await flushPromises()
    expect(wrapper.emitted('editFolder')).toEqual([[child]])
    wrapper.unmount()
  })

  test('opens grid documents on item click and selects only through checkboxes with shift ranges', async () => {
    mocks.listFiles.mockResolvedValue([
      {
        fileName: 'alpha.md', extension: '.md', size: 12, modifiedAt: 2,
        supported: true, textDirect: true, status: 'indexed', chunkCount: 1,
        deepResearched: false, analysisStatus: 'not_analyzed', analysisChunkLimit: 100, tags: [],
      },
      {
        fileName: 'bravo.md', extension: '.md', size: 12, modifiedAt: 1,
        supported: true, textDirect: true, status: 'indexed', chunkCount: 1,
        deepResearched: false, analysisStatus: 'not_analyzed', analysisChunkLimit: 100, tags: [],
      },
    ])
    const wrapper = mountList()
    await flushPromises()
    await wrapper.get('[aria-label="Grid view"]').trigger('click')

    const cards = wrapper.findAll('[data-testid="memory-explorer-grid"] [role="button"]')
    await cards[0].trigger('click')
    expect(wrapper.get('[data-testid="editor-state"]').text()).toBe('true:alpha.md')
    expect(wrapper.text()).not.toContain('1 selected')

    const checkboxes = wrapper.findAll('[data-testid="memory-explorer-grid"] input[type="checkbox"]')
    await checkboxes[0].trigger('click')
    await checkboxes[1].trigger('click', { shiftKey: true })
    expect(wrapper.text()).toContain('2 selected')
  })
})
