import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CronJob } from '../../api/types'
import CronDetailView from './CronDetailView.vue'

const mocks = vi.hoisted(() => ({
  listJobs: vi.fn(),
  update: vi.fn(),
  push: vi.fn(),
  updateGuard: undefined as undefined | (() => boolean),
  leaveGuard: undefined as undefined | ((to: { fullPath: string }) => boolean),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'job-1' } }),
  useRouter: () => ({ push: mocks.push }),
  onBeforeRouteUpdate: (guard: () => boolean) => { mocks.updateGuard = guard },
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

const mounted: ReturnType<typeof mount>[] = []
function mountView() {
  const wrapper = mount(CronDetailView, { global: { stubs } })
  mounted.push(wrapper)
  return wrapper
}
afterEach(() => mounted.splice(0).forEach(wrapper => wrapper.unmount()))

const saveButton = (wrapper: ReturnType<typeof mountView>) => wrapper.findAll('button').find((button) => /Save Changes|Saving/.test(button.text()))!

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.listJobs.mockReset().mockResolvedValue([job])
  mocks.update.mockReset().mockImplementation(async (_id, changes) => ({ ...job, ...changes }))
  mocks.push.mockReset()
  mocks.updateGuard = undefined
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
  expect(wrapper.get('[data-test="discard"]').findAll('button').map(button => button.text()))
    .toEqual(['Discard', 'Continue editing'])
  await wrapper.get('[data-test="discard"]').findAll('button')[1].trigger('click')
  expect(wrapper.find('[data-test="discard"]').exists()).toBe(false)
  expect(wrapper.get('textarea').element).toHaveProperty('value', 'Summarize my week')
  expect(mocks.push).not.toHaveBeenCalled()
  mocks.leaveGuard?.({ fullPath: '/cron' })
  await flushPromises()

  await wrapper.findAll('button').find((button) => button.text() === 'Discard')!.trigger('click')
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


test('locks editing and navigation during a save and ignores duplicate submissions', async () => {
  let finish!: (value: CronJob) => void
  mocks.update.mockReturnValue(new Promise<CronJob>(resolve => { finish = resolve }))
  const wrapper = mountView()
  await flushPromises()
  await wrapper.get('textarea').setValue('Summarize my week')
  // Keep the handler to simulate a second submit even after the button becomes disabled.
  const submit = saveButton(wrapper).element as HTMLButtonElement
  submit.click()
  await flushPromises()
  expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined()
  expect(wrapper.get('fieldset').attributes('inert')).toBeDefined()
  expect(wrapper.get('[aria-label="Enable scheduled job"]').attributes('disabled')).toBeDefined()
  expect(saveButton(wrapper).attributes('disabled')).toBeDefined()
  expect(mocks.leaveGuard?.({ fullPath: '/cron' })).toBe(false)
  expect(mocks.updateGuard?.()).toBe(false)
  expect(wrapper.find('[data-test="discard"]').exists()).toBe(false)
  submit.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  // A teleported dropdown already open when Save was clicked cannot alter the draft.
  wrapper.getComponent({ name: 'CustomSelect' }).vm.$emit('update:modelValue', 'project-1')
  await flushPromises()
  expect(mocks.update).toHaveBeenCalledTimes(1)
  finish({ ...job, prompt: 'Summarize my week' })
  await flushPromises()
  expect(wrapper.get('fieldset').attributes('disabled')).toBeUndefined()
  expect(wrapper.text()).toContain('Saved')
  expect(wrapper.text()).not.toContain('Unsaved changes')
  expect(wrapper.getComponent({ name: 'CustomSelect' }).props('modelValue')).toBe('')
  expect(mocks.leaveGuard?.({ fullPath: '/cron' })).toBe(true)
  expect(mocks.listJobs).toHaveBeenCalledTimes(1)
})

test('uses the successful update response instead of reloading and overwriting the form', async () => {
  const wrapper = mountView()
  await flushPromises()
  mocks.listJobs.mockRejectedValue(new Error('List unavailable'))
  mocks.update.mockResolvedValue({ ...job, name: 'Normalized by server', prompt: 'Saved prompt' })
  await wrapper.get('textarea').setValue('Draft prompt')
  await saveButton(wrapper).trigger('click')
  await flushPromises()
  expect(wrapper.get('textarea').element).toHaveProperty('value', 'Saved prompt')
  expect(wrapper.get('input[type="text"]').element).toHaveProperty('value', 'Normalized by server')
  expect(wrapper.text()).toContain('Saved')
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(mocks.listJobs).toHaveBeenCalledTimes(1)
})

test('unlocks the draft after a failed save and allows retrying it', async () => {
  const wrapper = mountView()
  await flushPromises()
  await wrapper.get('textarea').setValue('Keep this prompt')
  mocks.update.mockRejectedValueOnce(new Error('Connection lost'))
  await saveButton(wrapper).trigger('click')
  await flushPromises()
  expect(wrapper.get('fieldset').attributes('disabled')).toBeUndefined()
  expect(wrapper.get('textarea').element).toHaveProperty('value', 'Keep this prompt')
  expect(saveButton(wrapper).attributes('disabled')).toBeUndefined()
  await saveButton(wrapper).trigger('click')
  await flushPromises()
  expect(mocks.update).toHaveBeenCalledTimes(2)
  expect(wrapper.text()).not.toContain('Unsaved changes')
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
})

test('protects refreshes while dirty and removes the handler on unmount', async () => {
  const wrapper = mountView()
  await flushPromises()
  const clean = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(clean)
  expect(clean.defaultPrevented).toBe(false)
  await wrapper.get('textarea').setValue('Unsaved prompt')
  const dirty = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(dirty)
  expect(dirty.defaultPrevented).toBe(true)
  wrapper.unmount()
  mounted.splice(mounted.indexOf(wrapper), 1)
  const unmounted = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unmounted)
  expect(unmounted.defaultPrevented).toBe(false)
})
