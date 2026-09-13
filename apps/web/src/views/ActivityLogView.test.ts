import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import ActivityLogView from './ActivityLogView.vue'
import { SK_ACTIVITY_LOG_FILTERS } from '../utils/storage-keys'

const mocks = vi.hoisted(() => ({ list: vi.fn(), cancel: vi.fn(), push: vi.fn(), onDream: vi.fn(), unsubscribe: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('../stores/agent-definitions.store', () => ({ useAgentDefinitionsStore: () => ({ get: () => undefined }) }))
vi.mock('../stores/memory-jobs.store', () => ({ useMemoryJobsStore: () => ({ activeJobs: [], refresh: async () => undefined }) }))
vi.mock('../api/client', () => ({
  api: {
    activity: { list: mocks.list }, instances: { list: async () => [] },
    memory: { onDreamUpdated: mocks.onDream, cancelDreamRun: mocks.cancel },
    memoryCategories: { onJobUpdated: () => () => undefined }, notifications: { onCreated: () => () => undefined },
    agent: { onHITLRequest: () => () => undefined, onExecutionUpdate: () => () => undefined },
    chat: { onExecutionState: () => () => undefined },
  }
}))
const running = { id: 'dream:run', kind: 'dream', title: 'Dream review', description: 'Reviewing conversation', status: 'running', sourceId: 'run', sourceLabel: 'Dream', conversationId: 'chat', conversationTitle: 'My preferences', createdAt: Date.now(), agentId: null, agentName: null, agentIconUrl: null }
beforeEach(() => {
  sessionStorage.clear()
  mocks.list.mockReset().mockResolvedValue({ items: [], total: 0 })
  mocks.cancel.mockReset().mockResolvedValue({ success: true })
  mocks.onDream.mockReset().mockReturnValue(mocks.unsubscribe)
  mocks.unsubscribe.mockReset()
  mocks.push.mockReset()
})
afterEach(() => sessionStorage.clear())
test('a live Dream update immediately appears under Active Now and can be cancelled', async () => {
  const wrapper = mount(ActivityLogView, { global: { stubs: { Icon: true, HoverMenu: true, ModalDialog: true } } })
  await flushPromises()
  expect(wrapper.text()).not.toContain('Dream review')
  mocks.list.mockResolvedValue({ items: [running], total: 1 })
  mocks.onDream.mock.calls[0][0]({ id: 'run', status: 'running' })
  await flushPromises()
  expect(wrapper.text()).toContain('Active Now')
  expect(wrapper.findAll('h2').filter(title => title.text() === 'Dream review')).toHaveLength(1)
  expect(wrapper.text()).toContain('running')
  expect(wrapper.text()).toContain('My preferences')
  expect(wrapper.find('time').attributes('datetime')).toBe(new Date(running.createdAt).toISOString())
  await wrapper.findAll('button').find(button => button.text() === 'Cancel')!.trigger('click')
  await flushPromises()
  expect(mocks.cancel).toHaveBeenCalledWith('run')
  mocks.list.mockResolvedValue({ items: [{ ...running, status: 'completed', description: '2 message excerpts reviewed · No new memories' }], total: 1 })
  mocks.onDream.mock.calls[0][0]({ id: 'run', status: 'completed' })
  await flushPromises()
  expect(wrapper.text()).not.toContain('Active Now')
  expect(wrapper.text()).toContain('No new memories')
  expect(wrapper.findAll('h2').filter(title => title.text() === 'Dream review')).toHaveLength(1)
  await wrapper.findAll('h2').find(title => title.text() === 'Dream review')!.trigger('click')
  expect(mocks.push).toHaveBeenCalledWith('/chat/chat')
  wrapper.unmount()
  expect(mocks.unsubscribe).toHaveBeenCalledOnce()
})
test('the previous default filters include Dream after upgrading', async () => {
  sessionStorage.setItem(SK_ACTIVITY_LOG_FILTERS, JSON.stringify(['instance', 'artifact', 'chat', 'channels', 'cron', 'memory']))
  mocks.list.mockResolvedValue({ items: [running], total: 1 })
  const wrapper = mount(ActivityLogView, { global: { stubs: { Icon: true, HoverMenu: true, ModalDialog: true } } })
  await flushPromises()
  expect(mocks.list.mock.calls[0][0].types).toContain('dream')
  expect(wrapper.text()).toContain('Active Now')
  wrapper.unmount()
})
