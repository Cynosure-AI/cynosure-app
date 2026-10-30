
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'

import { api, type ConversationRow } from '../../api/client'
import { useChatStore } from '../../stores/chat.store'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { useProjectsStore } from '../../stores/projects.store'
import { useProjectChat } from '../../composables/useProjectChat'
import ProjectIcon from '../project/ProjectIcon.vue'
import DreamingBadge from '../shared/DreamingBadge.vue'
import HoverTooltip from '../shared/HoverTooltip.vue'

const MAX_PROJECTS = 8
const CHATS_PER_PROJECT = 5

type ProjectChats = {
  items: ConversationRow[]
  total: number
}

const props = withDefaults(defineProps<{
  collapsed?: boolean
  activeConversationIds?: string[]
  awaitingConversationIds?: string[]
  /** Chats Dream is reviewing in the background. */
  dreamingConversationIds?: string[]
}>(), {
  collapsed: false,
  activeConversationIds: () => [],
  awaitingConversationIds: () => [],
  dreamingConversationIds: () => [],
})

const route = useRoute()
const router = useRouter()
const chatStore = useChatStore()
const agentStore = useAgentStore()
const projectsStore = useProjectsStore()
const { startProjectChat } = useProjectChat()

const activeProjectId = computed(() => {
  if (route.name === 'project-detail' && typeof route.params.id === 'string') return route.params.id
  if (route.name === 'conversation') return chatStore.activeProjectId
  return null
})
const collapsedProjectId = ref<string | null>(null)

/** The current project's chats open automatically unless manually collapsed. */
const expanded = computed(() => new Set<string>(
  !props.collapsed && activeProjectId.value && activeProjectId.value !== collapsedProjectId.value
    ? [activeProjectId.value]
    : [],
))

watch([() => route.fullPath, activeProjectId], () => {
  collapsedProjectId.value = null
})
const chatsByProject = ref<Record<string, ProjectChats>>({})
const activityChatsByProject = ref<Record<string, ConversationRow[]>>({})
const openMenuId = ref<string | null>(null)
const editingId = ref<string | null>(null)
const editingTitle = ref('')
const titleInputRef = ref<HTMLInputElement | null>(null)

function setTitleInput(element: unknown): void {
  titleInputRef.value = element as HTMLInputElement | null
}

function closeMenu(): void {
  openMenuId.value = null
}

function openContextMenu(chatId: string): void {
  editingId.value = null
  openMenuId.value = chatId
}

async function togglePin(chat: ConversationRow, projectId: string): Promise<void> {
  closeMenu()
  const pinned = !chat.pinned
  await chatStore.pinConversation(chat.id, pinned)
  chat.pinned = Number(pinned)
  await loadChats(projectId)
}

function startRename(chat: ConversationRow): void {
  closeMenu()
  editingId.value = chat.id
  editingTitle.value = chat.title
  void nextTick(() => titleInputRef.value?.select())
}

async function commitRename(chat: ConversationRow): Promise<void> {
  if (editingId.value !== chat.id) return
  const title = editingTitle.value.trim()
  editingId.value = null
  if (!title || title === chat.title) return
  await chatStore.renameConversation(chat.id, title)
  chat.title = title
}

async function deleteConversation(chat: ConversationRow, projectId: string): Promise<void> {
  closeMenu()
  if (chat.pinned) return
  await chatStore.deleteConversation(chat.id)
  const chats = chatsByProject.value[projectId]
  if (chats) {
    chats.items = chats.items.filter((item) => item.id !== chat.id)
    chats.total = Math.max(0, chats.total - 1)
  }
  activityChatsByProject.value[projectId] = (activityChatsByProject.value[projectId] ?? [])
    .filter((item) => item.id !== chat.id)
  await loadChats(projectId)
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined
const liveCleanups: Array<() => void> = []

// Projects ordered by recent activity
const projects = computed(() =>
  [...projectsStore.activeProjects]
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? b.updatedAt) -
        (a.lastActivityAt ?? a.updatedAt),
    )
    .slice(0, MAX_PROJECTS),
)

// Live conversation activity, including background executions.
const runningIds = computed(() => new Set([
  ...props.activeConversationIds,
  ...agentStore.liveExecutionConversationIds,
]))

