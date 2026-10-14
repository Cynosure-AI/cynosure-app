import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ChatSchedulesPopover from './ChatSchedulesPopover.vue'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  push: vi.fn(),
  chatStore: { activeAgentId: null as string | null },
}))

vi.mock('../../api/client', () => ({ api: { cronJobs: { list: mocks.list } } }))
vi.mock('../../stores/chat.store', () => ({ useChatStore: () => mocks.chatStore }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))

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

  it('shows only enabled schedules for the current agent', async () => {
    const wrapper = mount(ChatSchedulesPopover, { global: { stubs: { Icon: true } } })
    await vi.waitFor(() => expect(wrapper.find('[aria-label="Schedules"]').exists()).toBe(true))
    await wrapper.get('button[aria-label="Schedules"]').trigger('click')
    const text = wrapper.get('[role="dialog"]').text()
    expect(text).toContain('Enabled')
    expect(text).not.toContain('Disabled')
    expect(text).not.toContain('Other agent')
    wrapper.unmount()
  })

  it.each([
    { jobs: [] },
    { jobs: [job('Disabled', 'agent-2', false)] },
  ])('hides the header button when this agent has no enabled schedules ($jobs)', async ({ jobs }) => {
    mocks.chatStore.activeAgentId = 'agent-2'
    mocks.list.mockResolvedValue(jobs)
    const wrapper = mount(ChatSchedulesPopover, { global: { stubs: { Icon: true } } })
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalled())
    expect(wrapper.find('button').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens the selected schedule details page', async () => {
    const wrapper = mount(ChatSchedulesPopover, { global: { stubs: { Icon: true } } })
    await vi.waitFor(() => expect(wrapper.find('[aria-label="Schedules"]').exists()).toBe(true))
    await wrapper.get('button[aria-label="Schedules"]').trigger('click')
    await wrapper.get('button[aria-label="Open schedule Enabled"]').trigger('click')
    expect(mocks.push).toHaveBeenCalledWith({ name: 'cron-detail', params: { id: 'Enabled' } })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
