<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import TabBar, { type TabDef } from '../components/shared/TabBar.vue'
import BaseCard from '../components/shared/BaseCard.vue'
import HoverTooltip from '../components/shared/HoverTooltip.vue'
import ModalDialog from '../components/shared/ModalDialog.vue'
import ProjectBoard from '../components/project/ProjectBoard.vue'
import ProjectTimeline from '../components/project/ProjectTimeline.vue'
import ProjectMemoryTab from '../components/project/ProjectMemoryTab.vue'
import ProjectFolderTab from '../components/project/ProjectFolderTab.vue'
import ProjectIcon from '../components/project/ProjectIcon.vue'
import ProjectForm, { type ProjectDraft } from '../components/project/ProjectForm.vue'
import RichContent from '../components/shared/RichContent.vue'
import { api, type ConversationRow } from '../api/client'
import type { CronJob } from '../api/types'
import { useProjectsStore } from '../stores/projects.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useChatStore } from '../stores/chat.store'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useProjectChat } from '../composables/useProjectChat'
import { formatRelativeTime } from '../utils/project-format'
import { cronToHuman } from '../utils/cron-helpers'
import { useCynoStore } from '../stores/cyno.store'

const cyno = useCynoStore()

type ProjectTab = 'overview' | 'chats' | 'board' | 'memories' | 'folder' | 'timeline' | 'settings'

const route = useRoute()
const router = useRouter()
const projectsStore = useProjectsStore()
const agentDefs = useAgentDefinitionsStore()
const chatStore = useChatStore()
const agentStore = useAgentStore()
const { startProjectChat } = useProjectChat()

const projectId = computed(() => route.params.id as string)
const project = computed(() => projectsStore.get(projectId.value))
const activeTab = ref<ProjectTab>(tabFromQuery())
const conversations = ref<ConversationRow[]>([])
const cronJobs = ref<CronJob[]>([])
const editingBrief = ref(false)
const briefDraft = ref('')
/** The brief the draft started from, so a save cannot overwrite an agent's newer version unseen. */
const briefBase = ref('')
const settingsDraft = ref<ProjectDraft | null>(null)
const settingsSaved = ref(false)
const saving = ref(false)
const error = ref('')
const confirmDelete = ref(false)

const memoryFolder = computed(() => chatStore.memoryFolders.find((folder) => folder.id === project.value?.memoryFolderId))
const memoryFileCount = computed(() => (memoryFolder.value?.fileCount ?? 0) + (memoryFolder.value?.descendantFileCount ?? 0))
const defaultAgentIconUrl = computed(() => project.value?.defaultAgentId ? agentIconUrl(project.value.defaultAgentId) : cyno.iconUrl)
const tabs = computed<TabDef<ProjectTab>[]>(() => [
  { value: 'overview', label: 'Overview', icon: 'lucide:layout-dashboard' },
  { value: 'board', label: 'Board', icon: 'lucide:square-kanban', badge: project.value?.openTaskCount || undefined, badgeTitle: `${project.value?.openTaskCount ?? 0} open tasks` },
  { value: 'chats', label: 'Chats', icon: 'lucide:message-square', badge: project.value?.conversationCount || undefined },
  { value: 'memories', label: 'Memories', icon: 'lucide:brain', badge: memoryFolder.value ? memoryFileCount.value || undefined : undefined, badgeTitle: `${memoryFileCount.value} memory files` },
  ...(project.value?.rootPath ? [{ value: 'folder' as const, label: 'Folder', icon: 'lucide:folder-code' }] : []),
  { value: 'timeline', label: 'Timeline', icon: 'lucide:history' },
  { value: 'settings', label: 'Settings', icon: 'lucide:settings' },
])

function tabFromQuery(): ProjectTab {
  const tab = route.query.tab
  return tab === 'chats' || tab === 'board' || tab === 'memories' || tab === 'folder' || tab === 'timeline' || tab === 'settings' ? tab : 'overview'
}

function agentIconUrl(agentId: string | null): string | null {
  return agentId ? (agentDefs.get(agentId)?.iconUrl || null) : null
}

