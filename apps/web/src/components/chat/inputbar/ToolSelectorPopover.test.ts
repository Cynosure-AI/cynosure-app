import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { h, nextTick } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../../api/client'
import { useAgentStore, type ToolInfo } from '../../../stores/agent-runtime.store'
import { useChatStore } from '../../../stores/chat.store'
import ToolSelectorPopover from './ToolSelectorPopover.vue'

const mocks = vi.hoisted(() => ({
  loadServers: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../composables/useMcpServers', async () => {
  const { ref } = await import('vue')
  return {
    useMcpServers: () => ({
      servers: ref([{ id: 'github', icon_url: '/github.png' }]),
      loadServers: mocks.loadServers,
    }),
  }
})

describe('ToolSelectorPopover', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    setActivePinia(createPinia())
    mocks.loadServers.mockClear()
    vi.spyOn(api.memoryFolders, 'list').mockResolvedValue([])
  })

  test('drills into namespace tools and toggles tools without a modal', async () => {
    const agentStore = useAgentStore()
    const chatStore = useChatStore()
    agentStore.availableTools = [
      tool('mcp:github::search', 'search', 'Search repositories'),
      tool('mcp:github::issues', 'issues', 'List issues'),
    ]

    const wrapper = mount(ToolSelectorPopover, {
      attachTo: document.body,
      slots: {
        trigger: ({ toggle }: { toggle: () => void }) => h('button', { 'data-test': 'trigger', onClick: toggle }, 'Tools'),
      },
      global: {
        stubs: {
          Icon: true,
          ToggleSwitch: true,
        },
      },
    })

    vi.spyOn(wrapper.get('span.inline-flex').element, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 500, 40, 30))

    await wrapper.get('[data-test="trigger"]').trigger('click')
    await flushPromises()

    expect(document.body.textContent).toContain('GitHub MCP')
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.querySelector('img[src="/github.png"]')).not.toBeNull()
    expect((document.body.querySelector('[aria-label="Tool access"]') as HTMLElement).style.maxHeight).toBe('484px')

    document.body.querySelector<HTMLButtonElement>('[aria-label="Open GitHub MCP tools"]')?.click()
    await nextTick()

    expect(document.body.textContent).toContain('Search repositories')
    const toolCheckboxes = document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(toolCheckboxes).toHaveLength(2)
    toolCheckboxes[0].click()
    await nextTick()
    expect(chatStore.selectedToolNames).toEqual(['mcp:github::search'])

    document.body.querySelector<HTMLButtonElement>('[aria-label="Back to MCP list"]')?.click()
    await nextTick()
    const groupCheckbox = document.body.querySelector<HTMLButtonElement>('[aria-label="Toggle all tools in GitHub MCP"]')
    groupCheckbox?.click()
    await nextTick()
    expect(chatStore.selectedToolNames).toEqual(['mcp:github::search', 'mcp:github::issues'])

    wrapper.unmount()
  })

  test('filters namespaces by a tool description', async () => {
    const agentStore = useAgentStore()
    agentStore.availableTools = [
      tool('mcp:github::search', 'search', 'Search repositories'),
      { ...tool('mcp:calendar::events', 'events', 'Upcoming meetings'), namespace: { id: 'mcp:calendar', label: 'Calendar MCP' } },
    ]

    const wrapper = mount(ToolSelectorPopover, {
      attachTo: document.body,
      slots: {
        trigger: ({ toggle }: { toggle: () => void }) => h('button', { 'data-test': 'trigger', onClick: toggle }, 'Tools'),
      },
      global: { stubs: { Icon: true, ToggleSwitch: true } },
    })

    await wrapper.get('[data-test="trigger"]').trigger('click')
    await nextTick()
    const search = document.body.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = 'meetings'
    search.dispatchEvent(new Event('input'))
    await nextTick()

    expect(document.body.textContent).toContain('Calendar MCP')
    expect(document.body.textContent).not.toContain('GitHub MCP')

    const menu = document.body.querySelector('[role="menu"]') as HTMLElement
    search.focus()
    menu.dispatchEvent(new MouseEvent('mouseleave'))
    await nextTick()
    expect(document.body.querySelector('[aria-label="Tool access"]')).not.toBeNull()

    await wrapper.get('[data-test="trigger"]').trigger('click')
    await nextTick()
    expect(document.body.querySelector('[aria-label="Tool access"]')).toBeNull()

    wrapper.unmount()
  })

  test('uses an in-place tool drill-down', async () => {
    const agentStore = useAgentStore()
    agentStore.availableTools = [
      tool('mcp:github::search', 'search', 'Search repositories'),
      tool('mcp:github::issues', 'issues', 'List issues'),
    ]

    const wrapper = mount(ToolSelectorPopover, {
      attachTo: document.body,
      slots: {
        trigger: ({ toggle }: { toggle: () => void }) => h('button', { 'data-test': 'trigger', onClick: toggle }, 'Tools'),
      },
      global: { stubs: { Icon: true, ToggleSwitch: true } },
    })

    await wrapper.get('[data-test="trigger"]').trigger('click')
    document.body.querySelector<HTMLButtonElement>('[aria-label="Open GitHub MCP tools"]')?.click()
    await nextTick()

    expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(2)
    expect(document.body.querySelector('[aria-label="Back to MCP list"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Search repositories')

    document.body.querySelector<HTMLButtonElement>('[aria-label="Back to MCP list"]')?.click()
    await nextTick()
    expect(document.body.querySelector('[aria-label="Search MCPs and tools"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Back to MCP list"]')).toBeNull()

    wrapper.unmount()
  })

  test('orders selected namespaces when opened without moving built-ins or reordering while open', async () => {
    const agentStore = useAgentStore()
    const chatStore = useChatStore()
    agentStore.availableTools = [
      namespacedTool('builtin:utility', 'Built-In', 'builtin:utility::read', 'read'),
      namespacedTool('mcp:calendar', 'Calendar MCP', 'mcp:calendar::events', 'events'),
      namespacedTool('mcp:github', 'GitHub MCP', 'mcp:github::search', 'search'),
      namespacedTool('mcp:linear', 'Linear MCP', 'mcp:linear::issues', 'issues'),
    ]

    const wrapper = mount(ToolSelectorPopover, {
      attachTo: document.body,
      slots: {
        trigger: ({ toggle }: { toggle: () => void }) => h('button', { 'data-test': 'trigger', onClick: toggle }, 'Tools'),
      },
      global: { stubs: { Icon: true, ToggleSwitch: true } },
    })

    await flushPromises()
    chatStore.setSelectedToolNames(['mcp:github::search'])
    await wrapper.get('[data-test="trigger"]').trigger('click')
    await nextTick()

    const namespaceLabels = () => [...document.body.querySelectorAll<HTMLButtonElement>('[aria-label^="Open "][aria-label$=" tools"]')]
      .map((element) => element.getAttribute('aria-label'))

    expect(namespaceLabels()).toEqual([
      'Open Built-In tools',
      'Open GitHub MCP tools',
      'Open Calendar MCP tools',
      'Open Linear MCP tools',
    ])

    document.body.querySelector<HTMLButtonElement>('[aria-label="Toggle all tools in Calendar MCP"]')?.click()
    await nextTick()
    expect(namespaceLabels()).toEqual([
      'Open Built-In tools',
      'Open GitHub MCP tools',
      'Open Calendar MCP tools',
      'Open Linear MCP tools',
    ])

    await wrapper.get('[data-test="trigger"]').trigger('click')
    await wrapper.get('[data-test="trigger"]').trigger('click')
    await nextTick()
    expect(namespaceLabels()).toEqual([
      'Open Built-In tools',
      'Open Calendar MCP tools',
      'Open GitHub MCP tools',
      'Open Linear MCP tools',
    ])

    wrapper.unmount()
  })
})

function tool(key: string, name: string, description: string): ToolInfo {
  return {
    key,
    name,
    executionName: name,
    description,
    parameters: {},
    autoApprove: false,
    usesDefaultApproval: true,
    namespace: { id: 'mcp:github', label: 'GitHub MCP' },
    ambiguous: false,
  }
}

function namespacedTool(namespaceId: string, namespaceLabel: string, key: string, name: string): ToolInfo {
  return {
    ...tool(key, name, `${name} description`),
    namespace: { id: namespaceId, label: namespaceLabel },
  }
}
