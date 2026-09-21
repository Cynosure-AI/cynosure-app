import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { defineComponent } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import MemoryFileExplorer from './MemoryFileExplorer.vue'

const mocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
  listJobs: vi.fn(),
  searchFiles: vi.fn(),
  startReindexFile: vi.fn(),
  updateFolder: vi.fn(),
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
      update: mocks.updateFolder,
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
  return mount(MemoryFileExplorer, {
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

describe('MemoryFileExplorer navigation and search', () => {
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
    mocks.updateFolder.mockResolvedValue({})
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
    const wrapper = mount(MemoryFileExplorer, {
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
    const grid = wrapper.get('[data-testid="memory-explorer-grid"]')
    expect(grid.text()).toContain('Projects')
    expect(localStorage.getItem('cy-memory-explorer-view')).toBe('grid')
    const folderCheckbox = grid.get('input[aria-label="Select Projects"]')
    await folderCheckbox.trigger('click')
    expect(wrapper.text()).toContain('1 selected')
    await folderCheckbox.trigger('click')
    await wrapper.get('[aria-label="List view"]').trigger('click')

    const table = wrapper.getComponent({ name: 'DataTable' })
    const rows = table.props('items') as Array<{ kind: string; folder?: typeof child }>
    expect(rows.map((row) => row.kind)).toEqual(['folder', 'file'])
    table.vm.$emit('row-click', rows[0], new MouseEvent('click'))
    await flushPromises()
    expect(wrapper.emitted('navigateFolder')).toEqual([['child']])

    table.vm.$emit('row-contextmenu', rows[0], new MouseEvent('contextmenu', { clientX: 20, clientY: 20 }))
    await flushPromises()
    const settings = [...document.body.querySelectorAll('[data-memory-context-menu] button')]
      .find((button) => button.textContent?.includes('Folder settings')) as HTMLButtonElement
    settings.click()
    await flushPromises()
    expect(wrapper.emitted('editFolder')).toEqual([[child]])
    wrapper.unmount()
  })

  test('shows only navigable memory-root breadcrumbs while copying the absolute path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const root = {
      id: 'root', name: 'Memory', description: '', directoryPath: '/home/user/Cynosure/memory',
      folderPath: '', sortOrder: 0, isUncategorized: true, createdAt: 1, fileCount: 0,
    }
    const child = {
      id: 'child', name: 'Projects', description: '', directoryPath: '/home/user/Cynosure/memory/Projects',
      folderPath: 'Projects', parentFolderPath: null, sortOrder: 0,
      isUncategorized: false, createdAt: 2, fileCount: 0,
    }
    const wrapper = mount(MemoryFileExplorer, {
      props: { folderId: 'child', spaces: [root, child] },
      global: {
        plugins: [createPinia()],
        stubs: {
          Icon: true, DataTable: true, HoverTooltip: true, SplitButton: true,
          MemoryDocumentMoveDialog: true, MemoryDocumentEditorModal: EditorStub,
        },
      },
    })
    await flushPromises()

    const breadcrumbs = wrapper.get('nav[aria-label="Memory folder path"]')
    expect(breadcrumbs.text()).toContain('memory')
    expect(breadcrumbs.text()).toContain('Projects')
    expect(breadcrumbs.text()).not.toContain('home')
    expect(breadcrumbs.text()).not.toContain('user')
    expect(breadcrumbs.text()).not.toContain('Cynosure')

    await breadcrumbs.get('[aria-label="Copy current folder path"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith('/home/user/Cynosure/memory/Projects')

    await wrapper.get('[aria-label="Go to memory root"]').trigger('click')
    expect(wrapper.emitted('navigateFolder')).toContainEqual(['root'])
  })

  test('shows Recent documents and Trash as virtual folders at the memory root', async () => {
    const wrapper = mount(MemoryFileExplorer, {
      props: {
        folderId: 'root',
        spaces: [{
          id: 'root', name: 'Memory', description: '', directoryPath: '/memory',
          folderPath: '', sortOrder: 0, isUncategorized: true, createdAt: 1, fileCount: 1,
        }],
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

    const table = wrapper.getComponent({ name: 'DataTable' })
    const rows = table.props('items') as Array<{ kind: string; name: string; virtualView?: string }>
    expect(rows.slice(0, 2)).toMatchObject([
      { kind: 'virtual', name: 'Recent documents', virtualView: 'recent' },
      { kind: 'virtual', name: 'Trash', virtualView: 'trash' },
    ])
    table.vm.$emit('row-click', rows[0], new MouseEvent('click'))
    await flushPromises()
    expect(wrapper.emitted('selectView')).toEqual([['recent']])
  })

  test('opens grid documents on item click and selects only through checkboxes with shift ranges', async () => {
    mocks.listFiles.mockResolvedValue([
      {
        fileName: 'bravo.md', extension: '.md', size: 12, modifiedAt: 1,
        supported: true, textDirect: true, status: 'indexed', chunkCount: 1,
        deepResearched: false, analysisStatus: 'not_analyzed', analysisChunkLimit: 100, tags: [],
      },
      {
        fileName: 'alpha.md', extension: '.md', size: 12, modifiedAt: 2,
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

    await wrapper.get('[aria-label="List view"]').trigger('click')
    const table = wrapper.getComponent({ name: 'DataTable' })
    expect(table.props('initialSortKey')).toBe('modifiedAt')
    expect(table.props('initialSortDirection')).toBe('desc')
  })

  test('applies indexing recursively to files inside a selected folder', async () => {
    const currentFile = {
      fileName: 'notes.md', extension: '.md', size: 12, modifiedAt: 1,
      supported: true, textDirect: true, status: 'indexed' as const, chunkCount: 1,
      deepResearched: false, analysisStatus: 'not_analyzed' as const, analysisChunkLimit: 100, tags: [],
    }
    const nestedFile = {
      fileName: 'nested.md', extension: '.md', size: 12, modifiedAt: 2,
      supported: true, textDirect: true, status: 'not_indexed' as const, estimatedChunkCount: 1,
      deepResearched: false, analysisStatus: 'not_analyzed' as const, analysisChunkLimit: 100, tags: [],
    }
    mocks.listFiles.mockImplementation((folderId: string) => Promise.resolve(folderId === 'child' ? [nestedFile] : [currentFile]))
    const child = {
      id: 'child', name: 'Projects', description: '', directoryPath: '/notes/projects',
      folderPath: 'notes/projects', parentFolderPath: 'notes', sortOrder: 0,
      isUncategorized: false, createdAt: 2, fileCount: 1,
    }
    const wrapper = mount(MemoryFileExplorer, {
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
    await wrapper.get('input[aria-label="Select Projects"]').trigger('click')
    const indexButton = wrapper.findAll('button').find((button) => button.text().trim() === 'Index files')
    await indexButton?.trigger('click')
    await flushPromises()

    expect(mocks.startReindexFile).toHaveBeenCalledWith('child', 'nested.md')
  })

  test('moves a selected folder as a folder and preserves its hierarchy', async () => {
    const current = {
      id: 'category', name: 'Notes', description: '', directoryPath: '/notes',
      folderPath: 'notes', sortOrder: 0, isUncategorized: false, createdAt: 1, fileCount: 1,
    }
    const child = {
      ...current, id: 'child', name: 'Projects', directoryPath: '/notes/projects',
      folderPath: 'notes/projects', parentFolderPath: 'notes', fileCount: 0,
    }
    const target = {
      ...current, id: 'target', name: 'Archive', directoryPath: '/archive',
      folderPath: 'archive', parentFolderPath: null, fileCount: 0,
    }
    const wrapper = mount(MemoryFileExplorer, {
      props: { folderId: 'category', spaces: [current, child, target] },
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
    await wrapper.get('input[aria-label="Select Projects"]').trigger('click')
    const moveButton = wrapper.findAll('button').find((button) => button.text().trim() === 'Move')
    await moveButton?.trigger('click')
    wrapper.getComponent({ name: 'MemoryDocumentMoveDialog' }).vm.$emit('move', 'target')
    await flushPromises()

    expect(mocks.updateFolder).toHaveBeenCalledWith('child', { folderPath: 'archive/Projects' })
  })
})
