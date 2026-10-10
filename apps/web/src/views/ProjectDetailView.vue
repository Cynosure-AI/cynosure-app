<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import TabBar, { type TabDef } from '../components/shared/TabBar.vue'
import BaseCard from '../components/shared/BaseCard.vue'
import ModalDialog from '../components/shared/ModalDialog.vue'
import ProjectBoard from '../components/project/ProjectBoard.vue'
import ProjectTimeline from '../components/project/ProjectTimeline.vue'
import ProjectIcon from '../components/project/ProjectIcon.vue'
import ProjectForm, { type ProjectDraft } from '../components/project/ProjectForm.vue'
import RichContent from '../components/shared/RichContent.vue'
import { api, type ConversationRow } from '../api/client'
import type { CronJob } from '../api/types'
import { useProjectsStore } from '../stores/projects.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useChatStore } from '../stores/chat.store'
import { useProjectChat } from '../composables/useProjectChat'
import { formatRelativeTime } from '../utils/project-format'
import { cronToHuman } from '../utils/cron-helpers'

type ProjectTab = 'overview' | 'chats' | 'board' | 'timeline' | 'settings'

const route = useRoute()
const router = useRouter()
const projectsStore = useProjectsStore()
const agentDefs = useAgentDefinitionsStore()
const chatStore = useChatStore()
const { startProjectChat } = useProjectChat()

const projectId = computed(() => route.params.id as string)
const project = computed(() => projectsStore.get(projectId.value))
const activeTab = ref<ProjectTab>(tabFromQuery())
const conversations = ref<ConversationRow[]>([])
const cronJobs = ref<CronJob[]>([])
const editingBrief = ref(false)
const briefDraft = ref('')
const settingsDraft = ref<ProjectDraft | null>(null)
const settingsSaved = ref(false)
const saving = ref(false)
const error = ref('')
const confirmDelete = ref(false)

const memoryFolder = computed(() => chatStore.memoryFolders.find((folder) => folder.id === project.value?.memoryFolderId))
const tabs = computed<TabDef<ProjectTab>[]>(() => [
  { value: 'overview', label: 'Overview', icon: 'lucide:layout-dashboard' },
  { value: 'chats', label: 'Chats', icon: 'lucide:message-square', badge: project.value?.conversationCount || undefined },
  { value: 'board', label: 'Board', icon: 'lucide:square-kanban', badge: project.value?.openTaskCount || undefined },
  { value: 'timeline', label: 'Timeline', icon: 'lucide:history' },
  { value: 'settings', label: 'Settings', icon: 'lucide:settings' },
])

function tabFromQuery(): ProjectTab {
  const tab = route.query.tab
  return tab === 'chats' || tab === 'board' || tab === 'timeline' || tab === 'settings' ? tab : 'overview'
}

function agentIconUrl(agentId: string | null): string | null {
  return agentId ? (agentDefs.get(agentId)?.iconUrl || null) : null
}

function agentName(agentId: string | null): string {
  return agentId ? (agentDefs.get(agentId)?.name ?? 'Unknown agent') : 'Free Chat'
}

function toDraft(): ProjectDraft | null {
  const current = project.value
  if (!current) return null
  return {
    name: current.name,
    description: current.description,
    instructions: current.instructions,
    rootPath: current.rootPath,
    defaultAgentId: current.defaultAgentId ?? '',
    color: current.color,
    icon: current.icon,
    memoryFolderId: current.memoryFolderId ?? '',
    createMemoryFolder: false,
  }
}

async function guarded(action: () => Promise<unknown>): Promise<boolean> {
  saving.value = true
  error.value = ''
  settingsSaved.value = false
  try {
    await action()
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    return false
  } finally {
    saving.value = false
  }
}

async function loadRelated(): Promise<void> {
  const id = projectId.value
  const [rows, jobs] = await Promise.allSettled([api.chat.listProjectConversations(id), api.cronJobs.list()])
  if (id !== projectId.value) return
  if (rows.status === 'fulfilled') conversations.value = rows.value
  if (jobs.status === 'fulfilled') cronJobs.value = jobs.value.filter((job) => job.projectId === id)
}

