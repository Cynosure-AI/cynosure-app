import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import McpInstalledTab from './McpInstalledTab.vue'

const mcp = vi.hoisted(() => ({
  addServer: vi.fn(),
  updateServer: vi.fn(),
  removeServer: vi.fn(),
  listServers: vi.fn(),
}))

vi.mock('../../../api/client', () => ({ api: { mcp } }))
vi.mock('../../../stores/agent-runtime.store', () => ({
  useAgentStore: () => ({ availableTools: [], loadTools: vi.fn().mockResolvedValue(undefined) }),
}))

function button(wrapper: ReturnType<typeof mount>, label: string) {
  const match = wrapper.findAll('button').find(candidate => candidate.text().trim() === label)
  if (!match) throw new Error(`Button ${label} not found`)
  return match
}

describe('McpInstalledTab manual add', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mcp.listServers.mockResolvedValue([])
  })

  test('offers automatic OAuth for remote servers and keeps bearer authentication optional', async () => {
    mcp.addServer.mockResolvedValue({ id: 'remote', connected: true })
    const wrapper = mount(McpInstalledTab, { global: { stubs: { Teleport: true, Icon: true } } })
    await button(wrapper, 'Add Manually').trigger('click')
    await button(wrapper, 'Remote').trigger('click')
    await wrapper.get('input[type="url"]').setValue('https://example.test/mcp')
    expect(wrapper.get('select').element.value).toBe('oauth')
    expect(wrapper.find('input[type="password"]').exists()).toBe(false)
    await button(wrapper, 'Save & Connect').trigger('click')
    await flushPromises()
    expect(mcp.addServer).toHaveBeenCalledWith(expect.objectContaining({
      command: 'remote', args: ['--transport', 'streamable-http', '--url', 'https://example.test/mcp'], env: undefined,
    }))
    wrapper.unmount()
  })

  test('sends an explicitly selected bearer token through an environment variable', async () => {
    mcp.addServer.mockResolvedValue({ id: 'remote', connected: true })
    const wrapper = mount(McpInstalledTab, { global: { stubs: { Teleport: true, Icon: true } } })
    await button(wrapper, 'Add Manually').trigger('click')
    await button(wrapper, 'Remote').trigger('click')
    await wrapper.get('input[type="url"]').setValue('https://example.test/mcp')
    await wrapper.get('select').setValue('bearer')
    await wrapper.get('input[type="password"]').setValue('secret-token')
    await button(wrapper, 'Save & Connect').trigger('click')
    await flushPromises()
    const config = mcp.addServer.mock.calls[0][0]
    expect(config.args[config.args.length - 1]).toMatch(/^--bearer-token-env=/)
    expect(Object.values(config.env)).toEqual(['secret-token'])
    expect(config.args.join(' ')).not.toContain('secret-token')
    wrapper.unmount()
  })

  test('retries a failed connection with the edited configuration without creating a duplicate', async () => {
    mcp.addServer.mockResolvedValue({ id: 'pending-server', connected: false, error: 'Connection refused' })
    mcp.updateServer.mockResolvedValue({ success: true, connected: true, toolCount: 2 })

    const wrapper = mount(McpInstalledTab, {
      global: { stubs: { Teleport: true, Icon: true } },
    })

    await button(wrapper, 'Add Manually').trigger('click')
    await wrapper.get('input[placeholder="npx"]').setValue('bad-command')
    await button(wrapper, 'Save & Connect').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Connection refused')
    expect(button(wrapper, 'Add Anyway').exists()).toBe(true)
    expect(button(wrapper, 'Cancel').exists()).toBe(true)

    await wrapper.get('input[placeholder="npx"]').setValue('working-command')
    await button(wrapper, 'Re-connect').trigger('click')
    await flushPromises()

    expect(mcp.addServer).toHaveBeenCalledTimes(1)
    expect(mcp.updateServer).toHaveBeenCalledWith('pending-server', expect.objectContaining({ command: 'working-command' }))
    expect(wrapper.text()).toContain('MCP connected successfully.')
    expect(wrapper.text()).not.toContain('Connection refused')
    expect(wrapper.findAll('button').some(candidate => candidate.text().trim() === 'Re-connect')).toBe(false)
    wrapper.unmount()
  })
})
