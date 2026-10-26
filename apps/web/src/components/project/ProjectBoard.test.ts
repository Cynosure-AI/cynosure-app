import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'
import { reactive, ref } from 'vue'
import type { ProjectDto, ProjectTaskDto } from '@shared/types'
import ProjectBoard from './ProjectBoard.vue'

const mocks = vi.hoisted(() => ({
  listInstances: vi.fn(),
  tasksByProject: {} as Record<string, ProjectTaskDto[]>,
  executing: null as unknown as { value: Set<string> },
  selectedTaskIdsByProject: {} as Record<string, string[]>,
  updateTask: vi.fn(),
  removeTask: vi.fn(),
  startProjectChat: vi.fn(),
  taskAttachmentHref: vi.fn((projectId: string, taskId: string, attachmentId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`),
}))

vi.mock('../../api/client', () => ({ api: {
  instances: { list: mocks.listInstances },
  agent: { onPlanningStateUpdated: () => () => {} },
  projects: { taskAttachmentHref: mocks.taskAttachmentHref },
} }))
vi.mock('../../stores/projects.store', () => ({
  useProjectsStore: () => ({
    tasksByProject: mocks.tasksByProject,
    selectedTaskIdsByProject: mocks.selectedTaskIdsByProject,
    setSelectedTasks: (id: string, ids: string[]) => { mocks.selectedTaskIdsByProject[id] = [...new Set(ids)] },
    toggleTaskSelection: (id: string, taskId: string) => {
      const ids = mocks.selectedTaskIdsByProject[id] ?? []
      mocks.selectedTaskIdsByProject[id] = ids.includes(taskId) ? ids.filter((item) => item !== taskId) : [...ids, taskId]
    },
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
  mocks.taskAttachmentHref.mockClear()
  mocks.selectedTaskIdsByProject = reactive({})
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
  const liveChat = live.get('a[aria-label="Open chat for Style the login page"]')
  expect(liveChat.classes()).toContain('text-accent-fg')
  expect(liveChat.find('.animate-ping').exists()).toBe(true)
  expect(live.text()).toContain('2/5')
  expect(live.text()).toContain('Use illustrations')
  expect(live.text()).not.toContain('Style the login page. Use')

  const idle = wrapper.get('section[aria-label="To do"] li[draggable="true"]')
  const idleChat = idle.get('a[aria-label="Open chat for Sortable headers"]')
  expect(idleChat.classes()).not.toContain('text-accent-fg')
  expect(idleChat.find('.animate-ping').exists()).toBe(false)
  expect(idle.find('button[aria-label="Start a chat for Sortable headers"]').exists()).toBe(true)
  expect(idle.findAll('span.line-clamp-2')).toHaveLength(0)

  mocks.executing.value = new Set(['stale'])
  await flushPromises()
  expect(liveChat.find('.animate-ping').exists()).toBe(false)
  expect(idleChat.find('.animate-ping').exists()).toBe(true)
  wrapper.unmount()
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


test('bulk selection reveals checkboxes and makes the whole card toggle selection until the last task is deselected', async () => {
  mocks.tasksByProject.p1 = reactive([
    task({ id: 'a', title: 'First' }),
    task({ id: 'b', title: 'Second', conversationId: 'chat' }),
  ])
  const wrapper = render()
  await flushPromises()
  const cards = wrapper.findAll('li[draggable="true"]')
  const checkboxes = cards.map((card) => card.get('input[type="checkbox"]'))
  const editor = wrapper.getComponent({ name: 'ModalDialog' })
  expect(checkboxes.every((checkbox) => checkbox.classes().includes('opacity-0'))).toBe(true)

  // Use real clicks to cover capture, native checkbox changes, and bubbling together.
  ;(checkboxes[0]!.element as HTMLInputElement).click()
  await flushPromises()
  expect(mocks.selectedTaskIdsByProject.p1).toEqual(['a'])
  expect(checkboxes.every((checkbox) => !checkbox.classes().includes('opacity-0'))).toBe(true)

  await cards[1]!.get('button').trigger('click')
  expect(mocks.selectedTaskIdsByProject.p1).toEqual(['a', 'b'])
  expect(editor.props('show')).toBe(false)

  await cards[1]!.get('button[aria-label="Start a chat for Second"]').trigger('click')
  expect(mocks.selectedTaskIdsByProject.p1).toEqual(['a'])
  expect(mocks.startProjectChat).not.toHaveBeenCalled()

  await cards[1]!.get('a').trigger('click')
  expect(mocks.selectedTaskIdsByProject.p1).toEqual(['a', 'b'])
  ;(checkboxes[1]!.element as HTMLInputElement).click()
  await flushPromises()
  expect(mocks.selectedTaskIdsByProject.p1).toEqual(['a'])

  await cards[0]!.trigger('click')
  expect(mocks.selectedTaskIdsByProject.p1).toEqual([])
  expect(editor.props('show')).toBe(false)
  expect(checkboxes.every((checkbox) => checkbox.classes().includes('opacity-0'))).toBe(true)

  await cards[0]!.get('button').trigger('click')
  expect(editor.props('show')).toBe(true)
  wrapper.unmount()
})

test('selects cards across columns and applies bulk status and delete actions through the store', async () => {
  mocks.tasksByProject.p1 = reactive([
    task({ id: 'a', title: 'First' }),
    task({ id: 'b', title: 'Second', status: 'blocked' }),
    task({ id: 'c', title: 'Other' }),
  ])
  const wrapper = render()
  await flushPromises()
  await wrapper.get('input[aria-label="Select First"]').setValue(true)
  await wrapper.get('input[aria-label="Select Second"]').setValue(true)
  expect(mocks.selectedTaskIdsByProject.p1).toEqual(['a', 'b'])
  expect(wrapper.get('[role="status"]').text()).toBe('2 selected')
  await wrapper.get('select[aria-label="Move selected tasks"]').setValue('done')
  await flushPromises()
  expect(mocks.updateTask.mock.calls).toEqual([
    ['p1', 'a', { status: 'done' }], ['p1', 'b', { status: 'done' }],
  ])
  await wrapper.get('[aria-label="Task selection"]').findAll('button')[0]!.trigger('click')
  await flushPromises()
  expect(mocks.removeTask.mock.calls).toEqual([['p1', 'a'], ['p1', 'b']])
  wrapper.unmount()
})

test('select visible respects folded Done cards, preserves selection on remount, and clears it', async () => {
  mocks.tasksByProject.p1 = reactive(Array.from({ length: 7 }, (_, index) => task({
    id: `d${index}`, title: `Done ${index}`, status: 'done', completedAt: index,
  })))
  let wrapper = render()
  await flushPromises()
  await wrapper.get('[aria-label="Task selection"] input').setValue(true)
  expect(mocks.selectedTaskIdsByProject.p1).toHaveLength(5)
  wrapper.unmount()
  wrapper = render()
  await flushPromises()
  expect(wrapper.get('[role="status"]').text()).toBe('5 selected')
  const clear = wrapper.findAll('button').find((button) => button.text() === 'Clear selection')!
  await clear.trigger('click')
  expect(mocks.selectedTaskIdsByProject.p1).toEqual([])
  wrapper.unmount()
})

test('bulk assignment updates selected tasks, skips the current assignee, and clears to the project default', async () => {
  mocks.tasksByProject.p1 = reactive([
    task({ id: 'a', title: 'First' }),
    task({ id: 'b', title: 'Second', status: 'blocked', assigneeAgentId: 'writer' }),
    task({ id: 'c', title: 'Already assigned', assigneeAgentId: 'coder' }),
    task({ id: 'd', title: 'Unselected' }),
  ])
  const wrapper = render()
  await flushPromises()
  expect(wrapper.find('select[aria-label="Assign selected tasks"]').exists()).toBe(false)
  for (const title of ['First', 'Second', 'Already assigned']) {
    await wrapper.get(`input[aria-label="Select ${title}"]`).setValue(true)
  }
  const select = wrapper.get<HTMLSelectElement>('select[aria-label="Assign selected tasks"]')
  expect(select.findAll('option').map((option) => [option.attributes('value'), option.text()]))
    .toEqual([[undefined, 'Assign agent…'], ['', 'Project default'], ['writer', 'Writer'], ['coder', 'Coder']])

  await select.setValue('coder')
  await flushPromises()
  expect(mocks.updateTask.mock.calls).toEqual([
    ['p1', 'a', { assigneeAgentId: 'coder' }], ['p1', 'b', { assigneeAgentId: 'coder' }],
  ])
  expect(select.element.selectedIndex).toBe(0)
  expect(mocks.selectedTaskIdsByProject.p1).toEqual(['a', 'b', 'c'])

  // Reflect the store's updated tasks before applying another bulk action.
  for (const selected of mocks.tasksByProject.p1!.filter((item) => item.id !== 'd')) selected.assigneeAgentId = 'coder'
  mocks.updateTask.mockClear()
  await select.setValue('')
  await flushPromises()
  expect(mocks.updateTask.mock.calls).toEqual([
    ['p1', 'a', { assigneeAgentId: null }], ['p1', 'b', { assigneeAgentId: null }], ['p1', 'c', { assigneeAgentId: null }],
  ])
  expect(select.element.selectedIndex).toBe(0)

  mocks.tasksByProject.p1![0]!.assigneeAgentId = null
  mocks.updateTask.mockClear()
  await select.setValue('')
  await flushPromises()
  expect(mocks.updateTask.mock.calls).toEqual([
    ['p1', 'b', { assigneeAgentId: null }], ['p1', 'c', { assigneeAgentId: null }],
  ])
  wrapper.unmount()
})

test('bulk assignment reports update failures and resets the picker', async () => {
  mocks.tasksByProject.p1 = reactive([task({ id: 'a', title: 'First' })])
  const wrapper = render()
  await flushPromises()
  await wrapper.get('input[aria-label="Select First"]').setValue(true)
  mocks.updateTask.mockRejectedValueOnce(new Error('Assignment failed'))
  const select = wrapper.get<HTMLSelectElement>('select[aria-label="Assign selected tasks"]')
  await select.setValue('writer')
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBe('Assignment failed')
  expect(select.element.selectedIndex).toBe(0)
  await select.setValue('writer')
  await flushPromises()
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  wrapper.unmount()
})

test('cards preview only image attachments and preserve bulk clicks and card dragging', async () => {
  mocks.tasksByProject.p1 = reactive([
    task({ id: 'a', title: 'Screenshot', attachmentCount: 2, imageAttachmentId: 'image/1' }),
    task({ id: 'b', title: 'Documents', attachmentCount: 3, imageAttachmentId: null }),
    task({ id: 'c', title: 'No attachments' }),
  ])
  const wrapper = render()
  await flushPromises()
  const cards = wrapper.findAll('li[draggable="true"]')
  const image = cards[0]!.get('img')
  const link = cards[0]!.get('a[aria-label="Open image attachment for Screenshot"]')
  const href = '/api/projects/p1/tasks/a/attachments/image%2F1'
  expect(mocks.taskAttachmentHref).toHaveBeenCalledWith('p1', 'a', 'image/1')
  expect(image.attributes()).toMatchObject({ src: href, loading: 'lazy', draggable: 'false', width: '64', height: '48' })
  expect(link.attributes()).toMatchObject({ href, target: '_blank', rel: 'noopener', draggable: 'false' })
  expect(cards[0]!.get('[title="2 attachments"]').text()).toBe('2')
  expect(cards[1]!.find('img').exists()).toBe(false)
  expect(cards[1]!.get('[title="3 attachments"]').text()).toBe('3')
  expect(cards[2]!.find('img').exists()).toBe(false)
  const click = new MouseEvent('click', { bubbles: true, cancelable: true })
  link.element.dispatchEvent(click)
  expect(click.defaultPrevented).toBe(false)
  expect(wrapper.getComponent({ name: 'ModalDialog' }).props('show')).toBe(false)

  const setData = vi.fn()
  await image.trigger('dragstart', { dataTransfer: { setData, effectAllowed: '' } })
  expect(setData).toHaveBeenCalledWith('text/plain', 'a')
  await wrapper.get('section[aria-label="Blocked"]').trigger('drop')
  await flushPromises()
  expect(mocks.updateTask).toHaveBeenCalledWith('p1', 'a', { status: 'blocked', sortOrder: 1 })

  await wrapper.get('input[aria-label="Select Documents"]').setValue(true)
  const bulkClick = new MouseEvent('click', { bubbles: true, cancelable: true })
  image.element.dispatchEvent(bulkClick)
  await flushPromises()
  expect(bulkClick.defaultPrevented).toBe(true)
  expect(mocks.selectedTaskIdsByProject.p1).toEqual(['b', 'a'])
  expect(wrapper.getComponent({ name: 'ModalDialog' }).props('show')).toBe(false)
  wrapper.unmount()
})
