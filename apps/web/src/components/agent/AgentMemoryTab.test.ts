import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentDefinition, MemoryFolder } from '../../api/types'
import AgentMemoryTab from './AgentMemoryTab.vue'

const mocks = vi.hoisted(() => ({
  listSpaces: vi.fn(),
  push: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    memoryFolders: {
      list: mocks.listSpaces,
    },
  },
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mocks.push }),
}))

const spaces: MemoryFolder[] = [
  {
    id: 'uncategorized',
    name: 'Uncategorized',
    description: '',
    directoryPath: '/memory/default',
    folderPath: '',
    sortOrder: 0,
    isUncategorized: true,
    createdAt: 1,
    fileCount: 2,
  },
  {
    id: 'research',
    name: 'Research',
    description: '',
    directoryPath: '/memory/research',
    folderPath: 'research',
    sortOrder: 1,
    isUncategorized: false,
    createdAt: 1,
    fileCount: 3,
  },
]

const agent = {
  id: 'agent-1',
  name: 'Research Agent',
  internalName: 'research_agent',
  memoryFolders: ['uncategorized'],
  autoMemory: false,
  dreamingEnabled: true,
} as AgentDefinition

describe('AgentMemoryTab', () => {
  test('Dreaming is opt-out per agent', async () => {
    const wrapper = mount(AgentMemoryTab, { props: { agent } })
    await flushPromises()

    const dreamingToggle = wrapper.findAll('[role="switch"]')[0]
    expect(dreamingToggle.attributes('aria-checked')).toBe('true')
    await dreamingToggle.trigger('click')
    expect(wrapper.emitted('update')).toContainEqual(['dreamingEnabled', false])
  })

  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.listSpaces.mockReset().mockResolvedValue(spaces)
    mocks.push.mockReset()
  })

  test('shows retrieval settings and the ordinary memory folder selector', async () => {
    const wrapper = mount(AgentMemoryTab, { props: { agent } })
    await flushPromises()

    const cardTitles = wrapper.findAll('h3').map(title => title.text())
    expect(cardTitles).toEqual([
      'Dreaming',
      'Automatic memory retrieval',
      'Memory Folders',
    ])
  })

  test('presents the root grant as All Memory and its descendants as included', async () => {
    const wrapper = mount(AgentMemoryTab, { props: { agent } })
    await flushPromises()

    const actions = wrapper.findAll('button')
    const clear = actions.find(button => button.text().trim() === 'Clear')
    expect(wrapper.text()).toContain('All Memory')
    expect(wrapper.text()).toContain('Every folder, including new ones')
    expect(wrapper.text()).toContain('All folders readable')
    expect(actions.some(button => button.text().trim() === 'Select all')).toBe(false)
    expect(clear).toBeDefined()

    const research = wrapper.get('[data-folder-id="research"]')
    expect(research.attributes('data-state')).toBe('inherited')
    expect(research.text()).toContain('Included via All Memory')
    expect(research.find('[data-tree-guide="elbow"]').exists()).toBe(true)

    await clear!.trigger('click')
    expect(wrapper.emitted('update')).toContainEqual(['memoryFolders', []])
  })

  test('names missing assigned folders and removes only those assignments', async () => {
    const wrapper = mount(AgentMemoryTab, {
      props: { agent: { ...agent, memoryFolders: ['uncategorized', 'deleted-folder'] } },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('1 assigned memory folder unavailable')
    expect(wrapper.text()).toContain('deleted-folder')
    await wrapper.findAll('button').find(button => button.text().trim() === 'Remove unavailable folders')!.trigger('click')
    expect(wrapper.emitted('update')).toContainEqual(['memoryFolders', ['uncategorized']])
  })
})
