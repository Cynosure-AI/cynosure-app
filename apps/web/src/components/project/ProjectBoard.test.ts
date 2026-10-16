import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'
import { reactive, ref } from 'vue'
import type { ProjectDto, ProjectTaskDto } from '@shared/types'
import ProjectBoard from './ProjectBoard.vue'

const mocks = vi.hoisted(() => ({
  listInstances: vi.fn(),
  tasksByProject: {} as Record<string, ProjectTaskDto[]>,
  executing: null as unknown as { value: Set<string> },
  updateTask: vi.fn(),
  removeTask: vi.fn(),
  startProjectChat: vi.fn(),
}))

vi.mock('../../api/client', () => ({ api: {
  instances: { list: mocks.listInstances },
  agent: { onPlanningStateUpdated: () => () => {} },
} }))
vi.mock('../../stores/projects.store', () => ({
  useProjectsStore: () => ({
    tasksByProject: mocks.tasksByProject,
    loadTasks: async () => [],
    updateTask: mocks.updateTask,
    removeTask: mocks.removeTask,
  }),
}))
vi.mock('../../stores/agent-definitions.store', () => ({
  useAgentDefinitionsStore: () => ({
    agents: [
      { id: 'writer', name: 'Writer', favorite: false, sortOrder: 2 },
      { id: 'coder', name: 'Coder', favorite: true, sortOrder: 1 },
    ],
    get: () => undefined,
  }),
}))
vi.mock('../../stores/agent-runtime.store', () => ({
  useAgentStore: () => ({
    awaitingHITLConvIds: new Set<string>(),
    isConversationExecuting: (id: string) => mocks.executing.value.has(id),
    setConversationExecutionState: (id: string, running: boolean) => {
      const next = new Set(mocks.executing.value)
      if (running) next.add(id)
      else next.delete(id)
      mocks.executing.value = next
    },
  }),
}))
vi.mock('../../composables/useProjectChat', () => ({
  taskDraft: () => '',
  useProjectChat: () => ({ startProjectChat: mocks.startProjectChat }),
}))

const project = { id: 'p1', defaultAgentId: null } as ProjectDto

function task(overrides: Partial<ProjectTaskDto>): ProjectTaskDto {
  return {
    id: 't', projectId: 'p1', title: 'Task', notes: '', status: 'todo', sortOrder: 1, assigneeAgentId: null,
    conversationId: null, createdBy: 'user', createdAt: 1, updatedAt: 1, completedAt: null, progress: null, ...overrides,
  }
}

function render() {
  return mount(ProjectBoard, {
    attachTo: document.body,
    props: { project },
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, Icon: true, ModalDialog: true } },
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
  mocks.listInstances.mockReset().mockResolvedValue([])
  mocks.updateTask.mockReset().mockResolvedValue({})
  mocks.removeTask.mockReset().mockResolvedValue(undefined)
  mocks.startProjectChat.mockReset()
  mocks.executing = ref(new Set<string>())
  for (const key of Object.keys(mocks.tasksByProject)) delete mocks.tasksByProject[key]
})

test('Done lists the newest finished tasks first and folds the rest behind a +N toggle', async () => {
  mocks.tasksByProject.p1 = reactive(Array.from({ length: 7 }, (_, index) => task({
    id: `d${index}`, title: `Done ${index}`, status: 'done', sortOrder: index, completedAt: index * 10,
  })))
  const wrapper = render()
  await flushPromises()

  const done = wrapper.get('section[aria-label="Done"]')
  expect(done.findAll('li[draggable="true"]').map((card) => card.find('span').text()))
    .toEqual(['Done 6', 'Done 5', 'Done 4', 'Done 3', 'Done 2'])
  expect(done.get('header').text()).toContain('7')

  await done.get('button[aria-expanded="false"]').trigger('click')
  expect(done.findAll('li[draggable="true"]')).toHaveLength(7)
  expect(done.get('button[aria-expanded="true"]').text()).toContain('Show fewer')

  // Empty columns explain themselves instead of leaving a blank lane.
  expect(wrapper.get('section[aria-label="Blocked"]').text()).toContain('Nothing blocked')
})

test('cards show live run state and step progress, and skip notes that repeat the title', async () => {
  mocks.tasksByProject.p1 = reactive([
    task({ id: 'a', title: 'Style the login page', notes: 'Style the login page. Use illustrations', conversationId: 'live',
      status: 'in_progress', progress: { runId: 'r1', status: 'running', completed: 2, total: 5 } }),
    task({ id: 'b', title: 'Sortable headers', notes: 'Sortable headers', conversationId: 'stale', sortOrder: 2 }),
  ])
  // "stale" was left marked as running by an event this window missed.
  mocks.executing.value = new Set(['stale'])
  mocks.listInstances.mockResolvedValue([{ conversationId: 'live', status: 'running' }])
  const wrapper = render()
  await flushPromises()

  const live = wrapper.get('section[aria-label="In progress"] li[draggable="true"]')
  expect(live.text()).toContain('Working')
  expect(live.text()).toContain('2/5')
  expect(live.text()).toContain('Use illustrations')
  expect(live.text()).not.toContain('Style the login page. Use')

  const idle = wrapper.get('section[aria-label="To do"] li[draggable="true"]')
  expect(idle.text()).toContain('Chat')
  expect(idle.text()).not.toContain('Working')
  expect(idle.findAll('span.line-clamp-2')).toHaveLength(0)
})

