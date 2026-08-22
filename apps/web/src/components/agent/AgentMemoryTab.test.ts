import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentDefinition, MemorySpace } from '../../api/types'
import AgentMemoryTab from './AgentMemoryTab.vue'

const mocks = vi.hoisted(() => ({
  listSpaces: vi.fn(),
  createSpace: vi.fn(),
  push: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    memorySpaces: {
      list: mocks.listSpaces,
      create: mocks.createSpace,
    },
  },
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mocks.push }),
}))

const spaces: MemorySpace[] = [
  {
    id: 'default',
    name: 'Default',
    description: '',
    folderPath: '/memory/default',
    relativePath: '',
    sortOrder: 0,
    isDefault: true,
    createdAt: 1,
    fileCount: 2,
  },
  {
    id: 'research',
    name: 'Research',
    description: '',
    folderPath: '/memory/research',
    relativePath: 'research',
    sortOrder: 1,
    isDefault: false,
    createdAt: 1,
    fileCount: 3,
  },
]

const agent = {
  id: 'agent-1',
  name: 'Research Agent',
  internalName: 'research_agent',
  memorySpaces: ['default'],
  autoMemory: false,
} as AgentDefinition

describe('AgentMemoryTab', () => {
  beforeEach(() => {
    mocks.listSpaces.mockReset().mockResolvedValue(spaces)
    mocks.createSpace.mockReset()
    mocks.push.mockReset()
  })

  test('shows the agent memory space as its own card after automatic retrieval', async () => {
    const wrapper = mount(AgentMemoryTab, { props: { agent } })
    await flushPromises()

    const cardTitles = wrapper.findAll('h3').map(title => title.text())
    expect(cardTitles).toEqual([
      'Automatic memory retrieval',
      'Create Memory Space for Agent',
      'Memory Folders',
    ])
  })

  test('offers deselect all when only one folder is selected', async () => {
    const wrapper = mount(AgentMemoryTab, { props: { agent } })
    await flushPromises()

    const actions = wrapper.findAll('button')
    const deselectAll = actions.find(button => button.text().trim() === 'Deselect all')
    expect(actions.some(button => button.text().trim() === 'Select all')).toBe(true)
    expect(deselectAll).toBeDefined()

    await deselectAll!.trigger('click')
    expect(wrapper.emitted('update')).toContainEqual(['memorySpaces', []])
  })
})
