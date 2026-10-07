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

  function transport(wrapper: ReturnType<typeof mount>, label: string) {
    const match = wrapper.findAll('.mcp-transport-option').find(candidate => candidate.text().startsWith(label))
    if (!match) throw new Error(`Transport ${label} not found`)
    return match
  }

  test('adds a remote HTTP server without headers so OAuth can be discovered', async () => {
    mcp.addServer.mockResolvedValue({ id: 'remote', connected: true })
    const wrapper = mount(McpInstalledTab, { global: { stubs: { Teleport: true, Icon: true } } })
    await button(wrapper, 'Add Manually').trigger('click')
    await transport(wrapper, 'HTTP (remote)').trigger('click')
    await wrapper.get('input[type="url"]').setValue('https://example.test/mcp')
    await button(wrapper, 'Save & Connect').trigger('click')
    await flushPromises()
    expect(mcp.addServer).toHaveBeenCalledWith(expect.objectContaining({
      command: 'remote', args: ['--transport', 'streamable-http', '--url', 'https://example.test/mcp'], env: undefined,
    }))
    wrapper.unmount()
  })

  test('stores header values in env so secrets stay out of the displayed args', async () => {
    mcp.addServer.mockResolvedValue({ id: 'remote', connected: true })
    const wrapper = mount(McpInstalledTab, { global: { stubs: { Teleport: true, Icon: true } } })
    await button(wrapper, 'Add Manually').trigger('click')
    await transport(wrapper, 'SSE (remote, legacy)').trigger('click')
    await wrapper.get('input[type="url"]').setValue('https://wp.test/sse')
    await wrapper.get('textarea[placeholder^="Authorization"]').setValue('Authorization: Basic c2VjcmV0\nX-Tenant: team')
    await button(wrapper, 'Save & Connect').trigger('click')
    await flushPromises()
    const config = mcp.addServer.mock.calls[0][0]
    expect(config.args).toEqual([
      '--transport', 'sse', '--url', 'https://wp.test/sse',
      '--header-env=Authorization=MCP_WP_TEST_AUTHORIZATION',
      '--header-env=X-Tenant=MCP_WP_TEST_X_TENANT',
    ])
    expect(config.env).toEqual({ MCP_WP_TEST_AUTHORIZATION: 'Basic c2VjcmV0', MCP_WP_TEST_X_TENANT: 'team' })
    expect(config.args.join(' ')).not.toContain('c2VjcmV0')
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
