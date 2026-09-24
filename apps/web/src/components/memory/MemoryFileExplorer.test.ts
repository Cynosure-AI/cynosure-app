import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { defineComponent } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import MemoryFileExplorer from './MemoryFileExplorer.vue'
import type { MemoryIndexJob } from '../../api/types'

const mocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
  listJobs: vi.fn(),
  searchFiles: vi.fn(),
  startReindexFile: vi.fn(),
  ingestFile: vi.fn(),
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
      ingestFile: mocks.ingestFile,
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

const StatusColumnTableStub = {
  name: 'DataTable',
  props: { items: { type: Array, default: () => [] } },
  template: '<div><div v-for="item in items" :key="item.id"><slot name="col-deepResearched" :item="item" /><slot name="col-status" :item="item" /></div></div>',
}

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
    mocks.ingestFile.mockResolvedValue({ success: true, chunksStored: 0, fileName: 'Untitled.md' })
  })

  test('creates a named file in the current folder and opens the created file', async () => {
    mocks.ingestFile.mockResolvedValueOnce({ success: true, chunksStored: 0, fileName: 'Project (2).md' })
    const wrapper = mountList()
    await flushPromises()

    const newFileButton = wrapper.findAll('button').find((button) => button.text().trim() === 'New file')
    expect(newFileButton).toBeDefined()
    await newFileButton!.trigger('click')
    const nameInput = document.body.querySelector<HTMLInputElement>('#new-memory-file-name')!
    nameInput.value = 'Project'
    nameInput.dispatchEvent(new Event('input'))
    document.body.querySelector<HTMLFormElement>('[role="dialog"] form')!.requestSubmit()
    await flushPromises()

    expect(mocks.ingestFile).toHaveBeenCalledWith('category', 'Project.md', '')
    expect(wrapper.get('[data-testid="editor-state"]').text()).toBe('true:Project (2).md')
    expect(wrapper.emitted('spacesChanged')).toHaveLength(1)
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
    expect(wrapper.text()).not.toContain('1 selected')
    const settings = [...document.body.querySelectorAll('[data-memory-context-menu] button')]
      .find((button) => button.textContent?.includes('Folder settings')) as HTMLButtonElement
    settings.click()
    await flushPromises()
    expect(wrapper.emitted('editFolder')).toEqual([[child]])

    table.vm.$emit('row-contextmenu', rows[1], new MouseEvent('contextmenu', { clientX: 20, clientY: 20 }))
    await flushPromises()
    const documentMenu = document.body.querySelector('[data-memory-context-menu]') as HTMLElement
    expect(documentMenu.textContent).toContain('notes.md')
    expect(documentMenu.textContent).toContain('Open')
    expect(wrapper.text()).not.toContain('1 selected')
    wrapper.unmount()
  })

  test('summarizes recursive folder indexing in the Type / Searchable column', async () => {
    mocks.listFiles.mockResolvedValue([])
    const folder = {
      id: 'child', name: 'Projects', description: '', directoryPath: '/notes/projects',
      folderPath: 'notes/projects', parentFolderPath: 'notes', sortOrder: 0,
      isUncategorized: false, createdAt: 2, fileCount: 1, descendantFileCount: 3,
      indexedFileCount: 1, descendantIndexedFileCount: 1,
    }
    const wrapper = mount(MemoryFileExplorer, {
      props: {
        folderId: 'category',
        spaces: [{
          id: 'category', name: 'Notes', description: '', directoryPath: '/notes',
          folderPath: 'notes', sortOrder: 0, isUncategorized: false, createdAt: 1, fileCount: 0,
        }, folder],
      },
      global: {
        plugins: [createPinia()],
        stubs: {
          Icon: true, DataTable: StatusColumnTableStub, HoverTooltip: true, SplitButton: true,
          MemoryDocumentMoveDialog: true, MemoryDocumentEditorModal: EditorStub,
        },
      },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('2/4 Partially Indexed')

    await wrapper.setProps({
      spaces: [wrapper.props('spaces')[0], { ...folder, indexedFileCount: 1, descendantIndexedFileCount: 3 }],
    })
    expect(wrapper.text()).toContain('Indexed')

    await wrapper.setProps({
      spaces: [wrapper.props('spaces')[0], { ...folder, indexedFileCount: 0, descendantIndexedFileCount: 0 }],
    })
    expect(wrapper.text()).toContain('Not Indexed')
  })

  test('shows live indexing and Deep Research progress on document rows', async () => {
    mocks.listJobs.mockResolvedValue([
      {
        id: 'index-job', kind: 'reindex', folderId: 'category', fileName: 'notes.md',
        status: 'running', createdAt: 1, updatedAt: 2, attempt: 1, maxAttempts: 1,
      },
      {
        id: 'research-job', kind: 'deep-research', folderId: 'category', fileName: 'notes.md',
        status: 'running', progressCurrent: 4, progressTotal: 31,
        createdAt: 1, updatedAt: 2, attempt: 1, maxAttempts: 1,
      },
    ])
    const wrapper = mount(MemoryFileExplorer, {
      props: {
        folderId: 'category',
        spaces: [{
          id: 'category', name: 'Notes', description: '', directoryPath: '/notes',
          folderPath: 'notes', sortOrder: 0, isUncategorized: false, createdAt: 1, fileCount: 1,
        }],
      },
      global: {
        plugins: [createPinia()],
        stubs: {
          Icon: true, DataTable: StatusColumnTableStub, HoverTooltip: true, SplitButton: true,
          MemoryDocumentMoveDialog: true, MemoryDocumentEditorModal: EditorStub,
        },
      },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Indexing…')
    expect(wrapper.text()).toContain('Analysing (4 / 31)')
    const spinners = wrapper.findAll('icon-stub[icon="lucide:loader-2"]')
    expect(spinners).toHaveLength(2)
    expect(spinners.every((spinner) => spinner.classes().includes('animate-spin'))).toBe(true)
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

  test('disables editing and removal actions in the memory root', async () => {
    const root = {
      id: 'root', name: 'Memory', description: '', directoryPath: '/memory',
      folderPath: '', sortOrder: 0, isUncategorized: true, createdAt: 1, fileCount: 0,
    }
    const wrapper = mount(MemoryFileExplorer, {
      props: { folderId: 'root', spaces: [root] },
      global: {
        plugins: [createPinia()],
        stubs: {
          Icon: true, DataTable: true, HoverTooltip: true, SplitButton: true,
          MemoryDocumentMoveDialog: true, MemoryDocumentEditorModal: EditorStub,
        },
      },
    })
    await flushPromises()

    expect(wrapper.get('[aria-label="Memory root cannot be edited"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[aria-label="Uncategorized memory cannot be removed"]').attributes('disabled')).toBeDefined()
  })

  test('marks documents affected by a dream within the last 24 hours', async () => {
    localStorage.setItem('cy-memory-explorer-view', 'grid')
    mocks.listFiles.mockResolvedValue([
      {
        fileName: 'recent.md', extension: '.md', size: 12, modifiedAt: 2,
        supported: true, textDirect: true, status: 'indexed', chunkCount: 1,
        deepResearched: false, analysisStatus: 'not_analyzed', analysisChunkLimit: 100,
        tags: [], dreamedAt: Date.now() - 23 * 60 * 60 * 1000,
      },
      {
        fileName: 'old.md', extension: '.md', size: 12, modifiedAt: 1,
        supported: true, textDirect: true, status: 'indexed', chunkCount: 1,
        deepResearched: false, analysisStatus: 'not_analyzed', analysisChunkLimit: 100,
        tags: [], dreamedAt: Date.now() - 25 * 60 * 60 * 1000,
      },
    ])
    const wrapper = mountList()
    await flushPromises()

    const moon = wrapper.get('[aria-label="Updated by a dream within the last 24 hours"]')
    expect(moon.attributes('icon')).toBe('lucide:moon')
    expect(moon.element.parentElement?.textContent).toContain('recent.md')
    expect(moon.element.parentElement?.className).toContain('text-[#f4c072]')
    expect(wrapper.findAll('[aria-label="Updated by a dream within the last 24 hours"]')).toHaveLength(1)
  })

  test('does not mix Recent documents and Trash into the memory root contents', async () => {
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
    const rows = table.props('items') as Array<{ kind: string; name: string }>
    expect(rows.some(row => row.kind === 'virtual')).toBe(false)
    expect(wrapper.text()).not.toContain('Recent documents')
    expect(wrapper.text()).not.toContain('Trash')
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
    const groupValue = table.props('sortGroupValue') as (item: { kind: string }) => number
    expect(groupValue({ kind: 'folder' })).toBe(0)
    expect(groupValue({ kind: 'file' })).toBe(1)
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

  test('tracks selected folder indexing as nested jobs complete', async () => {
    const indexedFile = {
      fileName: 'indexed.md', extension: '.md', size: 12, modifiedAt: 1,
      supported: true, textDirect: true, status: 'indexed' as const, chunkCount: 1,
      deepResearched: false, analysisStatus: 'not_analyzed' as const, tags: [],
    }
    const pendingFiles = ['first.md', 'second.md'].map((fileName) => ({
      ...indexedFile, fileName, status: 'not_indexed' as const, chunkCount: 0,
    }))
    const jobs = pendingFiles.map((file, index) => ({
      id: `job-${index}`, kind: 'reindex' as const, folderId: 'child', fileName: file.fileName,
      status: 'queued' as const, createdAt: 1, updatedAt: 1, attempt: 1, maxAttempts: 1,
    }))
    let latestJobs: MemoryIndexJob[] = [...jobs]
    mocks.listFiles.mockImplementation((folderId: string) => Promise.resolve(folderId === 'child' ? [indexedFile, ...pendingFiles] : []))
    mocks.listJobs.mockImplementation((folderId: string) => Promise.resolve(folderId === 'child' ? latestJobs : []))
    mocks.startReindexFile.mockImplementation((_folderId: string, fileName: string) =>
      Promise.resolve(jobs.find((job) => job.fileName === fileName)))
    const parent = {
      id: 'category', name: 'Notes', description: '', directoryPath: '/notes',
      folderPath: 'notes', sortOrder: 0, isUncategorized: false, createdAt: 1, fileCount: 0,
    }
    const child = {
      ...parent, id: 'child', name: 'Projects', directoryPath: '/notes/projects',
      folderPath: 'notes/projects', parentFolderPath: 'notes', fileCount: 3, indexedFileCount: 1,
    }
    const wrapper = mount(MemoryFileExplorer, {
      props: { folderId: 'category', spaces: [parent, child] },
      global: {
        plugins: [createPinia()],
        stubs: {
          Icon: true, DataTable: StatusColumnTableStub, HoverTooltip: true, SplitButton: true,
          MemoryDocumentMoveDialog: true, MemoryDocumentEditorModal: EditorStub,
        },
      },
    })
    await flushPromises()
    await wrapper.get('[aria-label="Grid view"]').trigger('click')
    await wrapper.get('input[aria-label="Select Projects"]').trigger('click')
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await wrapper.findAll('button').find((button) => button.text().trim() === 'Index files')?.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="memory-explorer-grid"]').text()).toContain('1/3 Partially Indexed · Indexing…')
    await wrapper.get('[aria-label="List view"]').trigger('click')
    expect(wrapper.text()).toContain('1/3 Partially Indexed · Indexing…')

    try {
      latestJobs = [{ ...jobs[0], status: 'completed' }, jobs[1]]
      await vi.advanceTimersByTimeAsync(2000)
      expect(wrapper.text()).toContain('2/3 Partially Indexed · Indexing…')
      expect(wrapper.emitted('spacesChanged')).toHaveLength(1)

      latestJobs = jobs.map((job) => ({ ...job, status: 'completed' as const }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(wrapper.text()).toContain('Indexed')
      expect(wrapper.emitted('spacesChanged')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
      wrapper.unmount()
    }
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
