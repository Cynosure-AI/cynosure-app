<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import type { ProjectDto, ProjectTaskDto, ProjectTaskStatus } from '@shared/types'
import ModalDialog from '../shared/ModalDialog.vue'
import AgentSelect from '../shared/AgentSelect.vue'
import ProjectTaskWorkLog from './ProjectTaskWorkLog.vue'
import ProjectTaskAttachments from './ProjectTaskAttachments.vue'
import ProjectTaskContextMenu, { type TaskContextMenu } from './ProjectTaskContextMenu.vue'
import { api } from '../../api/client'
import { useProjectsStore } from '../../stores/projects.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { TASK_COLUMNS, formatRelativeTime } from '../../utils/project-format'
import { taskDraft, useProjectChat } from '../../composables/useProjectChat'

const props = defineProps<{ project: ProjectDto }>()

/** Done only grows; the newest few are what matters on the board. */
const DONE_PREVIEW_COUNT = 5

const projectsStore = useProjectsStore()
const agentDefs = useAgentDefinitionsStore()
const agentStore = useAgentStore()
const { startProjectChat } = useProjectChat()

const newTitle = ref('')
const error = ref('')
const draggingId = ref<string | null>(null)
const dropStatus = ref<ProjectTaskStatus | null>(null)
const dropBeforeId = ref<string | null>(null)
const showAllDone = ref(false)
const editing = ref<(ProjectTaskDto & { assignee: string }) | null>(null)
const contextMenu = ref<TaskContextMenu | null>(null)
let progressRefreshTimer: ReturnType<typeof setTimeout> | null = null
let stopPlanningListener: (() => void) | null = null

const tasks = computed(() => projectsStore.tasksByProject[props.project.id] ?? [])
const selectedIds = computed(() => projectsStore.selectedTaskIdsByProject[props.project.id] ?? [])
const selectedTasks = computed(() => tasks.value.filter((task) => selectedIds.value.includes(task.id)))
const bulkSelectMode = computed(() => selectedTasks.value.length > 0)
const visibleIds = computed(() => columns.value.flatMap((column) => column.tasks.map((task) => task.id)))
const allVisibleSelected = computed(() => visibleIds.value.length > 0 && visibleIds.value.every((id) => selectedIds.value.includes(id)))

function selectVisible(): void {
  projectsStore.setSelectedTasks(props.project.id, allVisibleSelected.value
    ? selectedIds.value.filter((id) => !visibleIds.value.includes(id))
    : [...selectedIds.value, ...visibleIds.value])
}

function onMoveSelected(event: Event): void {
  const select = event.target as HTMLSelectElement
  moveSelected(select.value as ProjectTaskStatus)
  select.value = ''
}

function moveSelected(status: ProjectTaskStatus): void {
  const projectId = props.project.id
  const selection = [...selectedTasks.value]
  void run(async () => {
    for (const task of selection) if (task.status !== status) await projectsStore.updateTask(projectId, task.id, { status })
  })
}

function onAssignSelected(event: Event): void {
  const select = event.target as HTMLSelectElement
  assignSelected(select.value || null)
  select.selectedIndex = 0
}

function assignSelected(assigneeAgentId: string | null): void {
  const projectId = props.project.id
  const selection = [...selectedTasks.value]
  void run(async () => {
    for (const task of selection) {
      if (task.assigneeAgentId !== assigneeAgentId) await projectsStore.updateTask(projectId, task.id, { assigneeAgentId })
    }
  })
}

function deleteSelected(): void {
  const projectId = props.project.id
  const selection = [...selectedTasks.value]
  void run(async () => {
    for (const task of selection) await projectsStore.removeTask(projectId, task.id)
  })
}

const columns = computed(() => TASK_COLUMNS.map((column) => {
  const all = tasks.value
    .filter((task) => task.status === column.status)
    .sort(column.status === 'done' ? byCompletion : (a, b) => a.sortOrder - b.sortOrder)
  const shown = column.status === 'done' && !showAllDone.value ? all.slice(0, DONE_PREVIEW_COUNT) : all
  return { ...column, tasks: shown, total: all.length, hidden: all.length - shown.length }
}))