function contextMenu(): HTMLElement | null {
  return document.body.querySelector('[data-testid="task-context-menu"]')
}

function menuItem(label: string): HTMLButtonElement {
  const item = [...document.body.querySelectorAll<HTMLButtonElement>('[data-task-context-menu] button')]
    .find((button) => button.textContent?.trim() === label)
  if (!item) throw new Error(`No menu item ${label}`)
  return item
}

test('right-clicking a card opens a menu to run, assign, finish, or delete the task', async () => {
  mocks.tasksByProject.p1 = reactive([task({ id: 'a', title: 'Write docs', assigneeAgentId: 'writer' })])
  const wrapper = render()
  await flushPromises()
  const card = wrapper.get('li[draggable="true"]')

  await card.trigger('contextmenu', { clientX: 40, clientY: 50 })
  expect([...contextMenu()!.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()))
    .toEqual(['Run', 'Assign agent', 'Mark as done', 'Delete'])

  menuItem('Run').click()
  await flushPromises()
  expect(mocks.startProjectChat).toHaveBeenCalledWith(project, expect.objectContaining({ agentId: 'writer' }))
  expect(contextMenu()).toBeNull()

  // Assigning lists the project default, then agents in picker order, with the current one checked.
  await card.trigger('contextmenu', { clientX: 40, clientY: 50 })
  menuItem('Assign agent').click()
  await flushPromises()
  const agentItems = [...document.body.querySelectorAll('[data-task-agent-menu] [role="menuitemradio"]')]
  expect(agentItems.map((item) => [item.textContent?.trim(), item.getAttribute('aria-checked')]))
    .toEqual([['Project default', 'false'], ['Coder', 'false'], ['Writer', 'true']])
  menuItem('Coder').click()
  await flushPromises()
  expect(mocks.updateTask).toHaveBeenLastCalledWith('p1', 'a', { assigneeAgentId: 'coder' })

  await card.trigger('contextmenu', { clientX: 40, clientY: 50 })
  menuItem('Mark as done').click()
  await flushPromises()
  expect(mocks.updateTask).toHaveBeenLastCalledWith('p1', 'a', { status: 'done' })

  await card.trigger('contextmenu', { clientX: 40, clientY: 50 })
  menuItem('Delete').click()
  await flushPromises()
  expect(mocks.removeTask).toHaveBeenCalledWith('p1', 'a')
  wrapper.unmount()
})

test('the task menu closes on Escape or a click outside, and disables finished-task actions', async () => {
  mocks.tasksByProject.p1 = reactive([task({ id: 'd', title: 'Shipped', status: 'done', completedAt: 5 })])
  const wrapper = render()
  await flushPromises()
  const card = wrapper.get('li[draggable="true"]')

  await card.trigger('contextmenu', { clientX: 10, clientY: 10 })
  expect(menuItem('Run').disabled).toBe(true)
  expect(menuItem('Mark as done').disabled).toBe(true)
  expect(menuItem('Delete').disabled).toBe(false)

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await flushPromises()
  expect(contextMenu()).toBeNull()

  await card.trigger('contextmenu', { clientX: 10, clientY: 10 })
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await flushPromises()
  expect(contextMenu()).toBeNull()
  wrapper.unmount()
})

test('the agent list survives scrolling itself and a short trip across other items', async () => {
  mocks.tasksByProject.p1 = reactive([task({ id: 'a', title: 'Write docs' })])
  const wrapper = render()
  await flushPromises()
  const card = wrapper.get('li[draggable="true"]')
  const agentMenu = () => document.body.querySelector('[data-task-agent-menu]')

  await card.trigger('contextmenu', { clientX: 10, clientY: 10 })
  menuItem('Assign agent').dispatchEvent(new MouseEvent('mouseenter'))
  await flushPromises()
  agentMenu()!.dispatchEvent(new Event('scroll'))
  await flushPromises()
  expect(agentMenu()).not.toBeNull()

  vi.useFakeTimers()
  try {
    // Crossing another item on the way to the list starts a grace period; reaching the list cancels it.
    menuItem('Mark as done').dispatchEvent(new MouseEvent('mouseenter'))
    vi.advanceTimersByTime(200)
    agentMenu()!.dispatchEvent(new MouseEvent('mouseenter'))
    vi.advanceTimersByTime(500)
    await flushPromises()
    expect(agentMenu()).not.toBeNull()

    menuItem('Delete').dispatchEvent(new MouseEvent('mouseenter'))
    vi.advanceTimersByTime(500)
    await flushPromises()
    expect(agentMenu()).toBeNull()
    expect(contextMenu()).not.toBeNull()
  } finally {
    vi.useRealTimers()
  }

  // Scrolling the page still closes the menu, which would otherwise drift off its card.
  document.body.dispatchEvent(new Event('scroll'))
  await flushPromises()
  expect(contextMenu()).toBeNull()
  wrapper.unmount()
})