function startBriefEdit(): void {
  briefDraft.value = project.value?.brief ?? ''
  editingBrief.value = true
}

async function saveBrief(): Promise<void> {
  if (await guarded(() => projectsStore.update(projectId.value, { brief: briefDraft.value }))) editingBrief.value = false
}

async function saveSettings(): Promise<void> {
  const draft = settingsDraft.value
  if (!draft?.name.trim()) return
  settingsSaved.value = await guarded(() => projectsStore.update(projectId.value, {
    name: draft.name.trim(),
    description: draft.description,
    instructions: draft.instructions,
    rootPath: draft.rootPath,
    defaultAgentId: draft.defaultAgentId || null,
    memoryFolderId: draft.memoryFolderId || null,
    color: draft.color,
    icon: draft.icon,
  }))
}

async function toggleArchived(): Promise<void> {
  if (project.value) await guarded(() => projectsStore.update(projectId.value, { archived: !project.value!.archived }))
}

async function deleteProject(): Promise<void> {
  confirmDelete.value = false
  if (await guarded(() => projectsStore.remove(projectId.value))) await router.push({ name: 'projects' })
}

async function openConversation(row: ConversationRow): Promise<void> {
  await chatStore.selectConversation(row.id, row.agent_id)
  await router.push({ name: 'conversation', params: { conversationId: row.id } })
}

function newChat(): void {
  if (project.value) void startProjectChat(project.value)
}

watch(activeTab, (tab) => {
  if (tab === 'settings') settingsDraft.value = toDraft()
  void router.replace({ query: { ...route.query, tab: tab === 'overview' ? undefined : tab } })
})

watch(projectId, () => {
  activeTab.value = tabFromQuery()
  editingBrief.value = false
  settingsSaved.value = false
  error.value = ''
  void loadRelated()
})

watch(settingsDraft, () => { settingsSaved.value = false }, { deep: true })

// A new project's memory folder is created after the chat store loaded its folder list.
watch(() => project.value?.memoryFolderId, (folderId) => {
  if (folderId && !chatStore.memoryFolders.some((folder) => folder.id === folderId)) void chatStore.loadMemoryFolders()
}, { immediate: true })

watch(() => project.value?.updatedAt, () => {
  // Keep the settings form in sync when it is not being edited elsewhere.
  if (activeTab.value === 'settings' && !saving.value) settingsDraft.value = toDraft()
})

onMounted(async () => {
  if (!agentDefs.loaded) void agentDefs.load()
  await projectsStore.ensureLoaded()
  if (!project.value) await projectsStore.refreshProject(projectId.value)
  if (!project.value) {
    await router.replace({ name: 'projects' })
    return
  }
  if (activeTab.value === 'settings') settingsDraft.value = toDraft()
  void loadRelated()
})
</script>

