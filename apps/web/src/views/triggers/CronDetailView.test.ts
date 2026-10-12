import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'
import type { CronJob } from '../../api/types'
import CronDetailView from './CronDetailView.vue'

const mocks = vi.hoisted(() => ({
  listJobs: vi.fn(),
  update: vi.fn(),
  push: vi.fn(),
  leaveGuard: undefined as undefined | ((to: { fullPath: string }) => boolean),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'job-1' } }),
  useRouter: () => ({ push: mocks.push }),
  onBeforeRouteLeave: (guard: (to: { fullPath: string }) => boolean) => { mocks.leaveGuard = guard },
}))
vi.mock('../../api/client', () => ({
  api: {
    cronJobs: { list: mocks.listJobs, update: mocks.update },
    agents: { list: async () => [] },
    channels: { list: async () => [] },
    projects: { list: async () => [{ id: 'project-1', name: 'Launch', archived: false }] },
  },
}))

const job: CronJob = {
  id: 'job-1', name: 'Morning summary', agentId: 'agent', schedule: '0 9 * * *', prompt: 'Summarize my day',
  enabled: true, oneOff: false, outputChannelId: '', notificationMode: 'always', notificationCondition: '',
  createdAt: 1, updatedAt: 1, agentName: 'Research Helper', agentIconUrl: null, isRunning: false, nextRunAt: null,
  executionConfig: null,
}

const stubs = { Icon: true, AgentSelect: true, HoverMenu: true, ModalDialog: { props: ['show'], template: '<div v-if="show" data-test="discard"><slot /><slot name="actions" /></div>' } }

function mountView() {
  return mount(CronDetailView, { global: { stubs } })
}

const saveButton = (wrapper: ReturnType<typeof mountView>) => wrapper.findAll('button').find((button) => /Save Changes|Saving/.test(button.text()))!

beforeEach(() => {
  mocks.listJobs.mockReset().mockResolvedValue([job])
  mocks.update.mockReset().mockResolvedValue(undefined)
  mocks.push.mockReset()
  mocks.leaveGuard = undefined
})

test('Save stays disabled until a field changes', async () => {
  const wrapper = mountView()
  await flushPromises()
  expect(saveButton(wrapper).attributes('disabled')).toBeDefined()

  await wrapper.get('textarea').setValue('Summarize my week')

  expect(saveButton(wrapper).attributes('disabled')).toBeUndefined()
  expect(wrapper.text()).toContain('Unsaved changes')
})

test('the status describes the saved state, not an unsaved toggle', async () => {
  const wrapper = mountView()
  await flushPromises()

  await wrapper.getComponent({ name: 'ToggleSwitch' }).vm.$emit('update:modelValue', false)
  await flushPromises()

  expect(wrapper.text()).toContain('Scheduled')
  expect(wrapper.text()).toContain('It will be paused when you save.')
})

test('a failed save is reported and the edits are kept', async () => {
  mocks.update.mockRejectedValue(new Error('Invalid cron expression'))
  const wrapper = mountView()
  await flushPromises()
  await wrapper.get('textarea').setValue('Summarize my week')

  await saveButton(wrapper).trigger('click')
  await flushPromises()

  expect(wrapper.get('[role="alert"]').text()).toBe('Changes were not saved: Invalid cron expression')
  expect(wrapper.text()).toContain('Unsaved changes')
  expect(wrapper.text()).not.toContain('Saved')
})

test('leaving with unsaved changes asks before discarding them', async () => {
  const wrapper = mountView()
  await flushPromises()
  expect(mocks.leaveGuard?.({ fullPath: '/cron' })).toBe(true)

  await wrapper.get('textarea').setValue('Summarize my week')
  expect(mocks.leaveGuard?.({ fullPath: '/cron' })).toBe(false)
  await flushPromises()
  expect(wrapper.find('[data-test="discard"]').exists()).toBe(true)

  await wrapper.findAll('button').find((button) => button.text() === 'Discard changes')!.trigger('click')
  expect(mocks.push).toHaveBeenCalledWith('/cron')
})

test('the project choice is saved with the job', async () => {
  const wrapper = mountView()
  await flushPromises()

  await wrapper.getComponent({ name: 'CustomSelect' }).vm.$emit('update:modelValue', 'project-1')
  await saveButton(wrapper).trigger('click')
  await flushPromises()

  expect(mocks.update).toHaveBeenCalledWith('job-1', expect.objectContaining({ projectId: 'project-1' }))
})