const dreamingIds = computed(() => new Set(props.dreamingConversationIds))

const awaitingIds = computed(() => new Set([
  ...props.awaitingConversationIds,
  ...agentStore.awaitingHITLConvIds,
]))

function projectIdsWithActivity(conversationIds: Set<string>): Set<string> {
  const ids = new Set<string>()

  for (const [projectId, chats] of Object.entries(chatsByProject.value)) {
    if (chats.items.some((chat) => conversationIds.has(chat.id))) {
      ids.add(projectId)
    }
  }
  for (const [projectId, chats] of Object.entries(activityChatsByProject.value)) {
    if (chats.some((chat) => conversationIds.has(chat.id))) {
      ids.add(projectId)
    }
  }

  return ids
}

const runningProjectIds = computed(() => projectIdsWithActivity(runningIds.value))
const awaitingProjectIds = computed(() => projectIdsWithActivity(awaitingIds.value))
const dreamingProjectIds = computed(() => projectIdsWithActivity(dreamingIds.value))

const hiddenCount = computed(() =>
  Math.max(0, projectsStore.activeProjects.length - MAX_PROJECTS),
)

/** Waiting for a scheduled wait to resume it, and not doing anything else meanwhile. */
function isWaiting(chat: ConversationRow): boolean {
  return Boolean(chat.wait_until) && !runningIds.value.has(chat.id)
}

