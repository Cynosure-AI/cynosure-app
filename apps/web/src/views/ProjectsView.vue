<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import ModalDialog from '../components/shared/ModalDialog.vue'
import ProjectForm, { type ProjectDraft } from '../components/project/ProjectForm.vue'
import { useProjectsStore } from '../stores/projects.store'
import ProjectIcon from '../components/project/ProjectIcon.vue'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { DEFAULT_PROJECT_ICON, PROJECT_COLORS, formatRelativeTime } from '../utils/project-format'
import { useCynoStore } from '../stores/cyno.store'
import type { ProjectDto } from '@shared/types'

const cyno = useCynoStore()

const projectsStore = useProjectsStore()
const agentDefs = useAgentDefinitionsStore()
const route = useRoute()
const router = useRouter()

const showArchived = ref(false)
const createOpen = ref(false)
const creating = ref(false)
const createError = ref('')
const draft = ref<ProjectDraft>(emptyDraft())
const openMenuId = ref<string | null>(null)
const pendingDelete = ref<ProjectDto | null>(null)
const actionError = ref('')

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
    icon: DEFAULT_PROJECT_ICON,
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
      icon: draft.value.icon,
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
  return agentId ? (agentDefs.get(agentId)?.name ?? 'Unknown agent') : cyno.name
}

function toggleMenu(projectId: string): void {
  openMenuId.value = openMenuId.value === projectId ? null : projectId
}

function closeMenu(): void {
  openMenuId.value = null
}

function closeMenuOnEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeMenu()
}

function editProject(project: ProjectDto): void {
  closeMenu()
  void router.push({ name: 'project-detail', params: { id: project.id }, query: { tab: 'settings' } })
}

async function runAction(action: () => Promise<unknown>): Promise<void> {
  actionError.value = ''
  try {
    await action()
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function toggleArchived(project: ProjectDto): void {
  closeMenu()
  void runAction(() => projectsStore.update(project.id, { archived: !project.archived }))
}

function requestDelete(project: ProjectDto): void {
  closeMenu()
  pendingDelete.value = project
}

async function confirmDelete(): Promise<void> {
  const project = pendingDelete.value
  pendingDelete.value = null
  if (project) await runAction(() => projectsStore.remove(project.id))
}

watch(() => route.query.new, (value) => {
  if (value) openCreate()
}, { immediate: true })

onMounted(() => {
  document.addEventListener('click', closeMenu)
  document.addEventListener('keydown', closeMenuOnEscape)
  void projectsStore.load()
  if (!agentDefs.loaded) void agentDefs.load()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', closeMenu)
  document.removeEventListener('keydown', closeMenuOnEscape)
})
</script>

<template>
  <div class="h-full overflow-y-auto">
    <header class="page-header z-10 border-b border-theme-700/60 bg-page-header/95 py-4 backdrop-blur-sm sm:sticky sm:top-0 sm:py-5">
      <div class="mx-auto flex max-w-7xl flex-col gap-4 px-4 sm:flex-row sm:items-start sm:justify-between sm:px-6 lg:px-8">
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
          class="inline-flex h-10 shrink-0 items-center gap-2 self-start rounded-lg accent-action bg-accent-600 px-4 text-sm font-medium text-accent-on transition-colors hover:bg-accent-500"
          @click="openCreate"
        >
          <Icon
            icon="lucide:plus"
            class="h-4 w-4"
          />
          New project
        </button>
      </div>
    </header>

    <main class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
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

      <p
        v-if="actionError"
        role="alert"
        class="mb-4 text-sm text-status-danger"
      >
        {{ actionError }}
      </p>

      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <div
          v-for="project in visibleProjects"
          :key="project.id"
          class="group relative"
        >
          <RouterLink
            :to="{ name: 'project-detail', params: { id: project.id } }"
            class="relative flex h-full flex-col overflow-hidden rounded-xl border border-theme-700 bg-theme-800/70 p-4 transition-colors hover:border-theme-600 hover:bg-theme-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          >
            <span
              class="absolute inset-x-0 top-0 h-1"
              :style="{ backgroundColor: project.color || 'var(--color-accent-500)' }"
              aria-hidden="true"
            />
            <div class="flex items-center gap-3">
              <ProjectIcon
                :project="project"
                tile
                class="h-9 w-9"
              />
              <h2 class="min-w-0 flex-1 truncate pr-8 text-base font-semibold text-theme-100">
                {{ project.name }}
              </h2>
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

          <!-- Quick actions; a sibling of the card link so its buttons are not nested in it -->
          <div class="absolute right-3 top-5">
            <button
              type="button"
              class="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted opacity-0 transition hover:bg-theme-700 hover:text-theme-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 group-hover:opacity-100 max-md:opacity-100"
              :class="{ 'bg-theme-700 text-theme-100 opacity-100': openMenuId === project.id }"
              :aria-label="`${project.name} options`"
              aria-haspopup="menu"
              :aria-expanded="openMenuId === project.id"
              @click.stop="toggleMenu(project.id)"
            >
              <Icon
                icon="lucide:ellipsis-vertical"
                class="h-4 w-4"
              />
            </button>
            <div
              v-if="openMenuId === project.id"
              role="menu"
              class="absolute right-0 top-8 z-30 w-40 overflow-hidden rounded-lg border border-theme-700 bg-theme-900 py-1 shadow-xl"
              @click.stop
            >
              <button
                type="button"
                role="menuitem"
                class="flex w-full items-center gap-2 px-3 py-2 text-xs text-theme-300 hover:bg-theme-800"
                @click="editProject(project)"
              >
                <Icon
                  icon="lucide:pencil"
                  class="h-3.5 w-3.5"
                /> Edit
              </button>
              <button
                type="button"
                role="menuitem"
                class="flex w-full items-center gap-2 px-3 py-2 text-xs text-theme-300 hover:bg-theme-800"
                @click="toggleArchived(project)"
              >
                <Icon
                  :icon="project.archived ? 'lucide:archive-restore' : 'lucide:archive'"
                  class="h-3.5 w-3.5"
                /> {{ project.archived ? 'Restore' : 'Archive' }}
              </button>
              <button
                type="button"
                role="menuitem"
                class="flex w-full items-center gap-2 border-t border-theme-800 px-3 py-2 text-xs text-red-300 hover:bg-red-500/10"
                @click="requestDelete(project)"
              >
                <Icon
                  icon="lucide:trash-2"
                  class="h-3.5 w-3.5"
                /> Delete
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>


    <ModalDialog
      :show="Boolean(pendingDelete)"
      :title="`Delete ${pendingDelete?.name ?? 'project'}?`"
      icon="lucide:trash-2"
      icon-color="red"
      @close="pendingDelete = null"
    >
      <p class="text-sm text-theme-300">
        The project and its {{ pendingDelete?.openTaskCount ?? 0 }} open tasks are removed. Its {{ pendingDelete?.conversationCount ?? 0 }} chats stay in your chat list, and the memory folder stays in Memory.
      </p>
      <template #actions>
        <div class="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            class="rounded-lg px-3 py-2 text-sm text-theme-300 hover:bg-theme-800"
            @click="pendingDelete = null"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded-lg bg-status-danger px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
            @click="confirmDelete"
          >
            Delete project
          </button>
        </div>
      </template>
    </ModalDialog>

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
        <div class="flex flex-wrap justify-end gap-2">
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
        </div>
      </template>
    </ModalDialog>
  </div>
</template>
