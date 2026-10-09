
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'

import { api, type ConversationRow } from '../../api/client'
import { useChatStore } from '../../stores/chat.store'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { useProjectsStore } from '../../stores/projects.store'
import { useProjectChat } from '../../composables/useProjectChat'
import { SK_SIDEBAR_EXPANDED_PROJECTS } from '../../utils/storage-keys'
import ProjectIcon from '../project/ProjectIcon.vue'

const MAX_PROJECTS = 8
const CHATS_PER_PROJECT = 5

type ProjectChats = {
  items: ConversationRow[]
  total: number
}

const route = useRoute()
const router = useRouter()
const chatStore = useChatStore()
const agentStore = useAgentStore()
const projectsStore = useProjectsStore()
const { startProjectChat } = useProjectChat()

const expanded = ref<Set<string>>(readExpanded())
const chatsByProject = ref<Record<string, ProjectChats>>({})

let refreshTimer: ReturnType<typeof setTimeout> | undefined
let unsubscribe: (() => void) | undefined

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

const hiddenCount = computed(() =>
  Math.max(0, projectsStore.activeProjects.length - MAX_PROJECTS),
)

// Expanded state
function readExpanded(): Set<string> {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(SK_SIDEBAR_EXPANDED_PROJECTS) ?? '[]',
    )

    return new Set(
      Array.isArray(stored)
        ? stored.filter((id): id is string => typeof id === 'string')
        : [],
    )
  } catch {
    return new Set()
  }
}

function saveExpanded(): void {
  try {
    localStorage.setItem(
      SK_SIDEBAR_EXPANDED_PROJECTS,
      JSON.stringify([...expanded.value]),
    )
  } catch {
    // Persistence is optional
  }
}

// Chat data
async function loadChats(projectId: string): Promise<void> {
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
  } catch {
    // Keep cached chats until the next refresh
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

// Navigation and interaction
function toggleProject(projectId: string): void {
  const next = new Set(expanded.value)

  if (next.has(projectId)) {
    next.delete(projectId)
  } else {
    next.add(projectId)
    void loadChats(projectId)
  }

  expanded.value = next
  saveExpanded()
}

function isProjectActive(projectId: string): boolean {
  return (
    route.name === 'project-detail' &&
    route.params.id === projectId
  )
}

async function openChat(row: ConversationRow): Promise<void> {
  await chatStore.selectConversation(row.id, row.agent_id)

  await router.push({
    name: 'conversation',
    params: { conversationId: row.id },
  })
}

// Automatically reveal the active conversation
watch(
  [
    () => chatStore.activeProjectId,
    () => chatStore.activeConversationId,
  ],
  ([projectId, conversationId]) => {
    if (projectId && conversationId && !expanded.value.has(projectId)) {
      toggleProject(projectId)
    } else {
      refreshChats()
    }
  },
)

// Lifecycle
onMounted(() => {
  unsubscribe = api.chat.onEvent((event) => {
    if (
      event.type === 'title-updated' ||
      (event.type === 'transcript-item' && event.item.type === 'message')
    ) {
      refreshChats()
    }
  })

  void projectsStore.ensureLoaded()
    .then(() => {
      for (const project of projects.value) {
        if (expanded.value.has(project.id)) {
          void loadChats(project.id)
        }
      }
    })
    .catch(() => undefined)
})

onBeforeUnmount(() => {
  if (refreshTimer) clearTimeout(refreshTimer)
  unsubscribe?.()
})
</script>

<template>
  <div class="space-y-0.5">
    <div
      v-for="project in projects"
      :key="project.id"
      class="space-y-0.5"
    >
      <!-- Project row -->
      <div class="group/project relative">
        <RouterLink
          :to="{
            name: 'project-detail',
            params: { id: project.id },
          }"
          class="flex min-h-9 w-full items-center gap-2.5 rounded-lg py-2 pl-3 pr-10 text-left text-[0.8125rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500"
          :class="
            isProjectActive(project.id)
              ? 'project-row--active text-theme-100'
              : 'text-ink-secondary hover:bg-theme-800 hover:text-theme-100'
          "
          :aria-expanded="expanded.has(project.id)"
          :title="project.name"
          @click="toggleProject(project.id)"
        >
          <ProjectIcon
            :project="project"
            class="h-4 w-4 shrink-0"
          />

          <span class="min-w-0 flex-1 truncate">
            {{ project.name }}
          </span>
        </RouterLink>

        <!-- New project chat -->
        <button
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

      <!-- Recent project chats -->
      <ul
        v-if="expanded.has(project.id)"
        class="mb-1 ml-[1.15rem] space-y-0.5 border-l border-theme-800 pl-2"
      >
        <li
          v-for="chat in chatsByProject[project.id]?.items ?? []"
          :key="chat.id"
        >
          <button
            type="button"
            class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-theme-800/70"
            :class="
              chat.id === chatStore.activeConversationId
                ? 'bg-theme-800 text-theme-100'
                : 'text-theme-300'
            "
            :title="chat.title"
            @click="openChat(chat)"
          >
            <Icon
              v-if="agentStore.liveExecutionConversationIds.includes(chat.id)"
              icon="lucide:loader-circle"
              class="h-3 w-3 shrink-0 animate-spin text-accent-fg"
            />
            <Icon
              v-else-if="chat.origin === 'cron'"
              icon="lucide:calendar-clock"
              class="h-3 w-3 shrink-0 text-ink-faint"
            />

            <span class="min-w-0 flex-1 truncate">
              {{ chat.title }}
            </span>
          </button>
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
    </div>

    <!-- Remaining projects -->
    <RouterLink
      v-if="hiddenCount > 0"
      :to="{ name: 'projects' }"
      class="block rounded-md px-3 py-1.5 text-[11px] text-ink-muted transition-colors hover:bg-theme-800/70 hover:text-theme-200"
    >
      {{ hiddenCount }} more {{ hiddenCount === 1 ? 'project' : 'projects' }}
    </RouterLink>
  </div>
</template>

<style scoped>
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
