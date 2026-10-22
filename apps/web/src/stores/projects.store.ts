import { defineStore, acceptHMRUpdate } from 'pinia'
import { computed, ref } from 'vue'
import { api, type ProjectInput, type ProjectTaskInput } from '../api/client'
import type { ProjectDto, ProjectTaskDto } from '@shared/types'


export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<ProjectDto[]>([])
  const loaded = ref(false)
  const tasksByProject = ref<Record<string, ProjectTaskDto[]>>({})
  const selectedTaskIdsByProject = ref<Record<string, string[]>>({})
  let listening = false

  const activeProjects = computed(() => projects.value.filter((project) => !project.archived))

  function upsert(project: ProjectDto): void {
    const index = projects.value.findIndex((candidate) => candidate.id === project.id)
    if (index === -1) projects.value.unshift(project)
    else projects.value[index] = { ...projects.value[index], ...project }
  }

  function listen(): void {
    if (listening) return
    listening = true
    // Agents edit briefs and tasks during runs; keep open views current.
    api.projects.onUpdated(({ id }) => { void refreshProject(id) })
    api.projects.onTasksUpdated(({ projectId }) => {
      if (tasksByProject.value[projectId]) void loadTasks(projectId)
      void refreshProject(projectId)
    })
  }

  async function load(): Promise<void> {
    listen()
    projects.value = await api.projects.list(true)
    loaded.value = true
  }

  async function ensureLoaded(): Promise<void> {
    if (!loaded.value) await load()
  }

  async function refreshProject(id: string): Promise<void> {
    try {
      upsert(await api.projects.get(id))
    } catch {
      projects.value = projects.value.filter((project) => project.id !== id)
    }
  }

  function get(id: string | null | undefined): ProjectDto | undefined {
    return id ? projects.value.find((project) => project.id === id) : undefined
  }

  async function create(input: ProjectInput & { name: string }): Promise<ProjectDto> {
    const project = await api.projects.create(input)
    upsert(project)
    return project
  }

  async function update(id: string, input: ProjectInput): Promise<ProjectDto> {
    const project = await api.projects.update(id, input)
    upsert(project)
    return project
  }

  async function remove(id: string): Promise<void> {
    await api.projects.remove(id)
    projects.value = projects.value.filter((project) => project.id !== id)
    delete tasksByProject.value[id]
    delete selectedTaskIdsByProject.value[id]
  }

  async function loadTasks(projectId: string): Promise<ProjectTaskDto[]> {
    const tasks = await api.projects.listTasks(projectId)
    tasksByProject.value[projectId] = tasks
    setSelectedTasks(projectId, selectedTaskIdsByProject.value[projectId] ?? [])
    return tasks
  }

  function setSelectedTasks(projectId: string, ids: string[]): void {
    const available = new Set((tasksByProject.value[projectId] ?? []).map((task) => task.id))
    selectedTaskIdsByProject.value[projectId] = [...new Set(ids)].filter((id) => available.has(id))
  }

  function toggleTaskSelection(projectId: string, taskId: string): void {
    const ids = selectedTaskIdsByProject.value[projectId] ?? []
    setSelectedTasks(projectId, ids.includes(taskId) ? ids.filter((id) => id !== taskId) : [...ids, taskId])
  }

  function replaceTask(task: ProjectTaskDto): void {
    const tasks = tasksByProject.value[task.projectId] ?? []
    const index = tasks.findIndex((candidate) => candidate.id === task.id)
    tasksByProject.value[task.projectId] = index === -1 ? [...tasks, task] : tasks.map((candidate) => candidate.id === task.id ? task : candidate)
  }

  async function createTask(projectId: string, input: ProjectTaskInput & { title: string }): Promise<ProjectTaskDto> {
    const task = await api.projects.createTask(projectId, input)
    replaceTask(task)
    return task
  }

  async function updateTask(projectId: string, taskId: string, input: ProjectTaskInput): Promise<ProjectTaskDto> {
    const task = await api.projects.updateTask(projectId, taskId, input)
    replaceTask(task)
    return task
  }

  async function removeTask(projectId: string, taskId: string): Promise<void> {
    await api.projects.removeTask(projectId, taskId)
    tasksByProject.value[projectId] = (tasksByProject.value[projectId] ?? []).filter((task) => task.id !== taskId)
    setSelectedTasks(projectId, selectedTaskIdsByProject.value[projectId] ?? [])
  }

  return {
    projects, activeProjects, loaded, tasksByProject, selectedTaskIdsByProject, setSelectedTasks, toggleTaskSelection,
    load, ensureLoaded, refreshProject, get, create, update, remove,
    loadTasks, createTask, updateTask, removeTask,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useProjectsStore, import.meta.hot))
}
