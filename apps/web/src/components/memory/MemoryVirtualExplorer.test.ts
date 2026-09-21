import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import MemoryVirtualExplorer from './MemoryVirtualExplorer.vue'

const mocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
  listDeleted: vi.fn(),
  listRevisions: vi.fn(),
  restoreRevision: vi.fn(),
  permanentlyDelete: vi.fn(),
  emptyTrash: vi.fn(),
  getFileContent: vi.fn(),
  getRevision: vi.fn(),
  getRevisionDiff: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: { memoryFolders: mocks },
}))

const folders = [
  { id: 'root', name: 'Memory', description: '', directoryPath: '/memory', folderPath: '', sortOrder: 0, isUncategorized: true, createdAt: 1, fileCount: 1 },
  { id: 'work', name: 'Work', description: '', directoryPath: '/memory/work', folderPath: 'work', sortOrder: 1, isUncategorized: false, createdAt: 1, fileCount: 1 },
]

const DataTableStub = defineComponent({
  name: 'DataTable',
  props: { items: { type: Array, default: () => [] } },
  template: '<div data-testid="table">{{ items.map(item => item.fileName).join(",") }}</div>',
})

const ModalStub = defineComponent({
  name: 'ModalDialog',
  props: { show: Boolean },
  template: '<div v-if="show"><slot/><slot name="actions"/></div>',
})

function file(fileName: string, modifiedAt: number) {
  return {
    fileName, extension: '.md', size: 10, modifiedAt, supported: true, textDirect: true,
    status: 'indexed', chunkCount: 1, deepResearched: false, analysisStatus: 'not_analyzed',
    analysisChunkLimit: 100, tags: [],
  }
}

describe('MemoryVirtualExplorer', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.listFiles.mockImplementation(async (folderId: string) => folderId === 'root'
      ? [file('older.md', 10)]
      : [file('newer.md', 20)])
    mocks.listDeleted.mockResolvedValue([])
    mocks.getFileContent.mockResolvedValue({ content: 'after', revision: 'hash', documentRef: 'newer#ref' })
    mocks.listRevisions.mockResolvedValue([
      { id: 'latest', revisionNumber: 2, contentHash: 'two', source: 'user', messageIds: [], createdAt: 20 },
      { id: 'previous', revisionNumber: 1, contentHash: 'one', source: 'filesystem', messageIds: [], createdAt: 10 },
    ])
    mocks.getRevisionDiff.mockResolvedValue({ segments: [
      { type: 'removed', text: 'before' },
      { type: 'added', text: 'after' },
    ] })
    mocks.getRevision.mockResolvedValue({ content: 'after' })
    mocks.permanentlyDelete.mockResolvedValue({ success: true })
  })

  test('lists every document newest first and opens its latest diff without leaving Recent', async () => {
    const wrapper = mount(MemoryVirtualExplorer, {
      props: { mode: 'recent', spaces: folders },
      global: { stubs: { Icon: true, DataTable: DataTableStub, ModalDialog: ModalStub } },
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="table"]').text()).toBe('newer.md,older.md')
    expect(mocks.listFiles).toHaveBeenCalledTimes(2)
    expect(wrapper.find('h2').exists()).toBe(false)
    expect(wrapper.get('nav[aria-label="Memory folder path"]').findAll('button').map(button => button.text()))
      .toEqual(['memory', 'Recent documents'])

    const table = wrapper.getComponent({ name: 'DataTable' })
    const rows = table.props('items') as Array<ReturnType<typeof file> & { folderId: string }>
    table.vm.$emit('row-click', rows[0], new MouseEvent('click'))
    await flushPromises()

    expect(mocks.getFileContent).toHaveBeenCalledWith('work', 'newer.md')
    expect(mocks.getRevisionDiff).toHaveBeenCalledWith('newer#ref', 'previous', 'latest')
    expect(wrapper.text()).toContain('before')
    expect(wrapper.text()).toContain('after')
    expect(wrapper.emitted('openDocument')).toBeUndefined()
  })

  test('offers restore and permanent delete actions for trash entries', async () => {
    mocks.listDeleted.mockResolvedValue([{
      documentRef: 'deleted#one', folderId: 'work', fileName: 'deleted.md', revision: 'hash', deletedAt: 20,
    }])
    const wrapper = mount(MemoryVirtualExplorer, {
      props: { mode: 'trash', spaces: folders },
      global: { stubs: { Icon: true, DataTable: DataTableStub, ModalDialog: ModalStub } },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Empty trash')
    expect(wrapper.get('[data-testid="table"]').text()).toContain('deleted.md')

    const table = wrapper.getComponent({ name: 'DataTable' })
    const rows = table.props('items') as Array<{ documentRef: string; fileName: string }>
    table.vm.$emit('row-click', rows[0], new MouseEvent('click'))
    await flushPromises()

    expect(mocks.listRevisions).toHaveBeenCalledWith('deleted#one')
    expect(mocks.getRevision).toHaveBeenCalledWith('deleted#one', 'latest')
    expect(wrapper.text()).toContain('after')
  })
})
