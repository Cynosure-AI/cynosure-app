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

const CHATS_PER_PROJECT = 5
const MAX_PROJECTS = 8

const route = useRoute()
const router = useRouter()
const chatStore = useChatStore()
const agentStore = useAgentStore()
const projectsStore = useProjectsStore()
const { startProjectChat } = useProjectChat()

const expanded = ref<Set<string>>(readExpanded())
const chatsByProject = ref<Record<string, { items: ConversationRow[]; total: number }>>({})
const liveCleanups: Array<() => void> = []
let refreshTimer: ReturnType<typeof setTimeout> | null = null

const projects = computed(() =>
  [...projectsStore.activeProjects]
    .sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt))
    .slice(0, MAX_PROJECTS),
)
const hiddenCount = computed(() => Math.max(0, projectsStore.activeProjects.length - projects.value.length))

function readExpanded(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SK_SIDEBAR_EXPANDED_PROJECTS) || '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function persistExpanded(): void {
  try {
    localStorage.setItem(SK_SIDEBAR_EXPANDED_PROJECTS, JSON.stringify([...expanded.value]))
  } catch {
    // Expansion state is a convenience.
  }
}

async function loadChats(projectId: string): Promise<void> {
  try {
    const response = await api.chat.listConversationsPaginated(CHATS_PER_PROJECT, 0, 'sidebar', undefined, undefined, undefined, { projectId })
    chatsByProject.value = { ...chatsByProject.value, [projectId]: { items: response.items, total: response.total } }
  } catch {
    // Keep the last list; the next chat event retries.
  }
}

function toggle(projectId: string): void {
  const next = new Set(expanded.value)
  if (next.has(projectId)) next.delete(projectId)
  else {
    next.add(projectId)
    void loadChats(projectId)
  }
  expanded.value = next
  persistExpanded()
}

function refreshExpanded(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    for (const id of expanded.value) void loadChats(id)
  }, 200)
}

async function openChat(row: ConversationRow): Promise<void> {
  await chatStore.selectConversation(row.id, row.agent_id)
  await router.push({ name: 'conversation', params: { conversationId: row.id } })
}

function isProjectActive(projectId: string): boolean {
  return route.path === `/projects/${projectId}`
}

// Open the group that holds the chat being viewed so it is visible in context.
watch(() => chatStore.activeProjectId, (projectId) => {
  if (projectId && chatStore.activeConversationId && !expanded.value.has(projectId)) {
    expanded.value = new Set([...expanded.value, projectId])
    persistExpanded()
  }
  refreshExpanded()
})
watch(() => chatStore.activeConversationId, refreshExpanded)

onMounted(() => {
  liveCleanups.push(
    api.chat.onEvent((event) => {
      if ((event.type === 'transcript-item' && event.item.type === 'message') || event.type === 'title-updated') refreshExpanded()
    }),
  )
  void projectsStore.ensureLoaded().catch(() => undefined).then(() => {
    for (const id of expanded.value) void loadChats(id)
  })
})

onBeforeUnmount(() => {
  if (refreshTimer) clearTimeout(refreshTimer)
  liveCleanups.forEach((cleanup) => cleanup())
})
</script>

<template>
  <div class="space-y-0.5">
    <div
      v-for="project in projects"
      :key="project.id"
    >
      <div
        class="group/project mb-0.5 flex items-center gap-2.5 rounded-lg py-2 pl-3 pr-1 text-[0.8125rem] font-medium transition-colors"
        :class="isProjectActive(project.id)
          ? 'project-row--active text-theme-100'
          : 'text-ink-secondary hover:bg-theme-800 hover:text-theme-100'"
      >
        <button
          type="button"
          class="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded text-ink-muted hover:text-theme-200"
          :aria-expanded="expanded.has(project.id)"
          :aria-label="`${expanded.has(project.id) ? 'Collapse' : 'Expand'} ${project.name} chats`"
          @click="toggle(project.id)"
        >
          <span
            class="h-2.5 w-2.5 rounded-full group-hover/project:hidden"
            :class="{ hidden: expanded.has(project.id) }"
            :style="{ backgroundColor: project.color || 'var(--color-accent-500)' }"
          />
          <Icon
            icon="lucide:chevron-right"
            class="h-3.5 w-3.5 transition-transform group-hover/project:block"
            :class="expanded.has(project.id) ? 'rotate-90' : 'hidden'"
          />
        </button>
        <RouterLink
          :to="{ name: 'project-detail', params: { id: project.id } }"
          class="min-w-0 flex-1 truncate"
        >
          {{ project.name }}
        </RouterLink>
        <button
          type="button"
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-muted opacity-0 transition hover:bg-theme-700 hover:text-theme-200 group-hover/project:opacity-100 focus-visible:opacity-100"
          :aria-label="`New chat in ${project.name}`"
          title="New chat in this project"
          @click="startProjectChat(project)"
        >
          <Icon
            icon="lucide:plus"
            class="h-3.5 w-3.5"
          />
        </button>
      </div>

      <ul
        v-if="expanded.has(project.id)"
        class="mb-1 ml-[1.15rem] space-y-0.5 border-l border-theme-800 pl-2"
      >
        <li
          v-for="row in chatsByProject[project.id]?.items ?? []"
          :key="row.id"
        >
          <button
            type="button"
            class="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-theme-800/70"
            :class="row.id === chatStore.activeConversationId ? 'bg-theme-800 text-theme-100' : 'text-theme-300'"
            :title="row.title"
            @click="openChat(row)"
          >
            <Icon
              v-if="agentStore.liveExecutionConversationIds.includes(row.id)"
              icon="lucide:loader-circle"
              class="h-3 w-3 shrink-0 animate-spin text-accent-fg"
            />
            <Icon
              v-else-if="row.origin === 'cron'"
              icon="lucide:calendar-clock"
              class="h-3 w-3 shrink-0 text-ink-faint"
            />
            <span class="truncate">{{ row.title }}</span>
          </button>
        </li>
        <li
          v-if="chatsByProject[project.id] && !chatsByProject[project.id].items.length"
          class="px-2 py-1 text-[11px] text-ink-faint"
        >
          No chats yet
        </li>
        <li v-if="(chatsByProject[project.id]?.total ?? 0) > CHATS_PER_PROJECT">
          <RouterLink
            :to="{ name: 'project-detail', params: { id: project.id }, query: { tab: 'chats' } }"
            class="block rounded-md px-2 py-1 text-[11px] text-ink-muted hover:bg-theme-800/70 hover:text-theme-200"
          >
            All {{ chatsByProject[project.id].total }} chats
          </RouterLink>
        </li>
      </ul>
    </div>

    <RouterLink
      v-if="hiddenCount"
      :to="{ name: 'projects' }"
      class="block px-3 py-1 text-[11px] text-ink-muted hover:text-theme-200"
    >
      {{ hiddenCount }} more {{ hiddenCount === 1 ? 'project' : 'projects' }}
    </RouterLink>
  </div>
</template>

<style scoped>
/* Mirrors the sidebar's active nav item, whose styles are scoped to AppSidebar. */
.project-row--active {
  background: var(--theme-nav-active-background, color-mix(in srgb, var(--color-accent-500) 10%, var(--color-theme-800)));
  box-shadow: var(--theme-nav-active-shadow, inset 3px 0 0 var(--color-accent-500));
}
</style>
