import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import ActivityLogView from './ActivityLogView.vue'

const mocks = vi.hoisted(() => ({ list: vi.fn(), cancel: vi.fn(), push: vi.fn(), onDream: vi.fn(), unsubscribe: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('../stores/agent-definitions.store', () => ({ useAgentDefinitionsStore: () => ({ get: () => undefined }) }))
vi.mock('../stores/memory-jobs.store', () => ({ useMemoryJobsStore: () => ({ activeJobs: [], refresh: async () => undefined }) }))
vi.mock('../api/client', () => ({
  api: {
    activity: { list: mocks.list }, instances: { list: async () => [] },
    memory: { onDreamUpdated: mocks.onDream, cancelDreamRun: mocks.cancel },
    memoryFolders: { onJobUpdated: () => () => undefined }, notifications: { onCreated: () => () => undefined },
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
test('memory and Dream change links open the changed document with a pagination-safe filter', async () => {
  mocks.list.mockResolvedValue({
    items: [{
      id: 'memory-file:category:notes', kind: 'memory', title: 'Updated knowledge graph for notes.md',
      description: 'Knowledge · 3 chunks', createdAt: Date.now(), agentId: null, agentName: null,
      agentIconUrl: null, conversationId: null, memoryFolderId: 'category', memoryFileName: 'notes.md',
    }],
    total: 1,
  })
  const wrapper = mount(ActivityLogView, { global: { stubs: { Icon: true, HoverMenu: true, ModalDialog: true } } })
  await flushPromises()
  await wrapper.get('article').trigger('click')
  expect(mocks.push).toHaveBeenCalledWith({
    path: '/memory-folders/documents', query: { category: 'category', file: 'notes.md' },
  })
})

test('completed Dream changes render a success summary and inline diff instead of raw tool JSON', async () => {
  const rawOutput = JSON.stringify({ status: 'success', fileRef: 'preferences#abc', previousRevision: 1, revision: 2 })
  mocks.list.mockResolvedValue({
    items: [{
      ...running,
      status: 'completed',
      dreamChanges: [{
        tool: 'memory_patch', output: rawOutput, status: 'success',
        summary: 'Updated preferences.md · revision 1 → 2',
        memoryFolderId: 'uncategorized', memoryFileName: 'preferences.md',
        diffSegments: [
          { type: 'unchanged', text: 'Favorite color: ' },
          { type: 'removed', text: 'blue' },
          { type: 'added', text: 'green' },
        ],
      }],
    }],
    total: 1,
  })
  const wrapper = mount(ActivityLogView, { global: { stubs: { Icon: true, HoverMenu: true, ModalDialog: true } } })
  await flushPromises()
  await wrapper.get('summary').trigger('click')
  expect(wrapper.text()).toContain('Updated preferences.md · revision 1 → 2')
  expect(wrapper.text()).toContain('Favorite color: bluegreen')
  expect(wrapper.text()).not.toContain(rawOutput)
  expect(wrapper.find('.border-emerald-500\\/20').exists()).toBe(true)
})
