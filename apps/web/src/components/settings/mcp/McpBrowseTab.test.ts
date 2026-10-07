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

    await wrapper.get('[data-source="official"]').trigger('click')
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

  test('presents registry sources and servers as a storefront', async () => {
    const wrapper = mount(McpBrowseTab, {
      global: { stubs: { Icon: true } },
    })
    await flushPromises()

    expect(wrapper.get('[aria-label="MCP server marketplace"]').element.tagName).toBe('SECTION')
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(3)
    expect(wrapper.text()).not.toContain('Supercharge your workflow')
    expect(wrapper.text()).toContain('Browse by category')
    expect(wrapper.text()).toContain('Recommended description')
    expect(apiMocks.searchRegistry).toHaveBeenCalledWith(expect.objectContaining({ registry: 'recommended' }))

    await wrapper.get('[data-source="smithery"]').trigger('click')
    await flushPromises()
    expect(apiMocks.searchRegistry).toHaveBeenLastCalledWith(expect.objectContaining({ registry: 'smithery', limit: 12 }))

    wrapper.unmount()
  })

  test('tries another icon after a failure and shows fallbacks in the card and details', async () => {
    const page = registryPage('Sentry')
    apiMocks.searchRegistry.mockResolvedValue({
      ...page,
      servers: [{
        ...page.servers[0],
        server: {
          ...page.servers[0].server,
          icons: [{ src: 'https://sentry.io/favicon.ico' }, { src: 'https://github.com/getsentry.png' }],
        },
      }],
    })
    const wrapper = mount(McpBrowseTab, {
      global: { stubs: { Icon: true } },
    })
    await flushPromises()

    await wrapper.get('article img').trigger('error')
    expect(wrapper.get('article img').attributes('src')).toBe('https://github.com/getsentry.png')

    await wrapper.get('article [aria-label="Show server details"]').trigger('click')
    const modal = wrapper.get('.fixed')
    expect(modal.get('img').attributes('src')).toBe('https://github.com/getsentry.png')
    await modal.get('img').trigger('error')

    expect(wrapper.find('article img').exists()).toBe(false)
    expect(wrapper.find('article icon-stub[icon="lucide:package"]').exists()).toBe(true)
    expect(modal.find('img').exists()).toBe(false)
    expect(modal.find('icon-stub[icon="lucide:box"]').exists()).toBe(true)

    wrapper.unmount()
  })
})
