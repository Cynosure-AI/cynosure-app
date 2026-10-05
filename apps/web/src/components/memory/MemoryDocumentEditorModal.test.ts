import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import MemoryDocumentEditorModal from './MemoryDocumentEditorModal.vue'

const mocks = vi.hoisted(() => ({
  getFileContent: vi.fn(),
  updateFileContent: vi.fn(),
  getDocumentChunks: vi.fn(),
  listRevisions: vi.fn(),
  setContent: vi.fn(),
  clearContent: vi.fn(),
}))

vi.mock('@tiptap/vue-3', async () => {
  const { defineComponent, h, ref: vueRef } = await import('vue')
  const chain = { focus: () => chain, toggleBold: () => chain, toggleItalic: () => chain, toggleStrike: () => chain, toggleCode: () => chain, toggleHeading: () => chain, toggleBulletList: () => chain, toggleOrderedList: () => chain, toggleBlockquote: () => chain, toggleCodeBlock: () => chain, unsetLink: () => chain, setLink: () => chain, run: () => true }
  return {
    EditorContent: defineComponent({ setup: () => () => h('div', { 'data-testid': 'rich-editor' }) }),
    useEditor: () => vueRef({
      commands: { setContent: mocks.setContent, clearContent: mocks.clearContent },
      getHTML: () => '', getAttributes: () => ({}), isActive: () => false,
      chain: () => chain, destroy: () => undefined,
      state: {
        doc: {
          descendants: (callback: (node: { isText: boolean; text: string }, pos: number) => void) =>
            callback({ isText: true, text: 'Memory First chunk Second chunk' }, 1),
        },
      },
      view: { coordsAtPos: (pos: number) => ({ top: pos * 2 }) },
      on: () => undefined,
      off: () => undefined,
    }),
  }
})

vi.mock('../../api/client', () => ({
  api: {
    memoryFolders: {
      getFileContent: mocks.getFileContent,
      getDocumentChunks: mocks.getDocumentChunks,
      updateFileContent: mocks.updateFileContent,
      renameFile: vi.fn(), listRevisions: mocks.listRevisions, getRevision: vi.fn(),
      getRevisionDiff: vi.fn(), restoreRevision: vi.fn(),
    },
  },
}))

describe('MemoryDocumentEditorModal', () => {
  beforeEach(() => {
    mocks.getFileContent.mockReset()
    mocks.updateFileContent.mockReset().mockResolvedValue({
      fileName: 'large.md', revision: 'next',
    })
    mocks.setContent.mockReset()
    mocks.clearContent.mockReset()
    mocks.getDocumentChunks.mockReset().mockResolvedValue({ chunks: [] })
    mocks.listRevisions.mockReset().mockResolvedValue([])
  })

  test('loads large content into the rich-text editor', async () => {
    const content = `# Large\n${'memory line\n'.repeat(25_000)}`
    mocks.getFileContent.mockResolvedValue({ content, revision: 'current', documentRef: 'large#ref' })
    const wrapper = mount(MemoryDocumentEditorModal, {
      props: { show: true, folderId: 'category', sourceFile: 'large.md' },
      global: {
        plugins: [createPinia()],
        stubs: {
          ModalDialog: { template: '<div><slot/><slot name="actions"/></div>' },
          Icon: true,
        },
      },
    })
    await flushPromises()
    await vi.waitFor(() => expect(mocks.setContent).toHaveBeenCalledOnce())

    expect(wrapper.find('[data-testid="rich-editor"]').exists()).toBe(true)
    expect((wrapper.get('input[aria-label="Document name"]').element as HTMLInputElement).value).toBe('large')
    expect(wrapper.text()).not.toContain('large.md')
    expect(wrapper.find('textarea[aria-label="Large memory document content"]').exists()).toBe(false)
  })

  test('marks the indexed chunk boundaries in the editor', async () => {
    mocks.getFileContent.mockResolvedValue({ content: '# Memory\nFirst chunk\n\nSecond chunk', revision: 'current', documentRef: 'memory#ref' })
    mocks.getDocumentChunks.mockResolvedValue({
      chunks: [
        { chunkIndex: 0, text: 'First chunk' },
        { chunkIndex: 1, text: 'Second chunk' },
      ],
    })
    const wrapper = mount(MemoryDocumentEditorModal, {
      props: { show: true, folderId: 'category', sourceFile: 'memory.md' },
      global: {
        plugins: [createPinia()],
        stubs: { ModalDialog: { template: '<div><slot/><slot name="actions"/></div>' }, Icon: true },
      },
    })
    await flushPromises()
    await vi.waitFor(() => expect(mocks.getDocumentChunks).toHaveBeenCalledWith('category', 'memory.md'))
    await flushPromises()

    expect(wrapper.get('[aria-label="Chunk 1 start"]').text()).toContain('Chunk 1')
    expect(wrapper.get('[aria-label="Chunk 2 boundary"]').text()).toContain('Chunk 2')
  })

  test('toggles the revision history view', async () => {
    mocks.getFileContent.mockResolvedValue({ content: '# Memory\nText', revision: 'current', documentRef: 'memory#ref' })
    const wrapper = mount(MemoryDocumentEditorModal, {
      props: { show: true, folderId: 'category', sourceFile: 'memory.md' },
      global: {
        plugins: [createPinia()],
        stubs: { ModalDialog: { template: '<div><slot/><slot name="actions"/></div>' }, Icon: true },
      },
    })
    await flushPromises()

    await vi.waitFor(() => expect(wrapper.get('[title="Revision history"]').attributes('disabled')).toBeUndefined())
    await wrapper.get('[title="Revision history"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="rich-editor"]').exists()).toBe(false)

    await wrapper.get('[title="Revision history"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="rich-editor"]').exists()).toBe(true)
  })
})
