import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import MemoryDocumentEditorModal from './MemoryDocumentEditorModal.vue'

const mocks = vi.hoisted(() => ({
  getFileContent: vi.fn(),
  updateFileContent: vi.fn(),
  getDocumentAnalysis: vi.fn(),
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
    }),
  }
})

vi.mock('../../api/client', () => ({
  api: {
    memoryFolders: {
      getFileContent: mocks.getFileContent,
      getDocumentAnalysis: mocks.getDocumentAnalysis,
      updateFileContent: mocks.updateFileContent,
      renameFile: vi.fn(), listRevisions: vi.fn(), getRevision: vi.fn(),
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
    mocks.getDocumentAnalysis.mockReset().mockResolvedValue({ status: 'not_analyzed', chunks: [], items: [], itemTotal: 0 })
  })

  test('loads large content into the rich-text editor', async () => {
    const content = `# Large\n${'memory line\n'.repeat(25_000)}`
    mocks.getFileContent.mockResolvedValue({ content, revision: 'current', documentRef: 'large#ref' })
    const wrapper = mount(MemoryDocumentEditorModal, {
      props: { show: true, categoryId: 'category', sourceFile: 'large.md' },
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
    expect(wrapper.find('textarea[aria-label="Large memory document content"]').exists()).toBe(false)
  })

  test('renders ordered summaries, tags, and extracted knowledge in the analysis rail', async () => {
    mocks.getFileContent.mockResolvedValue({ content: '# Memory\nText', revision: 'current', documentRef: 'memory#ref' })
    mocks.getDocumentAnalysis.mockResolvedValue({
      status: 'current',
      chunks: [
        { chunkIndex: 0, sectionPath: 'First', summary: 'The first summary.', tags: ['alpha'] },
        { chunkIndex: 1, sectionPath: 'Second', summary: 'The second summary.', tags: ['beta'] },
      ],
      items: [{ kind: 'relationship', label: 'Atlas uses TypeScript', chunkIndex: 1, importance: 2 }],
      itemTotal: 1,
    })
    const wrapper = mount(MemoryDocumentEditorModal, {
      props: { show: true, categoryId: 'category', sourceFile: 'memory.md' },
      global: {
        plugins: [createPinia()],
        stubs: { ModalDialog: { template: '<div><slot/><slot name="actions"/></div>' }, Icon: true },
      },
    })
    await flushPromises()
    await vi.waitFor(() => expect(mocks.getDocumentAnalysis).toHaveBeenCalledOnce())
    await flushPromises()

    expect(wrapper.text()).toContain('The first summary.')
    expect(wrapper.text()).toContain('The second summary.')
    expect(wrapper.text()).toContain('alpha')
    expect(wrapper.text()).toContain('Atlas uses TypeScript')
  })
})
