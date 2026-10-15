import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'
import { reactive, ref } from 'vue'
import type { ProjectDto, ProjectTaskDto } from '@shared/types'
import ProjectBoard from './ProjectBoard.vue'

const mocks = vi.hoisted(() => ({
  listInstances: vi.fn(),
  tasksByProject: {} as Record<string, ProjectTaskDto[]>,
  executing: null as unknown as { value: Set<string> },
}))

vi.mock('../../api/client', () => ({ api: {
  instances: { list: mocks.listInstances },
  agent: { onPlanningStateUpdated: () => () => {} },
} }))
vi.mock('../../stores/projects.store', () => ({
  useProjectsStore: () => ({ tasksByProject: mocks.tasksByProject, loadTasks: async () => [] }),
}))
vi.mock('../../stores/agent-definitions.store', () => ({
  useAgentDefinitionsStore: () => ({ agents: [], get: () => undefined }),
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
  useProjectChat: () => ({ startProjectChat: vi.fn() }),
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
    props: { project },
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, Icon: true, ModalDialog: true } },
  })
}

beforeEach(() => {
  mocks.listInstances.mockReset().mockResolvedValue([])
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
