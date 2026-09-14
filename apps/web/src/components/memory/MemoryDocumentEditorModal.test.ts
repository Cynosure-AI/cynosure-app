import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import MemoryDocumentEditorModal from './MemoryDocumentEditorModal.vue'

const mocks = vi.hoisted(() => ({
  getFileContent: vi.fn(),
  updateFileContent: vi.fn(),
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
      updateFileContent: mocks.updateFileContent,
      renameFile: vi.fn(), listRevisions: vi.fn(), getRevision: vi.fn(),
      getRevisionDiff: vi.fn(), restoreRevision: vi.fn(),
    },
  },
}))

describe('MemoryDocumentEditorModal large document mode', () => {
  beforeEach(() => {
    mocks.getFileContent.mockReset()
    mocks.updateFileContent.mockReset().mockResolvedValue({
      fileName: 'large.md', revision: 'next', job: { id: 'job' },
    })
    mocks.setContent.mockReset()
    mocks.clearContent.mockReset()
  })

  test('loads and edits large content without constructing a rich-text document', async () => {
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

    const textarea = wrapper.get('textarea[aria-label="Large memory document content"]')
    expect((textarea.element as HTMLTextAreaElement).value).toBe(content)
    expect(wrapper.text()).toContain('Large document mode')
    expect(mocks.setContent).not.toHaveBeenCalled()

    await textarea.setValue(`${content}changed`)
    await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click')
    await flushPromises()
    expect(mocks.updateFileContent).toHaveBeenCalledWith('category', 'large.md', `${content}changed`, 'current')
  })
})
