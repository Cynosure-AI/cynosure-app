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
    mocks.permanentlyDelete.mockResolvedValue({ success: true })
  })

  test('lists every document newest first and opens it in its source folder', async () => {
    const wrapper = mount(MemoryVirtualExplorer, {
      props: { mode: 'recent', spaces: folders },
      global: { stubs: { Icon: true, DataTable: DataTableStub, ModalDialog: ModalStub } },
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="table"]').text()).toBe('newer.md,older.md')
    expect(mocks.listFiles).toHaveBeenCalledTimes(2)
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
  })
})
