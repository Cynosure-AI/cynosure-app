import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import McpBrowseTab from './McpBrowseTab.vue'

const apiMocks = vi.hoisted(() => ({
  searchRegistry: vi.fn(),
}))

vi.mock('../../../api/client', () => ({
  api: {
    mcp: {
      searchRegistry: apiMocks.searchRegistry,
      listServers: vi.fn().mockResolvedValue([]),
    },
  },
}))

function registryPage(name: string, nextCursor?: string) {
  return {
    servers: [{
      server: {
        name,
        title: name,
        description: `${name} description`,
        version: '1.0.0',
        packages: [],
      },
      _meta: {},
    }],
    metadata: { count: 1, nextCursor },
  }
}

describe('McpBrowseTab registry pagination', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    apiMocks.searchRegistry.mockImplementation(async (options: { registry?: string; search?: string; cursor?: string }) => {
      if (options.registry !== 'official' || options.search !== 'weather') return registryPage('Recommended')
      if (options.cursor === 'page-3') return registryPage('Weather page 3')
      if (options.cursor === 'page-2') return registryPage('Weather page 2', 'page-3')
      return registryPage('Weather page 1', 'page-2')
    })
  })

  test('moves through cursor-backed search pages and keeps the search on previous navigation', async () => {
    const wrapper = mount(McpBrowseTab, {
      global: { stubs: { Icon: true } },
    })
    await flushPromises()

    await wrapper.get('select').setValue('official')
    await flushPromises()
    await wrapper.get('input[placeholder="Search MCP servers..."]').setValue('weather')
    await new Promise(resolve => setTimeout(resolve, 450))
    await flushPromises()

    expect(wrapper.text()).toContain('Weather page 1')
    expect(wrapper.text()).toContain('Page 1')

    await wrapper.get('[aria-label="Next registry page"]').trigger('click')
    await flushPromises()
    expect(apiMocks.searchRegistry).toHaveBeenLastCalledWith(expect.objectContaining({
      registry: 'official', search: 'weather', cursor: 'page-2',
    }))
    expect(wrapper.text()).toContain('Weather page 2')
    expect(wrapper.text()).toContain('Page 2')

    await wrapper.get('[aria-label="Next registry page"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Weather page 3')
    expect(wrapper.get('[aria-label="Next registry page"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[aria-label="Previous registry page"]').trigger('click')
    await flushPromises()
    expect(apiMocks.searchRegistry).toHaveBeenLastCalledWith(expect.objectContaining({
      registry: 'official', search: 'weather', cursor: 'page-2',
    }))
    expect(wrapper.text()).toContain('Weather page 2')

    wrapper.unmount()
  })
})
