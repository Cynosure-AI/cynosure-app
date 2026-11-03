import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import MemoryFilePickerModal from './MemoryFilePickerModal.vue'
import type { MemoryFileSearchResult, MemoryFolder } from '../../../api/types'

const mocks = vi.hoisted(() => ({
  listRecentFiles: vi.fn(),
  searchFiles: vi.fn(),
  readAttachment: vi.fn(),
}))

vi.mock('../../../api/client', () => ({
  api: { memoryFolders: mocks },
}))

function file(fileName: string, overrides: Partial<MemoryFileSearchResult> = {}): MemoryFileSearchResult {
  return {
    fileName,
    extension: '.md',
    size: 120,
    modifiedAt: Date.now(),
    supported: true,
    textDirect: true,
    status: 'indexed',
    folderId: 'folder-a',
    folderName: 'Notes',
    folderPath: 'Notes',
    matchedFields: [],
    ...overrides,
  }
}

const folders = [
  { id: 'root', name: 'All Memory', isUncategorized: true },
  { id: 'folder-a', name: 'Notes', isUncategorized: false, depth: 0 },
] as MemoryFolder[]

function mountModal(alreadySelectedIds: string[] = []) {
  return mount(MemoryFilePickerModal, {
    props: { show: false, folders, alreadySelectedIds },
    global: {
      stubs: {
        Icon: true,
        ModalDialog: { template: '<div><slot /><slot name="actions" /></div>' },
      },
    },
  })
}

function rowButton(wrapper: ReturnType<typeof mountModal>, name: string) {
  return wrapper.findAll('ul button').find(button => button.text().includes(name))!
}

describe('MemoryFilePickerModal', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.clearAllMocks()
    mocks.listRecentFiles.mockResolvedValue([file('recent.md'), file('attached.md')])
    mocks.searchFiles.mockResolvedValue([file('roadmap.md', { folderId: 'folder-b', folderPath: 'Projects' })])
    mocks.readAttachment.mockImplementation(async (_folderId: string, fileName: string) => ({ kind: 'file', name: fileName, content: `# ${fileName}` }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('opens on recent files and marks files already in the draft', async () => {
    const wrapper = mountModal(['memory:folder-a/attached.md'])
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(mocks.listRecentFiles).toHaveBeenCalledWith({ folderId: undefined, limit: 40 })
    expect(wrapper.text()).toContain('Recently changed')
    expect(rowButton(wrapper, 'recent.md').attributes('disabled')).toBeUndefined()
    expect(rowButton(wrapper, 'attached.md').attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('option').map(option => option.text())).toEqual(['All memories', 'Notes'])
  })

  test('searches by name, then by contents, scoped to the chosen folder', async () => {
    const wrapper = mountModal()
    await wrapper.setProps({ show: true })
    await flushPromises()

    await wrapper.get('input[type="search"]').setValue('road')
    vi.runAllTimers()
    await flushPromises()
    expect(mocks.searchFiles).toHaveBeenLastCalledWith('road', { folderId: undefined, semantic: false })
    expect(wrapper.text()).toContain('roadmap.md')

    await wrapper.get('select').setValue('folder-a')
    await wrapper.get('[role="switch"]').trigger('click')
    await flushPromises()
    expect(mocks.searchFiles).toHaveBeenLastCalledWith('road', { folderId: 'folder-a', semantic: true })
  })

  test('attaches the selected files with memory source ids', async () => {
    const wrapper = mountModal()
    await wrapper.setProps({ show: true })
    await flushPromises()

    await rowButton(wrapper, 'recent.md').trigger('click')
    await rowButton(wrapper, 'attached.md').trigger('click')
    expect(wrapper.text()).toContain('2 selected')
    await wrapper.findAll('button').find(button => button.text() === 'Attach 2 files')!.trigger('click')
    await flushPromises()

    expect(mocks.readAttachment).toHaveBeenCalledWith('folder-a', 'recent.md')
    expect(wrapper.emitted('add')?.[0]?.[0]).toEqual([
      { kind: 'file', name: 'recent.md', content: '# recent.md', sourceId: 'memory:folder-a/recent.md' },
      { kind: 'file', name: 'attached.md', content: '# attached.md', sourceId: 'memory:folder-a/attached.md' },
    ])
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  test('keeps failed files selected and reports why', async () => {
    mocks.readAttachment.mockImplementation(async (_folderId: string, fileName: string) => {
      if (fileName === 'attached.md') throw new Error('Binary files cannot be attached.')
      return { kind: 'file', name: fileName, content: 'ok' }
    })
    const wrapper = mountModal()
    await wrapper.setProps({ show: true })
    await flushPromises()

    await rowButton(wrapper, 'recent.md').trigger('click')
    await rowButton(wrapper, 'attached.md').trigger('click')
    await wrapper.findAll('button').find(button => button.text() === 'Attach 2 files')!.trigger('click')
    await flushPromises()

    expect(wrapper.emitted('add')?.[0]?.[0]).toHaveLength(1)
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.get('[role="alert"]').text()).toContain('attached.md: Binary files cannot be attached.')
    expect(wrapper.text()).toContain('1 selected')
  })
})
