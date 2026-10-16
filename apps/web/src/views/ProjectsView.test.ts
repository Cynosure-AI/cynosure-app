import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import ProjectsView from './ProjectsView.vue'

const mocks = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))

const project = { id: 'project-1', name: 'Garden Planner', description: 'Spring beds', brief: '', color: '#10b981', icon: '', rootPath: '', archived: false, defaultAgentId: null, conversationCount: 3, openTaskCount: 2 }
const projectsStore = reactive({
  projects: [project],
  loaded: true,
  load: vi.fn().mockResolvedValue(undefined),
  create: vi.fn(),
  update: vi.fn().mockResolvedValue(project),
  remove: vi.fn().mockResolvedValue(undefined),
})

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}))
vi.mock('../stores/projects.store', () => ({ useProjectsStore: () => projectsStore }))
vi.mock('../stores/agent-definitions.store', () => ({ useAgentDefinitionsStore: () => ({ loaded: true, get: () => undefined }) }))
vi.mock('../stores/cyno.store', () => ({ useCynoStore: () => ({ name: 'Cyno' }) }))

function mountView() {
  return mount(ProjectsView, {
    attachTo: document.body,
    global: {
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
        ProjectIcon: true,
        ProjectForm: true,
        Icon: true,
      },
    },
  })
}

async function openMenu(wrapper: ReturnType<typeof mountView>): Promise<void> {
  await wrapper.get('[aria-label="Garden Planner options"]').trigger('click')
}

function menuItem(wrapper: ReturnType<typeof mountView>, label: string) {
  return wrapper.findAll('[role="menuitem"]').find(item => item.text() === label)!
}

describe('ProjectsView card actions', () => {
  beforeEach(() => {
    project.archived = false
    mocks.push.mockClear()
    projectsStore.update.mockClear()
    projectsStore.remove.mockClear()
  })

  test('opens the quick menu and closes it on an outside click or Escape', async () => {
    const wrapper = mountView()
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    await openMenu(wrapper)
    expect(wrapper.find('[role="menu"]').exists()).toBe(true)

    document.body.click()
    await flushPromises()
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)

    await openMenu(wrapper)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    wrapper.unmount()
  })

  test('edits in the project settings tab', async () => {
    const wrapper = mountView()
    await openMenu(wrapper)
    await menuItem(wrapper, 'Edit').trigger('click')
    expect(mocks.push).toHaveBeenCalledWith({ name: 'project-detail', params: { id: 'project-1' }, query: { tab: 'settings' } })
    wrapper.unmount()
  })

  test('archives an active project and restores an archived one', async () => {
    const wrapper = mountView()
    await openMenu(wrapper)
    await menuItem(wrapper, 'Archive').trigger('click')
    expect(projectsStore.update).toHaveBeenCalledWith('project-1', { archived: true })
    wrapper.unmount()
  })

  test('deletes only after confirmation', async () => {
    const wrapper = mountView()
    await openMenu(wrapper)
    await menuItem(wrapper, 'Delete').trigger('click')
    await flushPromises()
    expect(projectsStore.remove).not.toHaveBeenCalled()

    const confirm = [...document.body.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Delete project')!
    expect(document.body.textContent).toContain('Delete Garden Planner?')
    confirm.click()
    await flushPromises()
    expect(projectsStore.remove).toHaveBeenCalledWith('project-1')
    wrapper.unmount()
  })
})
