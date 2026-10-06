import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import OnboardingPopularMcps from './OnboardingPopularMcps.vue'

const mocks = vi.hoisted(() => ({ searchRegistry: vi.fn(), addServer: vi.fn(), loadServers: vi.fn() }))
const servers = ref<{ args: string[] }[]>([])

vi.mock('../../api/client', () => ({ api: { mcp: mocks } }))
vi.mock('../../composables/useMcpServers', () => ({
  useMcpServers: () => ({ servers, loadServers: mocks.loadServers }),
}))

describe('onboarding recommended MCPs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    servers.value = []
    mocks.searchRegistry.mockResolvedValue({ servers: [
      { server: { name: 'exa', title: 'Exa Search', icons: [{ src: '/exa.png' }],
        remotes: [{ type: 'streamable-http', url: 'https://mcp.exa.ai/mcp' }] } },
      { server: { name: 'chrome-devtools-mcp', title: 'Chrome DevTools', icons: [{ src: '/chrome.svg' }],
        packages: [{ registryType: 'npm', identifier: 'chrome-devtools-mcp@latest', transport: { type: 'stdio' } }] } },
    ] })
    mocks.addServer.mockResolvedValue({})
  })

  test('shows registry icons, falls back on image errors and saves the icon when installing', async () => {
    const wrapper = mount(OnboardingPopularMcps, { global: { stubs: { Icon: true } } })
    await flushPromises()
    expect(wrapper.findAll('img').map(img => img.attributes('src'))).toEqual(['/exa.png', '/chrome.svg'])
    await wrapper.get('img[src="/chrome.svg"]').trigger('error')
    expect(wrapper.find('img[src="/chrome.svg"]').exists()).toBe(false)
    await wrapper.findAll('button')[1].trigger('click')
    await flushPromises()
    expect(mocks.addServer).toHaveBeenCalledWith(expect.objectContaining({
      command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], icon_url: '/chrome.svg', origin: 'npm',
    }))
    wrapper.unmount()
  })

  test('installs Exa using its remote endpoint', async () => {
    const wrapper = mount(OnboardingPopularMcps, { global: { stubs: { Icon: true } } })
    await flushPromises()
    await wrapper.findAll('button')[0].trigger('click')
    await flushPromises()
    expect(mocks.addServer).toHaveBeenCalledWith(expect.objectContaining({
      originalName: 'Exa Search', command: 'remote',
      args: ['--transport', 'streamable-http', '--url', 'https://mcp.exa.ai/mcp'],
      icon_url: '/exa.png', origin: 'recommended:remote',
    }))
    expect(wrapper.text()).toContain('Installed')
    wrapper.unmount()
  })

  test('recognizes an already installed remote server', async () => {
    servers.value = [{ args: ['--transport', 'streamable-http', '--url', 'https://mcp.exa.ai/mcp'] }]
    const wrapper = mount(OnboardingPopularMcps, { global: { stubs: { Icon: true } } })
    await flushPromises()
    expect(wrapper.text()).toContain('Installed')
    expect(wrapper.findAll('button')).toHaveLength(1)
    wrapper.unmount()
  })
})
