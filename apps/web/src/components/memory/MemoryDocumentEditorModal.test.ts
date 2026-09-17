import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import MemoryDocumentEditorModal from './MemoryDocumentEditorModal.vue'

const mocks = vi.hoisted(() => ({
  getFileContent: vi.fn(),
  updateFileContent: vi.fn(),
  getDocumentAnalysis: vi.fn(),
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
      getDocumentAnalysis: mocks.getDocumentAnalysis,
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
    mocks.getDocumentAnalysis.mockReset().mockResolvedValue({ status: 'not_analyzed', chunks: [], items: [], itemTotal: 0 })
    mocks.listRevisions.mockReset().mockResolvedValue([])
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
    expect(wrapper.get('[title="Extracted facts and entities"]').classes()).not.toContain('bg-accent-500/15')
    expect(wrapper.get('[aria-label="Document analysis"]').classes()).toContain('hidden')
  })

  test('renders ordered summaries, tags, and extracted knowledge in the analysis rail', async () => {
    mocks.getFileContent.mockResolvedValue({ content: '# Memory\nText', revision: 'current', documentRef: 'memory#ref' })
    mocks.getDocumentAnalysis.mockResolvedValue({
      status: 'current',
      chunks: [
        { chunkIndex: 0, text: 'First chunk', sectionPath: 'First', summary: 'The first summary.', tags: ['alpha'] },
        { chunkIndex: 1, text: 'Second chunk', sectionPath: 'Second', summary: 'The second summary.', tags: ['beta'] },
      ],
      items: [{
        kind: 'relationship', label: 'Atlas -> uses -> TypeScript', relation: 'uses', entity: 'TypeScript', subject: 'Atlas',
        reasoning: 'The document explicitly says Atlas uses TypeScript.', chunkIndex: 1, importance: 2,
      }],
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

    expect(wrapper.text()).toContain('uses')
    expect(wrapper.text()).toContain('TypeScript')
    expect(wrapper.text()).toContain('Atlas')
    expect(wrapper.get('[title="Extracted facts and entities"]').text()).toContain('Facts')
    expect(wrapper.get('[title="Extracted facts and entities"]').classes()).toContain('bg-accent-500/15')
    expect(wrapper.get('[aria-label="Document analysis"]').classes()).toContain('flex')
    expect(wrapper.text()).not.toContain('The first summary.')
    const firstChunk = wrapper.get('[aria-label="Chunk 1 start"]')
    firstChunk.element.parentElement?.dispatchEvent(new MouseEvent('mouseenter', { clientX: 100, clientY: 100 }))
    await flushPromises()
    expect(document.body.querySelector('[aria-label="Summary for chunk 1"]')?.textContent).toContain('The first summary.')
    const boundary = wrapper.get('[aria-label="Chunk 2 boundary"]')
    boundary.element.parentElement?.dispatchEvent(new MouseEvent('mouseenter', { clientX: 100, clientY: 100 }))
    await flushPromises()
    expect(document.body.querySelector('[aria-label="Summary for chunk 2"]')?.textContent).toContain('The second summary.')
    expect(document.body.querySelector('[aria-label="Summary for chunk 2"]')?.textContent).toContain('beta')

    const knowledge = wrapper.get('[aria-label="Document analysis"] span.font-mono')
    knowledge.element.closest('div.flex')?.parentElement?.dispatchEvent(new MouseEvent('mouseenter', { clientX: 100, clientY: 100 }))
    await flushPromises()
    expect(document.body.querySelector('[aria-label="Reasoning for Atlas -> uses -> TypeScript"]')?.textContent)
      .toContain('The document explicitly says Atlas uses TypeScript.')
  })

  test('renders chunk markers without hover details when the document is only searchable', async () => {
    mocks.getFileContent.mockResolvedValue({ content: '# Memory\nFirst chunk\n\nSecond chunk', revision: 'current', documentRef: 'memory#ref' })
    mocks.getDocumentAnalysis.mockResolvedValue({
      status: 'searchable',
      chunks: [
        { chunkIndex: 0, text: 'First chunk', sectionPath: '', summary: '', tags: [] },
        { chunkIndex: 1, text: 'Second chunk', sectionPath: '', summary: '', tags: [] },
      ],
      items: [],
      itemTotal: 0,
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

    expect(wrapper.get('[aria-label="Chunk 1 start"]').text()).toContain('Chunk 1')
    const marker = wrapper.get('[aria-label="Chunk 1 start"]')
    marker.element.parentElement?.dispatchEvent(new MouseEvent('mouseenter', { clientX: 100, clientY: 100 }))
    await flushPromises()
    expect(document.body.querySelector('[aria-label="Summary for chunk 1"]')).toBeNull()
  })

  test('switches History and Facts as mutually exclusive toggle views', async () => {
    mocks.getFileContent.mockResolvedValue({ content: '# Memory\nText', revision: 'current', documentRef: 'memory#ref' })
    const wrapper = mount(MemoryDocumentEditorModal, {
      props: { show: true, categoryId: 'category', sourceFile: 'memory.md' },
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

    await wrapper.get('[title="Extracted facts and entities"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="rich-editor"]').exists()).toBe(true)
    expect(wrapper.get('[title="Extracted facts and entities"]').classes()).toContain('bg-accent-500/15')
    expect(wrapper.get('[aria-label="Document analysis"]').classes()).toContain('flex')

    await wrapper.get('[title="Extracted facts and entities"]').trigger('click')
    expect(wrapper.get('[title="Extracted facts and entities"]').classes()).not.toContain('bg-accent-500/15')
    expect(wrapper.get('[aria-label="Document analysis"]').classes()).toContain('hidden')
  })
})