function resumeLabel(chat: ConversationRow): string {
  return `Waiting. Resumes at ${new Date(chat.wait_until!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

// Chat data
async function loadChats(projectId: string, resolveActivity = false): Promise<boolean> {
  try {
    const { items, total } = await api.chat.listConversationsPaginated(
      CHATS_PER_PROJECT,
      0,
      'sidebar',
      undefined,
      undefined,
      undefined,
      { projectId },
    )

    chatsByProject.value = {
      ...chatsByProject.value,
      [projectId]: { items, total },
    }

    // Pinned or newer chats can push a running chat out of the recent list.
    if (resolveActivity && total > items.length) {
      const activityChats = await api.chat.listProjectConversations(projectId)
      activityChatsByProject.value = {
        ...activityChatsByProject.value,
        [projectId]: activityChats,
      }
    } else if (total <= items.length || !activityChatsByProject.value[projectId]) {
      activityChatsByProject.value = {
        ...activityChatsByProject.value,
        [projectId]: items,
      }
    }
    return true
  } catch {
    // Keep cached chats until the next refresh
    return false
  }
}

// Conversation ids already searched for in project chat lists
const resolvedActivityIds = new Set<string>()

// Resolve activity for collapsed projects without changing their expanded state.
async function resolveActiveProjects(): Promise<void> {
  const known = new Set(
    [
      ...Object.values(chatsByProject.value).flatMap((chats) => chats.items),
      ...Object.values(activityChatsByProject.value).flat(),
    ].map((chat) => chat.id),
  )
  const unresolved = [...new Set([...runningIds.value, ...awaitingIds.value])].filter(
    (id) => !known.has(id) && !resolvedActivityIds.has(id),
  )

  if (!unresolved.length || !projects.value.length) return

  for (const id of unresolved) resolvedActivityIds.add(id)
  const loaded = await Promise.all(projects.value.map((project) => loadChats(project.id, true)))
  if (loaded.some((success) => !success)) {
    for (const id of unresolved) resolvedActivityIds.delete(id)
  }
}

function refreshChats(): void {
  if (refreshTimer) clearTimeout(refreshTimer)

  refreshTimer = setTimeout(() => {
    refreshTimer = undefined

    for (const project of projects.value) {
      if (expanded.value.has(project.id)) {
        void loadChats(project.id)
      }
    }
  }, 200)
}

// Expand/collapse animation: height runs between 0 and the measured content height.
function expandHeight(el: Element): void {
  const list = el as HTMLElement
  list.style.height = '0px'
  void list.offsetHeight
  list.style.height = `${list.scrollHeight}px`
}

function collapseHeight(el: Element): void {
  const list = el as HTMLElement
  list.style.height = `${list.scrollHeight}px`
  void list.offsetHeight
  list.style.height = '0px'
}

function clearHeight(el: Element): void {
  (el as HTMLElement).style.height = ''
}

// Navigation and interaction
function toggleProject(projectId: string, event: MouseEvent): void {
  if (
    props.collapsed || event.defaultPrevented || event.button !== 0 ||
    event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
    !isProjectActive(projectId)
  ) return

  // Toggle only on the overview; project conversations still need this link to navigate back.
  event.preventDefault()
  collapsedProjectId.value = expanded.value.has(projectId) ? projectId : null
}

function isProjectActive(projectId: string): boolean {
  return (
    route.name === 'project-detail' &&
    route.params.id === projectId
  )
}

async function openChat(row: ConversationRow): Promise<void> {
  closeMenu()
  await chatStore.selectConversation(row.id, row.agent_id)

  await router.push({
    name: 'conversation',
    params: { conversationId: row.id },
  })
}

// Refresh chat lists without changing the user's expanded state
watch(
  [
    () => chatStore.activeProjectId,
    () => chatStore.activeConversationId,
    () => chatStore.conversationListRevision,
  ],
  refreshChats,
)

// Load chats as a project expands; collapsed projects keep their cached list.
watch(expanded, (ids, previous) => {
  for (const id of ids) {
    if (!previous?.has(id)) void loadChats(id)
  }
}, { immediate: true })

watch(
  () => [...new Set([...runningIds.value, ...awaitingIds.value])].sort().join('|'),
  () => void resolveActiveProjects(),
)

// Lifecycle
onMounted(() => {
  document.addEventListener('click', closeMenu)
  liveCleanups.push(
    api.chat.onEvent((event) => {
      if (
        event.type === 'title-updated' ||
        (event.type === 'transcript-item' && event.item.type === 'message')
      ) {
        refreshChats()
      }
    }),
    api.chat.onWaitsChanged(refreshChats),
  )

  void projectsStore.ensureLoaded()
    .then(() => resolveActiveProjects())
    .catch(() => undefined)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', closeMenu)
  if (refreshTimer) clearTimeout(refreshTimer)
  liveCleanups.forEach((cleanup) => cleanup())
})
</script>

<template>
  <div
    class="space-y-0.5"
    :class="{ 'projects-collapsed': collapsed }"
  >
    <div
      v-for="project in projects"
      :key="project.id"
      class="space-y-0.5"
    >
      <!-- Project row -->
      <div class="group/project relative">
        <HoverTooltip
          placement="right"
          block
          :disabled="!collapsed"
        >
          <RouterLink
            :to="{
              name: 'project-detail',
              params: { id: project.id },
            }"
            class="project-row flex min-h-9 w-full items-center gap-2.5 rounded-lg py-2 pl-3 pr-10 text-left text-[0.8125rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500"
            :class="
              isProjectActive(project.id)
                ? 'project-row--active text-theme-100'
                : 'text-ink-secondary hover:bg-theme-800 hover:text-theme-100'
            "
            :aria-current="isProjectActive(project.id) ? 'page' : undefined"
            :aria-expanded="collapsed ? undefined : expanded.has(project.id)"
            :aria-label="project.name"
            :title="collapsed ? undefined : project.name"
            @click.capture="toggleProject(project.id, $event)"
          >
            <!-- A collapsed project shows its chats' status in place of its icon. -->
            <span
              v-if="!expanded.has(project.id) && awaitingProjectIds.has(project.id)"
              class="flex h-4 w-4 shrink-0 items-center justify-center"
              role="img"
              title="A chat in this project is waiting for your approval"
              aria-label="A chat in this project is waiting for your approval"
            >
              <span class="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
            </span>
            <Icon
              v-else-if="!expanded.has(project.id) && runningProjectIds.has(project.id)"
              icon="lucide:loader-circle"
              class="h-4 w-4 shrink-0 animate-spin text-accent-fg"
              role="img"
              title="A chat in this project is running"
              aria-label="A chat in this project is running"
            />
            <span
              v-else
              class="relative flex h-4 w-4 shrink-0"
            >
              <ProjectIcon
                :project="project"
                class="h-full w-full"
              />
              <DreamingBadge
                v-if="!expanded.has(project.id) && dreamingProjectIds.has(project.id)"
                label="Dreaming over a chat in this project"
              />
            </span>

            <span
              v-if="!collapsed"
              class="min-w-0 flex-1 truncate"
              :class="{ 'text-amber-200': awaitingProjectIds.has(project.id) }"
            >
              {{ project.name }}
            </span>
          </RouterLink>
          <template #content>
            {{ project.name }}
          </template>
        </HoverTooltip>

        <!-- New project chat -->
        <button
          v-if="!collapsed"
          type="button"
          class="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-muted opacity-0 transition-all hover:bg-theme-700 hover:text-theme-100 hover:opacity-100 group-hover/project:opacity-100 group-focus-within/project:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
          :aria-label="`New chat in ${project.name}`"
          title="New chat"
          @click="startProjectChat(project)"
        >
          <Icon
            icon="lucide:plus"
            class="h-3.5 w-3.5"
          />
        </button>
      </div>

      <!-- Recent project chats; shown once loaded so the list opens to its full height -->
      <Transition
        name="project-chats"
        @enter="expandHeight"
        @after-enter="clearHeight"
        @leave="collapseHeight"
        @after-leave="clearHeight"
      >
        <ul
          v-if="expanded.has(project.id) && chatsByProject[project.id]"
          class="mb-1 ml-[1.15rem] space-y-0.5 border-l border-theme-800 pl-2"
        >
          <li
            v-for="chat in chatsByProject[project.id]?.items ?? []"
            :key="chat.id"
            class="group/chat relative"
          >
            <div
              role="button"
              tabindex="0"
              class="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-theme-800/70"
              :class="[
                chat.id === chatStore.activeConversationId
                  ? 'bg-theme-800 text-theme-100'
                  : 'text-theme-300',
                {
                  'bg-amber-500/20 font-medium text-amber-200 hover:bg-amber-500/25':
                    awaitingIds.has(chat.id),
                },
              ]"
              :title="chat.title"
              @click="openChat(chat)"
              @contextmenu.prevent.stop="openContextMenu(chat.id)"
              @keydown.enter.self.prevent="openChat(chat)"
              @keydown.space.self.prevent="openChat(chat)"
              @keydown.escape="closeMenu"
            >
              <span
                v-if="awaitingIds.has(chat.id)"
                class="h-2 w-2 shrink-0 rounded-full bg-amber-400 animate-pulse"
                aria-label="Waiting for your approval"
              />
              <Icon
                v-else-if="runningIds.has(chat.id)"
                icon="lucide:loader-circle"
                class="h-3 w-3 shrink-0 animate-spin text-accent-fg"
              />
              <Icon
                v-else-if="isWaiting(chat)"
                icon="lucide:hourglass"
                class="h-3 w-3 shrink-0 text-status-info"
                role="img"
                :aria-label="resumeLabel(chat)"
                :title="resumeLabel(chat)"
              />
              <DreamingBadge
                v-else-if="dreamingIds.has(chat.id)"
                variant="inline"
              />
              <Icon
                v-else-if="chat.origin === 'cron'"
                icon="lucide:calendar-clock"
                class="h-3 w-3 shrink-0 text-ink-faint"
              />

              <Icon
                v-if="chat.pinned"
                icon="lucide:pin"
                class="h-3 w-3 shrink-0 text-status-warning"
              />
              <input
                v-if="editingId === chat.id"
                :ref="setTitleInput"
                v-model="editingTitle"
                class="min-w-0 flex-1 rounded border border-theme-600 bg-theme-900 px-1 py-0.5 text-xs text-theme-100 outline-none"
                aria-label="Conversation title"
                @click.stop
                @blur="commitRename(chat)"
                @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
                @keydown.escape.prevent="editingId = null"
              >
              <span
                v-else
                class="min-w-0 flex-1 truncate"
              >
                {{ chat.title }}
              </span>
              <button
                type="button"
                class="shrink-0 rounded-md p-1 text-ink-muted opacity-0 transition hover:bg-theme-700 hover:text-theme-200 group-hover/chat:opacity-100 focus-visible:opacity-100"
                :class="{ 'bg-theme-700 text-theme-200 opacity-100': openMenuId === chat.id }"
                aria-label="Chat options"
                @click.stop="openMenuId = openMenuId === chat.id ? null : chat.id"
              >
                <Icon
                  icon="lucide:ellipsis"
                  class="h-3.5 w-3.5"
                />
              </button>
            </div>
            <div
              v-if="openMenuId === chat.id"
              class="absolute right-0 top-full z-30 w-36 overflow-hidden rounded-lg border border-theme-700 bg-theme-900 py-1 shadow-xl"
              @click.stop
              @keydown.escape="closeMenu"
            >
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-2 text-xs text-theme-300 hover:bg-theme-800"
                @click="togglePin(chat, project.id)"
              >
                <Icon
                  :icon="chat.pinned ? 'lucide:pin-off' : 'lucide:pin'"
                  class="h-3.5 w-3.5 text-status-warning"
                />
                {{ chat.pinned ? 'Unpin' : 'Pin' }}
              </button>
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-2 text-xs text-theme-300 hover:bg-theme-800"
                @click="startRename(chat)"
              >
                <Icon
                  icon="lucide:pencil"
                  class="h-3.5 w-3.5"
                /> Rename
              </button>
              <button
                type="button"
                class="flex w-full items-center gap-2 border-t border-theme-800 px-3 py-2 text-xs text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="Boolean(chat.pinned)"
                :title="chat.pinned ? 'Unpin this chat before deleting it' : undefined"
                @click="deleteConversation(chat, project.id)"
              >
                <Icon
                  icon="lucide:trash-2"
                  class="h-3.5 w-3.5"
                /> Delete
              </button>
            </div>
          </li>

          <!-- Empty state -->
          <li
            v-if="
              chatsByProject[project.id] &&
                !chatsByProject[project.id].items.length
            "
            class="px-2 py-1 text-[11px] text-ink-faint"
          >
            No chats yet
          </li>

          <!-- Additional chats -->
          <li
            v-if="
              (chatsByProject[project.id]?.total ?? 0) > CHATS_PER_PROJECT
            "
          >
            <RouterLink
              :to="{
                name: 'project-detail',
                params: { id: project.id },
                query: { tab: 'chats' },
              }"
              class="block rounded-md px-2 py-1 text-[11px] text-ink-muted transition-colors hover:bg-theme-800/70 hover:text-theme-200"
            >
              All {{ chatsByProject[project.id].total }} chats
            </RouterLink>
          </li>
        </ul>
      </Transition>
    </div>

    <!-- Remaining projects -->
    <HoverTooltip
      v-if="hiddenCount > 0"
      placement="right"
      block
      :disabled="!collapsed"
    >
      <RouterLink
        :to="{ name: 'projects' }"
        class="project-row block w-full rounded-md px-3 py-1.5 text-[11px] text-ink-muted transition-colors hover:bg-theme-800/70 hover:text-theme-200"
        :aria-label="`${hiddenCount} more ${hiddenCount === 1 ? 'project' : 'projects'}`"
      >
        <Icon
          v-if="collapsed"
          icon="lucide:ellipsis"
          class="h-4.5 w-4.5"
        />
        <template v-else>
          {{ hiddenCount }} more {{ hiddenCount === 1 ? 'project' : 'projects' }}
        </template>
      </RouterLink>
      <template #content>
        {{ hiddenCount }} more {{ hiddenCount === 1 ? 'project' : 'projects' }}
      </template>
    </HoverTooltip>
  </div>
</template>

<style scoped>
.projects-collapsed .project-row {
  display: flex;
  justify-content: center;
  gap: 0;
  width: 2.5rem;
  min-height: 2.25rem;
  margin-inline: auto;
  padding: 0.5rem;
}

.projects-collapsed .project-row > :first-child {
  width: 1.125rem;
  height: 1.125rem;
  flex-shrink: 0;
}

.project-chats-enter-active,
.project-chats-leave-active {
  overflow: hidden;
  transition:
    height 200ms cubic-bezier(0.22, 1, 0.36, 1),
    margin-bottom 200ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 160ms ease;
}

.project-chats-enter-from,
.project-chats-leave-to {
  margin-bottom: 0;
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .project-chats-enter-active,
  .project-chats-leave-active {
    transition: none;
  }
}

.project-row--active {
  background: var(
    --theme-nav-active-background,
    color-mix(
      in srgb,
      var(--color-accent-500) 10%,
      var(--color-theme-800)
    )
  );

  box-shadow: var(
    --theme-nav-active-shadow,
    inset 3px 0 0 var(--color-accent-500)
  );
}
</style>