<template>
  <div
    v-if="project"
    class="h-full overflow-y-auto"
  >
    <header class="page-header relative z-20 border-b border-theme-800/60 bg-theme-950/95 pt-4 backdrop-blur-sm sm:sticky sm:top-0 sm:pt-5">
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div class="flex items-start justify-between gap-3">
          <RouterLink
            :to="{ name: 'projects' }"
            class="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-ink-muted transition-colors hover:bg-theme-800 hover:text-theme-300"
          >
            <Icon
              icon="lucide:arrow-left"
              class="h-4 w-4"
            />
            Projects
          </RouterLink>
          <button
            type="button"
            class="inline-flex shrink-0 items-center gap-2 rounded-lg accent-action bg-accent-500 px-3 py-2 text-sm font-semibold text-accent-on transition-colors hover:bg-accent-400"
            @click="newChat"
          >
            <Icon
              icon="lucide:message-circle-plus"
              class="h-4 w-4"
            />
            New chat
          </button>
        </div>

        <div class="mt-2 flex min-w-0 items-center gap-3">
          <ProjectIcon
            :project="project"
            tile
            class="h-12 w-12"
          />
          <div class="min-w-0">
            <h1 class="flex items-center gap-2 break-words text-2xl font-bold leading-tight text-theme-100">
              {{ project.name }}
              <span
                v-if="project.archived"
                class="rounded bg-theme-800 px-1.5 py-0.5 text-xs font-medium text-ink-muted"
              >Archived</span>
            </h1>
            <p
              v-if="project.description"
              class="mt-1 line-clamp-2 text-sm leading-relaxed text-ink-muted"
            >
              {{ project.description }}
            </p>
          </div>
        </div>

        <TabBar
          v-model="activeTab"
          :tabs="tabs"
          class="mt-4"
        />
      </div>
    </header>

    <main class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <p
        v-if="error && activeTab !== 'settings'"
        role="alert"
        class="mb-4 rounded-lg bg-status-danger/10 px-3 py-2 text-sm text-status-danger"
      >
        {{ error }}
      </p>

      <!-- Overview -->
      <div
        v-if="activeTab === 'overview'"
        class="grid gap-6 lg:grid-cols-3"
      >
        <BaseCard class="p-5 lg:col-span-2">
          <div class="mb-3 flex items-start justify-between gap-3">
            <div>
              <h2 class="text-base font-semibold text-theme-100">
                Brief
              </h2>
              <p class="mt-0.5 text-xs text-ink-muted">
                Goal, current state, decisions, and open questions. Every agent in this project reads it, and agents keep it up to date.
                <template v-if="project.briefUpdatedAt">
                  Updated {{ formatRelativeTime(project.briefUpdatedAt) }}.
                </template>
              </p>
            </div>
            <div
              v-if="!editingBrief"
              class="flex shrink-0 gap-1.5"
            >
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg border border-theme-700 px-2.5 py-1.5 text-xs text-theme-300 hover:bg-theme-800"
                title="How the brief and project changed over time"
                @click="activeTab = 'timeline'"
              >
                <Icon
                  icon="lucide:history"
                  class="h-3.5 w-3.5"
                />
                History
              </button>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg border border-theme-700 px-2.5 py-1.5 text-xs text-theme-300 hover:bg-theme-800"
                @click="startBriefEdit"
              >
                <Icon
                  icon="lucide:pencil"
                  class="h-3.5 w-3.5"
                />
                Edit
              </button>
            </div>
          </div>

          <form
            v-if="editingBrief"
            class="space-y-3"
            @submit.prevent="saveBrief"
          >
            <textarea
              v-model="briefDraft"
              rows="14"
              maxlength="6000"
              aria-label="Project brief"
              class="w-full rounded-lg border border-theme-700 bg-theme-900 px-3 py-2 font-mono text-xs leading-relaxed text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
            />
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="rounded-lg px-3 py-1.5 text-sm text-theme-300 hover:bg-theme-800"
                @click="editingBrief = false"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="rounded-lg accent-action bg-accent-500 px-3 py-1.5 text-sm font-semibold text-accent-on hover:bg-accent-400 disabled:opacity-50"
                :disabled="saving"
              >
                Save brief
              </button>
            </div>
          </form>
          <div
            v-else-if="project.brief"
            class="prose-sm text-sm text-theme-200"
          >
            <RichContent :content="project.brief" />
          </div>
          <p
            v-else
            class="rounded-lg border border-dashed border-theme-700 px-4 py-6 text-center text-sm text-ink-muted"
          >
            No brief yet. Agents write one once the goal is clear, or you can start it yourself.
          </p>
        </BaseCard>

        <div class="space-y-4">
          <BaseCard class="space-y-3 p-5 text-sm">
            <h2 class="text-base font-semibold text-theme-100">
              Context for agents
            </h2>
            <div class="flex items-start gap-2">
              <Icon
                icon="lucide:bot"
                class="mt-0.5 h-4 w-4 shrink-0 text-ink-muted"
              />
              <div>
                <div class="text-ink-muted">
                  Default agent
                </div>
                <div class="text-theme-200">
                  {{ agentName(project.defaultAgentId) }}
                </div>
              </div>
            </div>
            <div class="flex items-start gap-2">
              <Icon
                icon="lucide:database"
                class="mt-0.5 h-4 w-4 shrink-0 text-ink-muted"
              />
              <div class="min-w-0">
                <div class="text-ink-muted">
                  Memory folder
                </div>
                <RouterLink
                  v-if="memoryFolder"
                  :to="{ name: 'memory-folders', params: { section: 'documents' }, query: { folder: memoryFolder.id } }"
                  class="block truncate text-theme-200 hover:text-accent-fg"
                >
                  {{ memoryFolder.folderPath || memoryFolder.name }}
                </RouterLink>
                <div
                  v-else
                  class="text-ink-faint"
                >
                  None
                </div>
              </div>
            </div>
            <div class="flex items-start gap-2">
              <Icon
                icon="lucide:folder-code"
                class="mt-0.5 h-4 w-4 shrink-0 text-ink-muted"
              />
              <div class="min-w-0">
                <div class="text-ink-muted">
                  Project folder
                </div>
                <div
                  class="break-all font-mono text-xs"
                  :class="project.rootPath ? 'text-theme-200' : 'text-ink-faint'"
                >
                  {{ project.rootPath || 'None' }}
                </div>
              </div>
            </div>
            <div class="flex items-start gap-2">
              <Icon
                icon="lucide:scroll-text"
                class="mt-0.5 h-4 w-4 shrink-0 text-ink-muted"
              />
              <div class="min-w-0">
                <div class="text-ink-muted">
                  Instructions
                </div>
                <p
                  class="line-clamp-4 whitespace-pre-line text-xs"
                  :class="project.instructions ? 'text-theme-300' : 'text-ink-faint'"
                >
                  {{ project.instructions || 'None' }}
                </p>
              </div>
            </div>
            <button
              type="button"
              class="text-xs text-accent-fg hover:underline"
              @click="activeTab = 'settings'"
            >
              Edit project settings
            </button>
          </BaseCard>

          <BaseCard
            v-if="cronJobs.length"
            class="space-y-2 p-5 text-sm"
          >
            <h2 class="text-base font-semibold text-theme-100">
              Scheduled jobs
            </h2>
            <RouterLink
              v-for="job in cronJobs"
              :key="job.id"
              :to="{ name: 'cron-detail', params: { id: job.id } }"
              class="flex items-center gap-2 rounded-md px-2 py-1.5 text-theme-300 hover:bg-theme-800"
            >
              <Icon
                icon="lucide:calendar-clock"
                class="h-4 w-4 shrink-0"
                :class="job.enabled ? 'text-status-info' : 'text-ink-faint'"
              />
              <span class="min-w-0 flex-1">
                <span class="block truncate">{{ job.name || job.prompt || 'Scheduled job' }}</span>
                <span
                  class="block truncate text-[11px] text-ink-muted"
                  :title="job.schedule"
                >{{ cronToHuman(job.schedule) }}{{ job.enabled ? '' : ' · Paused' }}</span>
              </span>
            </RouterLink>
          </BaseCard>
        </div>
      </div>

      <!-- Chats -->
      <div v-else-if="activeTab === 'chats'">
        <div
          v-if="!conversations.length"
          class="rounded-xl border border-dashed border-theme-700 px-6 py-12 text-center text-sm text-ink-muted"
        >
          No chats yet. Start one here, or move an existing chat in with the project button in the chat header.
        </div>
        <ul
          v-else
          class="divide-y divide-theme-800 overflow-hidden rounded-xl border border-theme-800"
        >
          <li
            v-for="row in conversations"
            :key="row.id"
          >
            <button
              type="button"
              class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-theme-800/60"
              @click="openConversation(row)"
            >
              <span class="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-theme-800 text-ink-muted">
                <img
                  v-if="agentIconUrl(row.agent_id)"
                  :src="agentIconUrl(row.agent_id)!"
                  :alt="`${agentName(row.agent_id)} icon`"
                  class="h-full w-full object-cover"
                >
                <Icon
                  v-else
                  :icon="row.origin === 'cron' ? 'lucide:calendar-clock' : row.agent_id ? 'lucide:bot' : 'lucide:message-square'"
                  class="h-4 w-4"
                />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm text-theme-200">{{ row.title }}</span>
                <span
                  v-if="row.last_user_message"
                  class="block truncate text-xs text-ink-muted"
                >{{ row.last_user_message }}</span>
              </span>
              <span class="hidden shrink-0 text-xs text-ink-muted sm:block">{{ agentName(row.agent_id) }}</span>
              <span class="shrink-0 text-xs text-ink-faint">{{ formatRelativeTime(row.updated_at) }}</span>
            </button>
          </li>
        </ul>
      </div>

      <!-- Board -->
      <ProjectBoard
        v-else-if="activeTab === 'board'"
        :project="project"
      />

      <!-- Timeline -->
      <ProjectTimeline
        v-else-if="activeTab === 'timeline'"
        :project="project"
        @restored="projectsStore.refreshProject(project.id)"
      />

      <!-- Settings -->
      <div
        v-else-if="activeTab === 'settings' && settingsDraft"
        class="max-w-3xl space-y-6"
      >
        <BaseCard class="p-5">
          <form @submit.prevent="saveSettings">
            <ProjectForm
              v-model="settingsDraft"
              mode="edit"
              show-instructions
            />
            <div class="mt-5 flex flex-wrap items-center justify-end gap-3">
              <p
                v-if="error"
                role="alert"
                class="text-sm text-status-danger"
              >
                {{ error }}
              </p>
              <p
                v-else-if="settingsSaved"
                role="status"
                class="text-sm text-status-success"
              >
                Project saved.
              </p>
              <button
                type="submit"
                class="rounded-lg accent-action bg-accent-500 px-4 py-2 text-sm font-semibold text-accent-on hover:bg-accent-400 disabled:opacity-50"
                :disabled="saving || !settingsDraft.name.trim()"
              >
                {{ saving ? 'Saving…' : 'Save changes' }}
              </button>
            </div>
          </form>
        </BaseCard>

        <BaseCard class="space-y-4 p-5">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 class="text-sm font-medium text-theme-200">
                {{ project.archived ? 'Restore project' : 'Archive project' }}
              </h3>
              <p class="mt-0.5 text-xs text-ink-muted">
                Archived projects are hidden from the sidebar and the project picker. Their chats keep working.
              </p>
            </div>
            <button
              type="button"
              class="rounded-lg border border-theme-700 px-3 py-2 text-sm text-theme-300 hover:bg-theme-800"
              @click="toggleArchived"
            >
              {{ project.archived ? 'Restore' : 'Archive' }}
            </button>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-3 border-t border-theme-800 pt-4">
            <div>
              <h3 class="text-sm font-medium text-status-danger">
                Delete project
              </h3>
              <p class="mt-0.5 text-xs text-ink-muted">
                Removes the project and its task board. Chats, scheduled jobs, and the memory folder are kept.
              </p>
            </div>
            <button
              type="button"
              class="rounded-lg border border-status-danger/40 px-3 py-2 text-sm text-status-danger hover:bg-status-danger/10"
              @click="confirmDelete = true"
            >
              Delete
            </button>
          </div>
        </BaseCard>
      </div>
    </main>

    <ModalDialog
      :show="confirmDelete"
      :title="`Delete ${project.name}?`"
      icon="lucide:trash-2"
      icon-color="red"
      @close="confirmDelete = false"
    >
      <p class="text-sm text-theme-300">
        The project and its {{ project.openTaskCount ?? 0 }} open tasks are removed. Its {{ project.conversationCount ?? 0 }} chats stay in your chat list, and the memory folder stays in Memory.
      </p>
      <template #actions>
        <button
          type="button"
          class="rounded-lg px-3 py-2 text-sm text-theme-300 hover:bg-theme-800"
          @click="confirmDelete = false"
        >
          Cancel
        </button>
        <button
          type="button"
          class="rounded-lg bg-status-danger px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
          @click="deleteProject"
        >
          Delete project
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
