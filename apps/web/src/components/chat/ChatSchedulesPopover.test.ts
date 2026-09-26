import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ChatSchedulesPopover from './ChatSchedulesPopover.vue'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  chatStore: { activeAgentId: null as string | null },
}))

vi.mock('../../api/client', () => ({ api: { cronJobs: { list: mocks.list } } }))
vi.mock('../../stores/chat.store', () => ({ useChatStore: () => mocks.chatStore }))

const job = (id: string, agentId: string, enabled: boolean) => ({
  id, agentId, enabled, name: id, prompt: `Task ${id}`, schedule: '0 9 * * *',
  nextRunAt: enabled ? Date.now() + 60_000 : null,
})

describe('ChatSchedulesPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.chatStore.activeAgentId = null
    mocks.list.mockResolvedValue([job('Disabled', '', false), job('Other agent', 'agent-1', true), job('Enabled', '', true)])
  })

  it('shows only the current chat schedules with disabled jobs last', async () => {
    const wrapper = mount(ChatSchedulesPopover, { global: { stubs: { Icon: true } } })
    await vi.waitFor(() => expect(wrapper.find('[aria-label="Schedules"]').exists()).toBe(true))
    await wrapper.get('button[aria-label="Schedules"]').trigger('click')
    const text = wrapper.get('[role="dialog"]').text()
    expect(text).toContain('Enabled')
    expect(text).toContain('Disabled')
    expect(text).not.toContain('Other agent')
    expect(text.indexOf('Enabled')).toBeLessThan(text.indexOf('Disabled'))
    wrapper.unmount()
  })

  it('hides the header button when this agent has no schedules', async () => {
    mocks.chatStore.activeAgentId = 'agent-2'
    const wrapper = mount(ChatSchedulesPopover, { global: { stubs: { Icon: true } } })
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalled())
    expect(wrapper.find('button').exists()).toBe(false)
    wrapper.unmount()
  })
})
