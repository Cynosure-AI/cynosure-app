import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import ChatOptionsMenu from './ChatOptionsMenu.vue'

const chatStore = reactive({
  activeAgentId: null as string | null,
  agentOverrideFields: [] as string[],
  freeChatOverrideFields: [] as string[],
  sessionAutoToolRouting: false,
  sessionAutoMemory: false,
  sessionThinkingEnabled: false,
  sessionReasoningEffort: 'medium',
  sessionSystemPrompt: '',
  selectedToolNames: [] as string[],
  freeChatMemoryFolderIds: [] as string[],
  freeChatSubAgentIds: [] as string[],
  memoryFolders: [] as unknown[],
  freeChatMemorySelectionInitialized: false,
  markOverridesModified: vi.fn(),
  loadMemoryFolders: vi.fn().mockResolvedValue(undefined),
  setSelectedToolNames: vi.fn((names: string[]) => { chatStore.selectedToolNames = names }),
  setSessionReasoningEffort: vi.fn(),
})
const agentStore = reactive({ availableTools: [] as unknown[] })
const agentDefs = reactive({ agents: [] as unknown[] })

vi.mock('../../../stores/chat.store', () => ({ useChatStore: () => chatStore }))
vi.mock('../../../stores/agent-runtime.store', () => ({ useAgentStore: () => agentStore }))
vi.mock('../../../stores/agent-definitions.store', () => ({ useAgentDefinitionsStore: () => agentDefs }))
vi.mock('../../../composables/useMcpServers', () => ({
  useMcpServers: () => ({
    servers: { value: [{ id: 'docs', icon_url: '/docs-icon.png' }] },
    loadServers: vi.fn().mockResolvedValue(undefined),
  }),
}))

describe('ChatOptionsMenu', () => {
  beforeEach(() => {
    chatStore.activeAgentId = null
    chatStore.agentOverrideFields = []
    chatStore.freeChatOverrideFields = []
    chatStore.sessionAutoToolRouting = false
    chatStore.sessionAutoMemory = false
    chatStore.selectedToolNames = []
    agentStore.availableTools = []
    chatStore.markOverridesModified.mockClear()
  })

  test.each([
    { agentId: 'agent-1', field: 'Tools', label: 'Tools (MCPs)' },
    { agentId: null, field: 'Memory folders', label: 'Memories' },
    { agentId: 'agent-1', field: 'Reasoning effort', label: 'Reasoning' },
    { agentId: 'agent-1', field: 'System prompt', label: 'System Prompt' },
    { agentId: null, field: 'Automatic memory', label: 'Automatic Memories' },
    { agentId: null, field: 'Automatic tool routing', label: 'Automatic Tools' },
  ])('colors the $label icon and label when $field differs from the preset', async ({ agentId, field, label }) => {
    chatStore.activeAgentId = agentId
    if (agentId) chatStore.agentOverrideFields = [field]
    else chatStore.freeChatOverrideFields = [field]
    const wrapper = mount(ChatOptionsMenu, {
      attachTo: document.body,
      global: { stubs: { SystemPromptModal: true, Icon: { template: '<i />' } } },
    })
    await wrapper.get('[aria-label="Add and configure chat options"]').trigger('click')
    await flushPromises()

    const menu = document.querySelector('[aria-label="Chat options"]') as HTMLElement
    const button = [...menu.querySelectorAll('button')].find(item => item.textContent?.trim().startsWith(label))!
    expect(button.querySelectorAll('.text-accent-fg')).toHaveLength(2)
    wrapper.unmount()
  })

  test('opens the file submenu without a main-menu filter', async () => {
    const wrapper = mount(ChatOptionsMenu, {
      attachTo: document.body,
      global: { stubs: { SystemPromptModal: true } },
    })
    await wrapper.get('[aria-label="Add and configure chat options"]').trigger('click')
    await flushPromises()

    const menu = document.querySelector('[aria-label="Chat options"]') as HTMLElement
    expect(menu.querySelector('input[type="search"]')).toBeNull()
    expect(menu.textContent).toContain('Files')
    expect(menu.textContent).toContain('Subagents')
    const files = [...menu.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Files')!
    files.click()
    await flushPromises()
    expect(menu.textContent).toContain('Upload files')

    const upload = [...menu.querySelectorAll('button')].find(button => button.textContent?.includes('Choose files from your device'))!
    upload.click()
    await flushPromises()
    expect(wrapper.emitted('attach')).toHaveLength(1)
    expect(document.querySelector('[aria-label="Chat options"]')).toBeNull()
    wrapper.unmount()
  })

  test('toggles automatic tools without closing the menu', async () => {
    const wrapper = mount(ChatOptionsMenu, {
      attachTo: document.body,
      global: { stubs: { SystemPromptModal: true } },
    })
    await wrapper.get('[aria-label="Add and configure chat options"]').trigger('click')
    await flushPromises()
    const toggle = document.querySelector('[aria-label="Automatic tools"]') as HTMLButtonElement
    toggle.click()
    await flushPromises()

    expect(chatStore.sessionAutoToolRouting).toBe(true)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(chatStore.markOverridesModified).toHaveBeenCalledOnce()
    expect(document.querySelector('[aria-label="Chat options"]')).not.toBeNull()
    wrapper.unmount()
  })

  test('selects an entire MCP namespace and opens its searchable tool list', async () => {
    agentStore.availableTools = [
      { key: 'search-key', name: 'Search', description: 'Find documents', namespace: { id: 'mcp:docs', label: 'Documents' } },
      { key: 'write-key', name: 'Write', description: 'Create documents', namespace: { id: 'mcp:docs', label: 'Documents' } },
    ]
    const wrapper = mount(ChatOptionsMenu, {
      attachTo: document.body,
      global: { stubs: { SystemPromptModal: true } },
    })
    await wrapper.get('[aria-label="Add and configure chat options"]').trigger('click')
    await flushPromises()
    const menu = document.querySelector('[aria-label="Chat options"]') as HTMLElement
    ;([...menu.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Tools (MCPs)') as HTMLButtonElement).click()
    await flushPromises()
    expect(menu.querySelector('img[src="/docs-icon.png"]')).not.toBeNull()
    ;(menu.querySelector('[aria-label="Select all tools in Documents"]') as HTMLButtonElement).click()
    expect(chatStore.selectedToolNames).toEqual(['search-key', 'write-key'])
    ;(menu.querySelector('[aria-label="Open Documents tools"]') as HTMLButtonElement).click()
    await flushPromises()

    const filter = menu.querySelector('[aria-label="Search tools"]') as HTMLInputElement
    filter.value = 'find'
    filter.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(menu.textContent).toContain('Search')
    ;(menu.querySelector('input[type="checkbox"]') as HTMLInputElement).click()
    await flushPromises()
    expect(chatStore.selectedToolNames).toEqual(['write-key'])
    wrapper.unmount()
  })
})
