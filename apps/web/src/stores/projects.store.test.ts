import { beforeEach, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ProjectTaskDto } from '@shared/types'
import { useProjectsStore } from './projects.store'

const mocks = vi.hoisted(() => ({ listTasks: vi.fn(), removeTask: vi.fn() }))
vi.mock('../api/client', () => ({ api: { projects: mocks } }))

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.removeTask.mockResolvedValue(undefined)
})

const task = (id: string) => ({ id, projectId: 'p1' }) as ProjectTaskDto

test('keeps selection per project and prunes deleted tasks on refresh and removal', async () => {
  const store = useProjectsStore()
  store.tasksByProject.p1 = [task('a'), task('b')]
  store.tasksByProject.p2 = [task('c')]
  store.setSelectedTasks('p1', ['a', 'a', 'b', 'missing'])
  store.toggleTaskSelection('p2', 'c')
  expect(store.selectedTaskIdsByProject).toEqual({ p1: ['a', 'b'], p2: ['c'] })

  mocks.listTasks.mockResolvedValue([task('a')])
  await store.loadTasks('p1')
  expect(store.selectedTaskIdsByProject.p1).toEqual(['a'])
  await store.removeTask('p1', 'a')
  expect(store.selectedTaskIdsByProject).toEqual({ p1: [], p2: ['c'] })
  expect(mocks.removeTask).toHaveBeenCalledWith('p1', 'a')
})

test('toggles each task independently', () => {
  const store = useProjectsStore()
  store.tasksByProject.p1 = [task('a'), task('b')]
  store.toggleTaskSelection('p1', 'a')
  store.toggleTaskSelection('p1', 'b')
  store.toggleTaskSelection('p1', 'a')
  expect(store.selectedTaskIdsByProject.p1).toEqual(['b'])
})
