import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentDefinition, MemoryCategory } from '../../api/types'
import AgentMemoryTab from './AgentMemoryTab.vue'

const mocks = vi.hoisted(() => ({
  listSpaces: vi.fn(),
  push: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    memoryCategories: {
      list: mocks.listSpaces,
    },
  },
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mocks.push }),
}))

const spaces: MemoryCategory[] = [
  {
    id: 'uncategorized',
    name: 'Uncategorized',
    description: '',
    directoryPath: '/memory/default',
    categoryPath: '',
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
    categoryPath: 'research',
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
  memoryCategories: ['uncategorized'],
  autoMemory: false,
  dreamingEnabled: false,
} as AgentDefinition

describe('AgentMemoryTab', () => {
  test('Dreaming is opt-in per agent', async () => {
    const wrapper = mount(AgentMemoryTab, { props: { agent } })
    await flushPromises()

    const dreamingToggle = wrapper.findAll('[role="switch"]')[0]
    expect(dreamingToggle.attributes('aria-checked')).toBe('false')
    await dreamingToggle.trigger('click')
    expect(wrapper.emitted('update')).toContainEqual(['dreamingEnabled', true])
  })

  beforeEach(() => {
    mocks.listSpaces.mockReset().mockResolvedValue(spaces)
    mocks.push.mockReset()
  })

  test('shows retrieval settings and the ordinary memory category selector', async () => {
    const wrapper = mount(AgentMemoryTab, { props: { agent } })
    await flushPromises()

    const cardTitles = wrapper.findAll('h3').map(title => title.text())
    expect(cardTitles).toEqual([
      'Dreaming',
      'Automatic memory retrieval',
      'Memory Categories',
    ])
  })

  test('presents the root grant as All Memory and selects its indented descendants', async () => {
    const wrapper = mount(AgentMemoryTab, { props: { agent } })
    await flushPromises()

    const actions = wrapper.findAll('button')
    const deselectAll = actions.find(button => button.text().trim() === 'Deselect all')
    expect(wrapper.text()).toContain('All Memory')
    expect(wrapper.text()).toContain('Includes Uncategorized and every subcategory')
    expect(wrapper.text()).toContain('All memory selected')
    expect(actions.some(button => button.text().trim() === 'Select all')).toBe(false)
    expect(deselectAll).toBeDefined()

    const research = wrapper.get('[data-category-depth="1"]')
    expect(research.classes()).toContain('bg-accent-600/10')
    expect(research.get('[aria-hidden="true"]').attributes('style')).toContain('width: 12px')

    await deselectAll!.trigger('click')
    expect(wrapper.emitted('update')).toContainEqual(['memoryCategories', []])
  })
})
