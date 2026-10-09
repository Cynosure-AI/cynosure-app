<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import ModalDialog from '../components/shared/ModalDialog.vue'
import ProjectForm, { type ProjectDraft } from '../components/project/ProjectForm.vue'
import { PROJECT_COLORS, useProjectsStore } from '../stores/projects.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { formatRelativeTime } from '../utils/project-format'

const projectsStore = useProjectsStore()
const agentDefs = useAgentDefinitionsStore()
const route = useRoute()
const router = useRouter()

const showArchived = ref(false)
const createOpen = ref(false)
const creating = ref(false)
const createError = ref('')
const draft = ref<ProjectDraft>(emptyDraft())

const visibleProjects = computed(() => projectsStore.projects.filter((project) => project.archived === showArchived.value))
const archivedCount = computed(() => projectsStore.projects.filter((project) => project.archived).length)

function emptyDraft(): ProjectDraft {
  return {
    name: '',
    description: '',
    instructions: '',
    rootPath: '',
    defaultAgentId: '',
    color: PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)],
    memoryFolderId: '',
    createMemoryFolder: true,
  }
}

function openCreate(): void {
  draft.value = emptyDraft()
  createError.value = ''
  createOpen.value = true
}

function closeCreate(): void {
  createOpen.value = false
  if (route.query.new) void router.replace({ name: 'projects' })
}

async function create(): Promise<void> {
  if (!draft.value.name.trim() || creating.value) return
  creating.value = true
  createError.value = ''
  try {
    const project = await projectsStore.create({
      name: draft.value.name.trim(),
      description: draft.value.description,
      rootPath: draft.value.rootPath,
      defaultAgentId: draft.value.defaultAgentId || null,
      color: draft.value.color,
      createMemoryFolder: draft.value.createMemoryFolder,
    })
    createOpen.value = false
    await router.push({ name: 'project-detail', params: { id: project.id } })
  } catch (cause) {
    createError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    creating.value = false
  }
}

function agentName(agentId: string | null): string {
  return agentId ? (agentDefs.get(agentId)?.name ?? 'Unknown agent') : 'Free Chat'
}

watch(() => route.query.new, (value) => {
  if (value) openCreate()
}, { immediate: true })

onMounted(() => {
  void projectsStore.load()
  if (!agentDefs.loaded) void agentDefs.load()
})
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header class="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <h1 class="text-2xl font-bold text-theme-100">
            Projects
          </h1>
          <p class="mt-1 max-w-2xl text-sm leading-relaxed text-ink-muted">
            A project groups chats around one goal. Every agent working in it sees the project instructions, its brief and open tasks, its memory folder, and its working folder.
          </p>
        </div>
        <button
          type="button"
          class="inline-flex shrink-0 items-center gap-2 rounded-lg accent-action bg-accent-500 px-3 py-2 text-sm font-semibold text-accent-on transition-colors hover:bg-accent-400"
          @click="openCreate"
        >
          <Icon
            icon="lucide:plus"
            class="h-4 w-4"
          />
          New project
        </button>
      </header>

      <div
        v-if="archivedCount"
        class="mb-4 flex gap-1 text-xs"
        role="tablist"
      >
        <button
          v-for="option in [{ value: false, label: 'Active' }, { value: true, label: `Archived (${archivedCount})` }]"
          :key="option.label"
          type="button"
          role="tab"
          :aria-selected="showArchived === option.value"
          class="rounded-md px-2.5 py-1 transition-colors"
          :class="showArchived === option.value ? 'bg-theme-800 text-theme-100' : 'text-ink-muted hover:text-theme-200'"
          @click="showArchived = option.value"
        >
          {{ option.label }}
        </button>
      </div>

      <div
        v-if="projectsStore.loaded && !visibleProjects.length"
        class="rounded-xl border border-dashed border-theme-700 px-6 py-14 text-center"
      >
        <Icon
          icon="lucide:folder-kanban"
          class="mx-auto mb-3 h-10 w-10 text-ink-faint"
        />
        <p class="text-sm font-medium text-theme-200">
          {{ showArchived ? 'No archived projects' : 'No projects yet' }}
        </p>
        <p
          v-if="!showArchived"
          class="mx-auto mt-1 max-w-md text-sm text-ink-muted"
        >
          Create one for work that spans several chats, such as a trip, a codebase, or a research topic.
        </p>
      </div>

      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <RouterLink
          v-for="project in visibleProjects"
          :key="project.id"
          :to="{ name: 'project-detail', params: { id: project.id } }"
          class="group relative flex flex-col overflow-hidden rounded-xl border border-theme-700 bg-theme-800/70 p-4 transition-colors hover:border-theme-600 hover:bg-theme-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
        >
          <span
            class="absolute inset-x-0 top-0 h-1"
            :style="{ backgroundColor: project.color || 'var(--color-accent-500)' }"
            aria-hidden="true"
          />
          <div class="flex items-start justify-between gap-3">
            <h2 class="min-w-0 truncate text-base font-semibold text-theme-100">
              {{ project.name }}
            </h2>
            <Icon
              v-if="project.rootPath"
              icon="lucide:folder-code"
              class="h-4 w-4 shrink-0 text-ink-muted"
              :title="project.rootPath"
            />
          </div>
          <p class="mt-1 line-clamp-2 min-h-10 text-sm text-ink-muted">
            {{ project.description || project.brief || 'No description' }}
          </p>
          <dl class="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
            <div class="flex items-center gap-1">
              <dt class="sr-only">
                Chats
              </dt>
              <Icon
                icon="lucide:message-square"
                class="h-3.5 w-3.5"
              />
              <dd>{{ project.conversationCount ?? 0 }}</dd>
            </div>
            <div class="flex items-center gap-1">
              <dt class="sr-only">
                Open tasks
              </dt>
              <Icon
                icon="lucide:square-kanban"
                class="h-3.5 w-3.5"
              />
              <dd>{{ project.openTaskCount ?? 0 }} open</dd>
            </div>
            <div class="flex items-center gap-1">
              <dt class="sr-only">
                Default agent
              </dt>
              <Icon
                icon="lucide:bot"
                class="h-3.5 w-3.5"
              />
              <dd class="max-w-28 truncate">
                {{ agentName(project.defaultAgentId) }}
              </dd>
            </div>
            <div
              v-if="project.lastActivityAt"
              class="ml-auto"
            >
              <dt class="sr-only">
                Last activity
              </dt>
              <dd>{{ formatRelativeTime(project.lastActivityAt) }}</dd>
            </div>
          </dl>
        </RouterLink>
      </div>
    </div>

    <ModalDialog
      :show="createOpen"
      title="New project"
      icon="lucide:folder-kanban"
      max-width="max-w-xl"
      body-overflow-visible
      @close="closeCreate"
    >
      <form
        id="create-project-form"
        @submit.prevent="create"
      >
        <ProjectForm
          v-model="draft"
          mode="create"
        />
        <p
          v-if="createError"
          role="alert"
          class="mt-3 text-sm text-status-danger"
        >
          {{ createError }}
        </p>
      </form>
      <template #actions>
        <button
          type="button"
          class="rounded-lg px-3 py-2 text-sm text-theme-300 hover:bg-theme-800"
          @click="closeCreate"
        >
          Cancel
        </button>
        <button
          type="submit"
          form="create-project-form"
          class="rounded-lg accent-action bg-accent-500 px-3 py-2 text-sm font-semibold text-accent-on hover:bg-accent-400 disabled:opacity-50"
          :disabled="!draft.name.trim() || creating"
        >
          {{ creating ? 'Creating…' : 'Create project' }}
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