function agentName(agentId: string | null): string {
  return agentId ? (agentDefs.get(agentId)?.name ?? 'Unknown agent') : cyno.name
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

/** Waiting for a scheduled wait to resume it, and not doing anything else meanwhile. */
function isWaiting(row: ConversationRow): boolean {
  return Boolean(row.wait_until) && !agentStore.liveExecutionConversationIds.includes(row.id)
}

function resumeLabel(row: ConversationRow): string {
  return `Waiting. Resumes at ${new Date(row.wait_until!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function startBriefEdit(): void {
  briefDraft.value = project.value?.brief ?? ''
  briefBase.value = briefDraft.value
  editingBrief.value = true
}

async function saveBrief(): Promise<void> {
  const saved = await guarded(() => projectsStore.update(projectId.value, { brief: briefDraft.value, expectedBrief: briefBase.value }))
  if (saved) {
    editingBrief.value = false
    return
  }
  // After a conflict the user has been told; saving again replaces the newer brief on purpose.
  await projectsStore.refreshProject(projectId.value)
  briefBase.value = project.value?.brief ?? briefBase.value
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
  // The open memory subfolder only means something on the Memories tab.
  void router.replace({ query: { ...route.query, tab: tab === 'overview' ? undefined : tab, folder: tab === 'memories' ? route.query.folder : undefined } })
})

watch(projectId, () => {
  activeTab.value = tabFromQuery()
  editingBrief.value = false
  settingsSaved.value = false
  error.value = ''
  void loadRelated()
})

watch(settingsDraft, () => { settingsSaved.value = false }, { deep: true })

// The Folder tab disappears when the project directory is removed.
watch(() => project.value?.rootPath, (rootPath) => {
  if (project.value && !rootPath && activeTab.value === 'folder') activeTab.value = 'overview'
}, { immediate: true })

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

const stopWaitUpdates = api.chat.onWaitsChanged(() => void loadRelated())
onBeforeUnmount(stopWaitUpdates)
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

    <!-- The board gets more room: its four lanes are what need the width. -->
    <main
      class="mx-auto px-4 py-6 sm:px-6 lg:px-8"
      :class="activeTab === 'board' ? 'max-w-384' : 'max-w-7xl'"
    >
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
                The current picture: goal, state, decisions, and next steps. Every agent in this project reads it; agents keep it up to date, and you can edit it.
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
          <BaseCard class="min-w-0 p-5 text-sm">
            <h2 class="text-base font-semibold text-theme-100">
              Context for agents
            </h2>
            <dl class="mt-1 divide-y divide-theme-700/60">
              <div class="relative py-4 pl-12">
                <dt class="font-medium text-ink-muted">
                  <span class="absolute left-0 top-4 flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg border border-theme-700/70 bg-theme-900/60">
                    <img
                      v-if="defaultAgentIconUrl"
                      :src="defaultAgentIconUrl"
                      alt=""
                      class="h-full w-full object-cover"
                    >
                    <Icon
                      v-else
                      icon="lucide:bot"
                      class="h-5 w-5"
                      aria-hidden="true"
                    />
                  </span>
                  Default agent
                </dt>
                <dd class="mt-1 break-words text-theme-100">
                  {{ agentName(project.defaultAgentId) }}
                </dd>
              </div>
              <div class="relative py-4 pl-12">
                <dt class="font-medium text-ink-muted">
                  <span class="absolute left-0 top-4 flex h-9 w-9 items-center justify-center rounded-lg border border-theme-700/70 bg-theme-900/60">
                    <Icon
                      icon="lucide:database"
                      class="h-5 w-5"
                      aria-hidden="true"
                    />
                  </span>
                  <span class="inline-flex items-center gap-1.5">
                    Memory folder
                    <HoverTooltip>
                      <Icon
                        icon="lucide:circle-help"
                        class="h-3.5 w-3.5 cursor-help text-ink-faint"
                        role="img"
                        aria-label="About memory folders"
                      />
                      <template #content>
                        Lasting facts and knowledge; agents add to it automatically
                      </template>
                    </HoverTooltip>
                  </span>
                </dt>
                <dd class="mt-2">
                  <button
                    v-if="memoryFolder"
                    type="button"
                    class="block w-full rounded-lg border border-theme-700/70 bg-theme-900/60 px-3 py-2 text-left font-mono text-xs leading-relaxed text-theme-200 transition-colors [overflow-wrap:anywhere] hover:border-theme-600 hover:text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                    :title="`Browse ${memoryFolder.folderPath || memoryFolder.name}`"
                    @click="activeTab = 'memories'"
                  >
                    {{ memoryFolder.folderPath || memoryFolder.name }}
                  </button>
                  <p
                    v-else
                    class="text-xs text-ink-faint"
                  >
                    None
                  </p>
                </dd>
              </div>
              <div class="relative py-4 pl-12">
                <dt class="font-medium text-ink-muted">
                  <span class="absolute left-0 top-4 flex h-9 w-9 items-center justify-center rounded-lg border border-theme-700/70 bg-theme-900/60">
                    <Icon
                      icon="lucide:folder-code"
                      class="h-5 w-5"
                      aria-hidden="true"
                    />
                  </span>
                  Project folder
                </dt>
                <dd class="mt-2">
                  <button
                    v-if="project.rootPath"
                    type="button"
                    class="block w-full rounded-lg border border-theme-700/70 bg-theme-900/60 px-3 py-2 text-left font-mono text-xs leading-relaxed text-theme-200 transition-colors [overflow-wrap:anywhere] hover:border-theme-600 hover:text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                    :title="`Browse ${project.rootPath}`"
                    @click="activeTab = 'folder'"
                  >
                    {{ project.rootPath }}
                  </button>
                  <p
                    v-else
                    class="text-xs text-ink-faint"
                  >
                    None
                  </p>
                </dd>
              </div>
              <div class="relative py-4 pl-12">
                <dt class="font-medium text-ink-muted">
                  <span class="absolute left-0 top-4 flex h-9 w-9 items-center justify-center rounded-lg border border-theme-700/70 bg-theme-900/60">
                    <Icon
                      icon="lucide:scroll-text"
                      class="h-5 w-5"
                      aria-hidden="true"
                    />
                  </span>
                  <span class="inline-flex items-center gap-1.5">
                    Instructions
                    <HoverTooltip>
                      <Icon
                        icon="lucide:circle-help"
                        class="h-3.5 w-3.5 cursor-help text-ink-faint"
                        role="img"
                        aria-label="About project instructions"
                      />
                      <template #content>
                        Written by you; followed in every chat of this project
                      </template>
                    </HoverTooltip>
                  </span>
                </dt>
                <dd class="mt-2">
                  <div
                    :class="project.instructions ? 'rounded-lg border border-theme-700/70 bg-theme-900/60 px-3 py-2 text-theme-200' : 'text-ink-faint'"
                  >
                    <p class="line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed [overflow-wrap:anywhere]">
                      {{ project.instructions || 'None' }}
                    </p>
                  </div>
                </dd>
              </div>
            </dl>
            <div class="border-t border-theme-700/60 pt-4">
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded text-xs font-medium text-accent-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                @click="activeTab = 'settings'"
              >
                Edit project settings
                <Icon
                  icon="lucide:chevron-right"
                  class="h-3.5 w-3.5"
                  aria-hidden="true"
                />
              </button>
            </div>
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
          class="divide-y divide-theme-700 overflow-hidden rounded-xl border border-theme-700 bg-theme-800"
        >
          <li
            v-for="row in conversations"
            :key="row.id"
          >
            <button
              type="button"
              class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-theme-700/60"
              @click="openConversation(row)"
            >
              <span class="relative flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-theme-700 text-ink-muted">
                <img
                  v-if="agentIconUrl(row.agent_id)"
                  :src="agentIconUrl(row.agent_id)!"
                  :alt="`${agentName(row.agent_id)} icon`"
                  class="h-full w-full object-cover"
                  :class="{ 'opacity-15': isWaiting(row) }"
                >
                <Icon
                  v-else
                  :icon="row.origin === 'cron' ? 'lucide:calendar-clock' : row.agent_id ? 'lucide:bot' : 'lucide:message-square'"
                  class="h-4 w-4"
                  :class="{ 'opacity-15': isWaiting(row) }"
                />
                <span
                  v-if="isWaiting(row)"
                  class="absolute inset-0 flex items-center justify-center bg-theme-950/30"
                  role="img"
                  :aria-label="resumeLabel(row)"
                  :title="resumeLabel(row)"
                >
                  <Icon
                    icon="lucide:hourglass"
                    class="h-4 w-4 text-status-info drop-shadow-sm"
                  />
                </span>
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

      <!-- Memories -->
      <ProjectMemoryTab
        v-else-if="activeTab === 'memories'"
        :project="project"
        @open-settings="activeTab = 'settings'"
      />

      <!-- Folder -->
      <ProjectFolderTab
        v-else-if="activeTab === 'folder' && project.rootPath"
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
        <div class="flex flex-wrap justify-end gap-2">
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
        </div>
      </template>
    </ModalDialog>
  </div>
</template>
