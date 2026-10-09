<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import type { ProjectDto, ProjectTaskDto, ProjectTaskStatus } from '@shared/types'
import ModalDialog from '../shared/ModalDialog.vue'
import AgentSelect from '../shared/AgentSelect.vue'
import { useProjectsStore } from '../../stores/projects.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { TASK_COLUMNS } from '../../utils/project-format'
import { taskDraft, useProjectChat } from '../../composables/useProjectChat'

const props = defineProps<{ project: ProjectDto }>()

const projectsStore = useProjectsStore()
const agentDefs = useAgentDefinitionsStore()
const { startProjectChat } = useProjectChat()

const newTitle = ref('')
const error = ref('')
const draggingId = ref<string | null>(null)
const dropStatus = ref<ProjectTaskStatus | null>(null)
const editing = ref<(ProjectTaskDto & { assignee: string }) | null>(null)

const tasks = computed(() => projectsStore.tasksByProject[props.project.id] ?? [])
const columns = computed(() => TASK_COLUMNS.map((column) => ({
  ...column,
  tasks: tasks.value.filter((task) => task.status === column.status).sort((a, b) => a.sortOrder - b.sortOrder),
})))

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
  draggingId.value = task.id
  event.dataTransfer?.setData('text/plain', task.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDrop(status: ProjectTaskStatus, beforeTask?: ProjectTaskDto): void {
  const taskId = draggingId.value
  draggingId.value = null
  dropStatus.value = null
  const task = tasks.value.find((candidate) => candidate.id === taskId)
  if (!task) return
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
  void run(() => projectsStore.removeTask(props.project.id, task.id))
}

function startTaskChat(task: ProjectTaskDto & { assignee?: string }): void {
  editing.value = null
  // The editor's unsaved assignee choice wins; '' means the project default.
  const assignee = task.assignee !== undefined ? (task.assignee || null) : task.assigneeAgentId
  void startProjectChat(props.project, {
    agentId: assignee ?? props.project.defaultAgentId,
    draft: taskDraft(task),
  })
}

function agentName(agentId: string | null): string | null {
  return agentId ? (agentDefs.get(agentId)?.name ?? null) : null
}

watch(() => props.project.id, (id) => { void run(() => projectsStore.loadTasks(id)) })
onMounted(() => { void run(() => projectsStore.loadTasks(props.project.id)) })
</script>

<template>
  <div>
    <form
      class="mb-4 flex gap-2"
      @submit.prevent="addTask"
    >
      <input
        v-model="newTitle"
        type="text"
        maxlength="200"
        aria-label="New task title"
        placeholder="Add a task…"
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
        class="flex min-h-40 flex-col rounded-xl border bg-theme-900/60 p-2 transition-colors"
        :class="dropStatus === column.status ? 'border-accent-500/60' : 'border-theme-800'"
        :aria-label="column.label"
        @dragover.prevent="dropStatus = column.status"
        @dragleave="dropStatus = dropStatus === column.status ? null : dropStatus"
        @drop.prevent="onDrop(column.status)"
      >
        <header class="flex items-center gap-2 px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wider text-ink-muted">
          <Icon
            :icon="column.icon"
            class="h-3.5 w-3.5"
            :class="column.tone"
          />
          {{ column.label }}
          <span class="ml-auto rounded bg-theme-800 px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary">{{ column.tasks.length }}</span>
        </header>

        <ul class="flex flex-1 flex-col gap-2">
          <li
            v-for="task in column.tasks"
            :key="task.id"
            draggable="true"
            class="group cursor-grab rounded-lg border border-theme-700 bg-theme-800 p-2.5 shadow-sm transition hover:border-theme-600 active:cursor-grabbing"
            :class="{ 'opacity-40': draggingId === task.id }"
            @dragstart="onDragStart(task, $event)"
            @dragend="draggingId = null; dropStatus = null"
            @drop.prevent.stop="onDrop(column.status, task)"
          >
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
                v-if="task.notes"
                class="mt-1 line-clamp-2 block text-xs text-ink-muted"
              >{{ task.notes }}</span>
            </button>
            <div class="mt-2 flex items-center gap-1.5 text-[11px] text-ink-faint">
              <span
                v-if="task.createdBy === 'agent'"
                class="inline-flex items-center gap-1"
                title="Created by an agent"
              >
                <Icon
                  icon="lucide:sparkles"
                  class="h-3 w-3"
                />
              </span>
              <span
                v-if="agentName(task.assigneeAgentId)"
                class="inline-flex min-w-0 items-center gap-1"
              >
                <Icon
                  icon="lucide:bot"
                  class="h-3 w-3 shrink-0"
                />
                <span class="truncate">{{ agentName(task.assigneeAgentId) }}</span>
              </span>
              <RouterLink
                v-if="task.conversationId"
                :to="{ name: 'conversation', params: { conversationId: task.conversationId } }"
                class="inline-flex items-center gap-1 hover:text-theme-200"
                title="Open the chat working on this task"
              >
                <Icon
                  icon="lucide:message-square"
                  class="h-3 w-3"
                />
              </RouterLink>
              <span class="ml-auto flex gap-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  v-if="task.status !== 'done'"
                  type="button"
                  class="rounded p-1 hover:bg-theme-700 hover:text-theme-200"
                  :aria-label="`Start a chat for ${task.title}`"
                  title="Start a chat for this task"
                  @click="startTaskChat(task)"
                >
                  <Icon
                    icon="lucide:play"
                    class="h-3 w-3"
                  />
                </button>
                <button
                  v-if="task.status !== 'done'"
                  type="button"
                  class="rounded p-1 hover:bg-theme-700 hover:text-theme-200"
                  :aria-label="`Mark ${task.title} done`"
                  title="Mark done"
                  @click="moveTask(task, 'done')"
                >
                  <Icon
                    icon="lucide:check"
                    class="h-3 w-3"
                  />
                </button>
              </span>
            </div>
          </li>
        </ul>
      </section>
    </div>

    <ModalDialog
      :show="Boolean(editing)"
      title="Edit task"
      icon="lucide:square-kanban"
      max-width="max-w-lg"
      body-overflow-visible
      @close="editing = null"
    >
      <form
        v-if="editing"
        id="edit-task-form"
        class="space-y-4"
        @submit.prevent="saveEditor"
      >
        <div>
          <label
            for="task-title"
            class="mb-1.5 block text-sm text-ink-secondary"
          >Title</label>
          <input
            id="task-title"
            v-model="editing.title"
            type="text"
            maxlength="200"
            required
            class="w-full rounded-lg border border-theme-700 bg-theme-900 px-3 py-2 text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
          >
        </div>
        <div>
          <label
            for="task-notes"
            class="mb-1.5 block text-sm text-ink-secondary"
          >Notes</label>
          <textarea
            id="task-notes"
            v-model="editing.notes"
            rows="5"
            maxlength="4000"
            placeholder="Context an agent needs to do this without the original chat"
            class="w-full rounded-lg border border-theme-700 bg-theme-900 px-3 py-2 text-sm text-theme-200 placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent-500"
          />
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              for="task-status"
              class="mb-1.5 block text-sm text-ink-secondary"
            >Status</label>
            <select
              id="task-status"
              v-model="editing.status"
              class="w-full rounded-lg border border-theme-700 bg-theme-900 px-3 py-2 text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
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
          <div>
            <span class="mb-1.5 block text-sm text-ink-secondary">Assigned agent</span>
            <AgentSelect
              v-model="editing.assignee"
              :agents="agentDefs.agents"
              include-default
              default-label="Project default"
              agents-group-label="Agents"
              size="sm"
            />
          </div>
        </div>
      </form>
      <template #actions>
        <button
          type="button"
          class="mr-auto rounded-lg px-3 py-2 text-sm text-status-danger hover:bg-status-danger/10"
          @click="deleteEditing"
        >
          Delete
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
          class="rounded-lg accent-action bg-accent-500 px-3 py-2 text-sm font-semibold text-accent-on hover:bg-accent-400"
        >
          Save
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