const editingMeta = computed(() => {
  const task = editing.value
  if (!task) return ''
  const created = `${task.createdBy === 'agent' ? 'Created by an agent' : 'Created'} ${formatRelativeTime(task.createdAt)}`
  return task.completedAt ? `${created} · completed ${formatRelativeTime(task.completedAt)}` : created
})

/** Most recently finished first. */
function byCompletion(a: ProjectTaskDto, b: ProjectTaskDto): number {
  return (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt)
}

async function run(action: () => Promise<unknown>): Promise<void> {
  error.value = ''
  try {
    await action()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function addTask(): void {
  const title = newTitle.value.trim()
  if (!title) return
  newTitle.value = ''
  void run(() => projectsStore.createTask(props.project.id, { title }))
}

function onDragStart(task: ProjectTaskDto, event: DragEvent): void {
  contextMenu.value = null
  draggingId.value = task.id
  event.dataTransfer?.setData('text/plain', task.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(status: ProjectTaskStatus, beforeTask?: ProjectTaskDto | null): void {
  // Gaps between cards keep the last position (undefined) so the marker doesn't flicker.
  if (beforeTask !== undefined) dropBeforeId.value = beforeTask?.id ?? null
  else if (dropStatus.value !== status) dropBeforeId.value = null
  dropStatus.value = status
}

function onDragLeave(status: ProjectTaskStatus, event: DragEvent): void {
  // Moving onto a card also fires dragleave; only leaving the column counts.
  if ((event.currentTarget as Node).contains(event.relatedTarget as Node | null)) return
  if (dropStatus.value !== status) return
  dropStatus.value = null
  dropBeforeId.value = null
}

function clearDrag(): void {
  draggingId.value = null
  dropStatus.value = null
  dropBeforeId.value = null
}

function showsDropMarker(status: ProjectTaskStatus, beforeId: string | null): boolean {
  // Done is ordered by completion time, so a position there means nothing.
  return Boolean(draggingId.value) && status !== 'done' && dropStatus.value === status
    && dropBeforeId.value === beforeId && draggingId.value !== beforeId
}

function onDrop(status: ProjectTaskStatus, beforeTask?: ProjectTaskDto): void {
  const taskId = draggingId.value
  clearDrag()
  const task = tasks.value.find((candidate) => candidate.id === taskId)
  if (!task) return
  if (status === 'done') {
    if (task.status !== 'done') moveTask(task, 'done')
    return
  }
  const column = columns.value.find((candidate) => candidate.status === status)!.tasks.filter((candidate) => candidate.id !== task.id)
  // Place before the hovered card, or at the end of the column.
  const index = beforeTask ? column.findIndex((candidate) => candidate.id === beforeTask.id) : column.length
  const previous = column[index - 1]?.sortOrder
  const next = column[index]?.sortOrder
  const sortOrder = previous === undefined
    ? (next === undefined ? 1 : next - 1)
    : (next === undefined ? previous + 1 : (previous + next) / 2)
  if (task.status === status && task.sortOrder === sortOrder) return
  void run(() => projectsStore.updateTask(props.project.id, task.id, { status, sortOrder }))
}

function moveTask(task: ProjectTaskDto, status: ProjectTaskStatus): void {
  void run(() => projectsStore.updateTask(props.project.id, task.id, { status }))
}

function openEditor(task: ProjectTaskDto): void {
  editing.value = { ...task, assignee: task.assigneeAgentId ?? '' }
}

function onCardClick(task: ProjectTaskDto, event: MouseEvent): void {
  if (!bulkSelectMode.value || (event.target as HTMLElement).matches('input[type="checkbox"]')) return
  event.preventDefault()
  event.stopPropagation()
  projectsStore.toggleTaskSelection(props.project.id, task.id)
}

function saveEditor(): void {
  const task = editing.value
  if (!task || !task.title.trim()) return
  editing.value = null
  void run(() => projectsStore.updateTask(props.project.id, task.id, {
    title: task.title,
    notes: task.notes,
    status: task.status,
    assigneeAgentId: task.assignee || null,
  }))
}

function deleteEditing(): void {
  const task = editing.value
  if (!task) return
  editing.value = null
  deleteTask(task)
}

function deleteTask(task: ProjectTaskDto): void {
  void run(() => projectsStore.removeTask(props.project.id, task.id))
}

function assignTask(task: ProjectTaskDto, assigneeAgentId: string | null): void {
  if (task.assigneeAgentId === assigneeAgentId) return
  void run(() => projectsStore.updateTask(props.project.id, task.id, { assigneeAgentId }))
}

function openContextMenu(task: ProjectTaskDto, event: MouseEvent): void {
  // The context-menu key reports no pointer position; open at the card instead.
  const fromKeyboard = event.clientX === 0 && event.clientY === 0
  const card = (event.currentTarget as HTMLElement).getBoundingClientRect()
  contextMenu.value = {
    task,
    x: fromKeyboard ? card.left + 12 : event.clientX,
    y: fromKeyboard ? card.top + 12 : event.clientY,
  }
}

function startTaskChat(task: ProjectTaskDto & { assignee?: string }): void {
  editing.value = null
  // The editor's unsaved assignee choice wins; '' means the project default.
  const assignee = task.assignee !== undefined ? (task.assignee || null) : task.assigneeAgentId
  void startProjectChat(props.project, {
    agentId: assignee ?? props.project.defaultAgentId,
    draft: taskDraft(task),
    taskId: task.id,
  })
}

function agentName(agentId: string | null): string | null {
  return agentId ? (agentDefs.get(agentId)?.name ?? null) : null
}

function agentIconUrl(agentId: string | null): string | null {
  return agentId ? (agentDefs.get(agentId)?.iconUrl || null) : null
}

/** Notes that open by repeating the title would only show it twice. */
function notesPreview(task: ProjectTaskDto): string {
  const notes = task.notes.trim()
  const title = task.title.trim()
  if (!notes.toLowerCase().startsWith(title.toLowerCase())) return notes
  return notes.slice(title.length).replace(/^[\s.:;,–—-]+/, '')
}

function runState(task: ProjectTaskDto): 'running' | 'awaiting' | null {
  const conversationId = task.conversationId
  if (!conversationId) return null
  if (agentStore.awaitingHITLConvIds.has(conversationId)) return 'awaiting'
  return agentStore.isConversationExecuting(conversationId) ? 'running' : null
}

function showsProgress(task: ProjectTaskDto): boolean {
  return task.status !== 'done' && Boolean(task.progress?.total)
}

function progressTone(task: ProjectTaskDto): string {
  if (runState(task)) return 'bg-accent-500'
  return task.progress?.status === 'error' ? 'bg-status-warning' : 'bg-ink-muted'
}

function hasFooter(task: ProjectTaskDto): boolean {
  return task.status !== 'done' || Boolean(task.conversationId) || Boolean(agentName(task.assigneeAgentId))
}

/** Live run events only cover runs this window saw start; ask the server which task chats are running now. */
async function loadRunState(): Promise<void> {
  try {
    const running = new Set((await api.instances.list()).map((instance) => instance.conversationId))
    for (const task of tasks.value) {
      if (task.conversationId) agentStore.setConversationExecutionState(task.conversationId, running.has(task.conversationId))
    }
  } catch {
    // Non-critical; live run events still update the cards.
  }
}

async function loadBoard(projectId: string): Promise<void> {
  await run(() => projectsStore.loadTasks(projectId))
  await loadRunState()
}

watch(() => props.project.id, (id) => { void loadBoard(id) })
onMounted(() => {
  // Step updates don't touch the task rows, so refresh the cards whose run moved.
  stopPlanningListener = api.agent.onPlanningStateUpdated((data) => {
    const runId = (data as { runId?: string } | null)?.runId
    if (!runId || !tasks.value.some((task) => task.progress?.runId === runId)) return
    if (progressRefreshTimer) clearTimeout(progressRefreshTimer)
    progressRefreshTimer = setTimeout(() => { void run(() => projectsStore.loadTasks(props.project.id)) }, 250)
  })
  void loadBoard(props.project.id)
})
onBeforeUnmount(() => {
  if (progressRefreshTimer) clearTimeout(progressRefreshTimer)
  stopPlanningListener?.()
})
</script>

<template>
  <div>
    <form
      class="mb-4 flex max-w-2xl gap-2"
      @submit.prevent="addTask"
    >
      <input
        v-model="newTitle"
        type="text"
        maxlength="200"
        aria-label="New task title"
        placeholder="Add a task to To do…"
        class="min-w-0 flex-1 rounded-lg border border-theme-700 bg-theme-900 px-3 py-2 text-sm text-theme-200 placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent-500"
      >
      <button
        type="submit"
        class="inline-flex items-center gap-1.5 rounded-lg accent-action bg-accent-500 px-3 py-2 text-sm font-semibold text-accent-on hover:bg-accent-400 disabled:opacity-50"
        :disabled="!newTitle.trim()"
      >
        <Icon
          icon="lucide:plus"
          class="h-4 w-4"
        />
        Add
      </button>
    </form>

    <div
      class="mb-3 flex flex-wrap items-center gap-3 text-sm text-ink-secondary"
      role="group"
      aria-label="Task selection"
    >
      <label class="inline-flex items-center gap-2">
        <input
          type="checkbox"
          :checked="allVisibleSelected"
          :indeterminate="!allVisibleSelected && visibleIds.some((id) => selectedIds.includes(id))"
          @change="selectVisible"
        >
        Select visible tasks
      </label>
      <template v-if="selectedTasks.length">
        <span role="status">{{ selectedTasks.length }} selected</span>
        <select
          aria-label="Move selected tasks"
          class="rounded border border-theme-700 bg-theme-900 px-2 py-1"
          :value="''"
          @change="onMoveSelected"
        >
          <option
            disabled
            value=""
          >
            Move to…
          </option>
          <option
            v-for="column in TASK_COLUMNS"
            :key="column.status"
            :value="column.status"
          >
            {{ column.label }}
          </option>
        </select>
        <select
          aria-label="Assign selected tasks"
          class="rounded border border-theme-700 bg-theme-900 px-2 py-1"
          @change="onAssignSelected"
        >
          <option
            disabled
            selected
          >
            Assign agent…
          </option>
          <option value="">
            Project default
          </option>
          <option
            v-for="agent in agentDefs.agents"
            :key="agent.id"
            :value="agent.id"
          >
            {{ agent.name }}
          </option>
        </select>
        <button
          type="button"
          class="text-status-danger"
          @click="deleteSelected"
        >
          Delete selected
        </button>
        <button
          type="button"
          @click="projectsStore.setSelectedTasks(project.id, [])"
        >
          Clear selection
        </button>
      </template>
    </div>

    <p
      v-if="error"
      role="alert"
      class="mb-3 text-sm text-status-danger"
    >
      {{ error }}
    </p>

    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <section
        v-for="column in columns"
        :key="column.status"
        class="flex min-h-40 min-w-0 flex-col rounded-xl border bg-theme-900/60 p-2 transition-colors"
        :class="dropStatus === column.status ? 'border-accent-500/60' : 'border-theme-800'"
        :aria-label="column.label"
        @dragover.prevent="onDragOver(column.status)"
        @dragleave="onDragLeave(column.status, $event)"
        @drop.prevent="onDrop(column.status)"
      >
        <header class="flex items-center gap-2 px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wider text-ink-muted">
          <Icon
            :icon="column.icon"
            class="h-3.5 w-3.5"
            :class="column.tone"
          />
          {{ column.label }}
          <span class="ml-auto rounded bg-theme-800 px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary">{{ column.total }}</span>
        </header>

        <ul class="flex flex-1 flex-col gap-2">
          <li
            v-if="!column.total"
            class="rounded-lg border border-dashed px-3 py-6 text-center text-xs transition-colors"
            :class="dropStatus === column.status ? 'border-accent-500/60 text-ink-secondary' : 'border-theme-700 text-ink-faint'"
          >
            {{ column.empty }}
          </li>

          <li
            v-for="task in column.tasks"
            :key="task.id"
            draggable="true"
            class="group relative flex rounded-lg border border-theme-700 bg-theme-800 shadow-sm transition hover:border-theme-600"
            :class="{
              'opacity-40': draggingId === task.id,
              'ring-2 ring-accent-500': selectedIds.includes(task.id),
              'cursor-pointer': bulkSelectMode,
              'cursor-grab active:cursor-grabbing': !bulkSelectMode,
              'before:absolute before:inset-x-0 before:-top-1.25 before:h-0.5 before:rounded-full before:bg-accent-500': showsDropMarker(column.status, task.id),
            }"
            @click.capture="onCardClick(task, $event)"
            @contextmenu.prevent="openContextMenu(task, $event)"
            @dragstart="onDragStart(task, $event)"
            @dragend="clearDrag"
            @dragover.prevent.stop="onDragOver(column.status, task)"
            @drop.prevent.stop="onDrop(column.status, task)"
          >
            <input
              type="checkbox"
              class="ml-2 mt-3 h-4 w-4 shrink-0 accent-accent-500 transition-opacity"
              :class="{ 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100': !bulkSelectMode }"
              :aria-label="`Select ${task.title}`"
              :checked="selectedIds.includes(task.id)"
              @click.stop
              @change="projectsStore.toggleTaskSelection(project.id, task.id)"
            >
            <!-- Main task content -->
            <div class="min-w-0 flex-1 p-2.5">
              <button
                type="button"
                class="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                @click="openEditor(task)"
              >
                <span
                  class="block text-sm text-theme-200"
                  :class="{ 'text-ink-muted line-through': task.status === 'done' }"
                >{{ task.title }}</span>
                <span
                  v-if="notesPreview(task)"
                  class="mt-1 line-clamp-2 text-xs [overflow-wrap:anywhere]"
                  :class="task.status === 'done' ? 'text-ink-faint' : 'text-ink-muted'"
                >{{ notesPreview(task) }}</span>
              </button>

              <a
                v-if="task.imageAttachmentId"
                :href="api.projects.taskAttachmentHref(project.id, task.id, task.imageAttachmentId)"
                :aria-label="`Open image attachment for ${task.title}`"
                target="_blank"
                rel="noopener"
                draggable="false"
                class="mt-2 block w-fit rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
              >
                <img
                  :src="api.projects.taskAttachmentHref(project.id, task.id, task.imageAttachmentId)"
                  :alt="`Image attachment for ${task.title}`"
                  loading="lazy"
                  draggable="false"
                  width="64"
                  height="48"
                  class="h-12 w-16 rounded object-cover"
                >
              </a>

              <!-- Agent and progress metadata -->
              <div
                v-if="task.attachmentCount || (hasFooter(task) && (agentName(task.assigneeAgentId) || showsProgress(task)))"
                class="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-ink-muted"
              >
                <span
                  v-if="agentName(task.assigneeAgentId)"
                  class="inline-flex min-w-0 items-center gap-1"
                  :title="`Assigned to ${agentName(task.assigneeAgentId)}`"
                >
                  <img
                    v-if="agentIconUrl(task.assigneeAgentId)"
                    :src="agentIconUrl(task.assigneeAgentId)!"
                    :alt="`${agentName(task.assigneeAgentId)} icon`"
                    class="h-3 w-3 shrink-0 rounded object-cover"
                  >
                  <Icon
                    v-else
                    icon="lucide:bot"
                    class="h-3 w-3 shrink-0"
                  />
                  <span class="truncate">{{ agentName(task.assigneeAgentId) }}</span>
                </span>

                <span
                  v-if="task.attachmentCount"
                  class="inline-flex shrink-0 items-center gap-0.5 tabular-nums"
                  :title="`${task.attachmentCount} attachment${task.attachmentCount === 1 ? '' : 's'}`"
                >
                  <Icon
                    icon="lucide:paperclip"
                    class="h-3 w-3"
                  />
                  {{ task.attachmentCount }}
                </span>

                <span
                  v-if="showsProgress(task)"
                  class="inline-flex shrink-0 items-center gap-1.5 tabular-nums"
                  :title="`${task.progress!.completed} of ${task.progress!.total} steps done in the latest run`"
                >
                  <span class="h-1 w-10 overflow-hidden rounded-full bg-theme-700">
                    <span
                      class="block h-full rounded-full transition-[width]"
                      :class="progressTone(task)"
                      :style="{ width: `${(task.progress!.completed / task.progress!.total) * 100}%` }"
                    />
                  </span>
                  {{ task.progress!.completed }}/{{ task.progress!.total }}
                </span>
              </div>
            </div>

            <!-- Right-side chat action bar: fixed 48px -->
            <div
              v-if="task.conversationId || task.status !== 'done'"
              class="flex w-12 shrink-0 flex-col self-stretch rounded-r-lg border-l border-theme-700 bg-theme-900/40"
            >
              <!-- Open existing chat -->
              <RouterLink
                v-if="task.conversationId"
                :to="{ name: 'conversation', params: { conversationId: task.conversationId } }"
                class="inline-flex min-h-10 w-full flex-1 items-center justify-center rounded-tr-lg text-ink-secondary transition-colors hover:bg-theme-700 hover:text-theme-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500"
                :class="{
                  'text-accent-fg': runState(task) === 'running',
                  'text-status-warning': runState(task) === 'awaiting',
                }"
                :aria-label="`Open chat for ${task.title}`"
                :title="runState(task) === 'awaiting'
                  ? 'The chat on this task is waiting for your approval'
                  : 'Open the chat working on this task'"
              >
                <span
                  v-if="runState(task) === 'running'"
                  class="relative flex h-2 w-2"
                >
                  <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-400 opacity-75" />
                  <span class="relative inline-flex h-2 w-2 rounded-full bg-accent-500" />
                </span>
                <Icon
                  v-else
                  :icon="runState(task) === 'awaiting' ? 'lucide:hand' : 'lucide:message-square'"
                  class="h-4 w-4"
                />
              </RouterLink>

              <!-- Start new chat -->
              <button
                v-if="task.status !== 'done'"
                type="button"
                class="inline-flex min-h-10 w-full flex-1 items-center justify-center rounded-br-lg text-accent-fg transition-colors hover:bg-accent-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500"
                :class="{
                  'border-t border-theme-700': task.conversationId,
                  'rounded-tr-lg': !task.conversationId,
                }"
                :aria-label="`Start a chat for ${task.title}`"
                title="Start a chat for this task"
                @click="startTaskChat(task)"
              >
                <Icon
                  icon="lucide:play"
                  class="h-4 w-4"
                />
              </button>
            </div>
          </li>

          <!-- Dropping below the last card puts the task at the end. -->
          <li
            aria-hidden="true"
            class="relative min-h-4 flex-1"
            @dragover.prevent.stop="onDragOver(column.status, null)"
            @drop.prevent.stop="onDrop(column.status)"
          >
            <span
              v-if="column.total && showsDropMarker(column.status, null)"
              class="absolute inset-x-0 -top-1.25 h-0.5 rounded-full bg-accent-500"
            />
          </li>
        </ul>

        <button
          v-if="column.status === 'done' && column.total > DONE_PREVIEW_COUNT"
          type="button"
          class="mt-1 inline-flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs text-ink-muted hover:bg-theme-800 hover:text-theme-200"
          :aria-expanded="showAllDone"
          @click="showAllDone = !showAllDone"
        >
          <Icon
            :icon="showAllDone ? 'lucide:chevron-up' : 'lucide:chevron-down'"
            class="h-3.5 w-3.5"
          />
          {{ showAllDone ? 'Show fewer' : `+${column.hidden} more` }}
        </button>
      </section>
    </div>

    <ProjectTaskContextMenu
      :menu="contextMenu"
      :agents="agentDefs.agents"
      @close="contextMenu = null"
      @run="startTaskChat"
      @assign="assignTask"
      @done="moveTask($event, 'done')"
      @delete="deleteTask"
    />

    <ModalDialog
      :show="Boolean(editing)"
      title="Edit task"
      icon="lucide:square-kanban"
      max-width="max-w-5xl"
      @close="editing = null"
    >
      <template #header-actions>
        <button
          type="button"
          class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted transition hover:bg-theme-800 hover:text-theme-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          aria-label="Close task editor"
          @click="editing = null"
        >
          <Icon
            icon="lucide:x"
            class="h-4 w-4"
          />
        </button>
      </template>
      <form
        v-if="editing"
        id="edit-task-form"
        class="min-w-0 space-y-5 pr-1"
        @submit.prevent="saveEditor"
      >
        <div class="space-y-2 border-b border-theme-800 pb-5">
          <label
            for="task-title"
            class="block text-xs font-medium text-ink-secondary"
          >Title</label>
          <textarea
            id="task-title"
            v-model="editing.title"
            rows="2"
            maxlength="200"
            required
            class="block min-h-12 w-full resize-none rounded-lg border border-theme-800 bg-theme-950/30 px-3 py-2.5 text-lg font-medium leading-relaxed text-theme-100 [field-sizing:content] focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
          />
          <p class="text-xs leading-5 text-ink-muted">
            {{ editingMeta }}
          </p>
        </div>
        <div class="grid min-w-0 items-start gap-5 md:grid-cols-[minmax(0,1fr)_15rem] lg:grid-cols-[minmax(0,1fr)_17rem]">
          <div class="min-w-0">
            <label
              for="task-notes"
              class="mb-2 flex items-center gap-2 text-sm font-medium text-ink-secondary"
            >
              <Icon
                icon="lucide:align-left"
                class="h-4 w-4"
              />
              Notes
            </label>
            <textarea
              id="task-notes"
              v-model="editing.notes"
              rows="12"
              maxlength="4000"
              placeholder="Context an agent needs to do this without the original chat"
              class="block min-h-48 max-h-[50vh] w-full resize-y rounded-xl border border-theme-700 bg-theme-950/30 px-4 py-3 text-sm leading-relaxed text-theme-200 placeholder:text-ink-faint focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
            />
          </div>
          <div class="min-w-0 space-y-5 md:col-start-2 md:row-span-2 md:row-start-1">
            <section
              aria-label="Task details"
              class="space-y-4 rounded-xl border border-theme-800 bg-theme-950/30 p-4"
            >
              <h4 class="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                Task details
              </h4>
              <div>
                <label
                  for="task-status"
                  class="mb-2 block text-xs font-medium text-ink-secondary"
                >Status</label>
                <select
                  id="task-status"
                  v-model="editing.status"
                  class="h-9 w-full rounded-lg border border-theme-700 bg-theme-900 px-3 text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                  <option
                    v-for="column in TASK_COLUMNS"
                    :key="column.status"
                    :value="column.status"
                  >
                    {{ column.label }}
                  </option>
                </select>
              </div>
              <fieldset class="min-w-0">
                <legend class="mb-2 text-xs font-medium text-ink-secondary">
                  Assigned agent
                </legend>
                <AgentSelect
                  v-model="editing.assignee"
                  :agents="agentDefs.agents"
                  include-default
                  default-label="Project default"
                  agents-group-label="Agents"
                  max-height="max-h-48"
                  size="sm"
                />
              </fieldset>
            </section>
            <ProjectTaskAttachments
              :project-id="project.id"
              :task-id="editing.id"
            />
          </div>
          <ProjectTaskWorkLog
            class="min-w-0 md:col-start-1 md:row-start-2"
            :project-id="project.id"
            :task-id="editing.id"
          />
        </div>
      </form>
      <template #actions>
        <div class="flex flex-wrap items-center gap-2 border-t border-theme-800 pt-4">
          <button
            type="button"
            class="mr-auto inline-flex items-center gap-1.5 rounded-lg border border-transparent px-2 py-2 text-sm text-status-danger hover:bg-status-danger/10 sm:px-3"
            aria-label="Delete task"
            title="Delete task"
            @click="deleteEditing"
          >
            <Icon
              icon="lucide:trash-2"
              class="h-3.5 w-3.5"
            />
            <span class="hidden sm:inline">Delete</span>
          </button>
          <button
            type="button"
            class="hidden rounded-lg px-3 py-2 text-sm text-ink-secondary transition hover:bg-theme-800 hover:text-theme-100 sm:inline-flex"
            @click="editing = null"
          >
            Cancel
          </button>
          <button
            v-if="editing && editing.status !== 'done'"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-theme-700 px-3 py-2 text-sm text-theme-300 hover:bg-theme-800"
            @click="editing && startTaskChat(editing)"
          >
            <Icon
              icon="lucide:play"
              class="h-3.5 w-3.5"
            />
            Start chat
          </button>
          <button
            type="submit"
            form="edit-task-form"
            class="rounded-lg border border-transparent accent-action bg-accent-500 px-3 py-2 text-sm font-semibold text-accent-on hover:bg-accent-400"
          >
            Save
          </button>
        </div>
      </template>
    </ModalDialog>
  </div>
</template>
