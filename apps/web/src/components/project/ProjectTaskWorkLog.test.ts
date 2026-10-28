import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'
import ProjectTaskWorkLog from './ProjectTaskWorkLog.vue'
import type { PlanningState } from '../../api/types'

const mocks = vi.hoisted(() => ({
  taskWorkLog: vi.fn(),
  planningHandlers: [] as Array<(data: unknown) => void>,
}))
vi.mock('../../api/client', () => ({ api: {
  projects: { taskWorkLog: mocks.taskWorkLog, onTasksUpdated: () => () => {} },
  agent: { onPlanningStateUpdated: (cb: (data: unknown) => void) => { mocks.planningHandlers.push(cb); return () => {} } },
} }))

function plan(overrides: Partial<PlanningState>): PlanningState {
  return {
    runId: 'run', conversationId: 'chat', status: 'completed', objective: 'Write the report',
    items: [], createdAt: 1, updatedAt: 1, ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.taskWorkLog.mockReset()
  mocks.planningHandlers.length = 0
})

function render() {
  return mount(ProjectTaskWorkLog, {
    props: { projectId: 'project', taskId: 'task' },
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, Icon: true } },
  })
}

test('shows each run with its steps and outcome, all collapsed initially', async () => {
  mocks.taskWorkLog.mockResolvedValue([
    plan({ runId: 'second', status: 'error', items: [{ id: '01', title: 'Draft', status: 'blocked', note: 'Waiting for numbers', updatedAt: 2 }], result: { error: 'Stopped before completion.' } }),
    plan({ runId: 'first', items: [{ id: '01', title: 'Gather data', status: 'completed', updatedAt: 1 }], result: { summary: 'Collected the data.' } }),
  ])
  const wrapper = render()
  await flushPromises()

  expect(mocks.taskWorkLog).toHaveBeenCalledWith('project', 'task')
  const runs = wrapper.findAll('details')
  expect(runs).toHaveLength(2)
  expect(runs[0].attributes('open')).toBeUndefined()
  expect(runs[1].attributes('open')).toBeUndefined()
  expect(runs[0].text()).toContain('Stopped')
  expect(runs[0].text()).toContain('Waiting for numbers')
  expect(runs[1].text()).toContain('Collected the data.')
})

test('explains an empty log', async () => {
  mocks.taskWorkLog.mockResolvedValue([])
  const wrapper = render()
  await flushPromises()
  expect(wrapper.text()).toContain('its step plan is recorded here')
})

test('refreshes when a run in the log changes and ignores other runs', async () => {
  mocks.taskWorkLog.mockResolvedValue([plan({ status: 'running' })])
  render()
  await flushPromises()

  mocks.planningHandlers.forEach((handler) => handler({ runId: 'unrelated' }))
  await vi.runAllTimersAsync()
  expect(mocks.taskWorkLog).toHaveBeenCalledTimes(1)

  mocks.planningHandlers.forEach((handler) => handler({ runId: 'run' }))
  await vi.runAllTimersAsync()
  expect(mocks.taskWorkLog).toHaveBeenCalledTimes(2)
})
