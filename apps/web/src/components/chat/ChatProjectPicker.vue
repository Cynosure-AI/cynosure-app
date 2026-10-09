<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { useChatStore } from '../../stores/chat.store'
import { useProjectsStore } from '../../stores/projects.store'

const chatStore = useChatStore()
const projectsStore = useProjectsStore()
const router = useRouter()

const open = ref(false)
const error = ref('')
const root = ref<HTMLElement | null>(null)

const project = computed(() => projectsStore.get(chatStore.activeProjectId))
const choices = computed(() => projectsStore.activeProjects.filter((candidate) => candidate.id !== chatStore.activeProjectId))
const isNewChat = computed(() => !chatStore.activeConversationId)

async function choose(projectId: string | null): Promise<void> {
  open.value = false
  error.value = ''
  try {
    await chatStore.setConversationProject(projectId)
    void projectsStore.load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function openProject(): void {
  open.value = false
  if (project.value) void router.push({ name: 'project-detail', params: { id: project.value.id } })
}

function newProject(): void {
  open.value = false
  void router.push({ name: 'projects', query: { new: '1' } })
}

function onDocumentClick(event: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false
}

onMounted(() => {
  void projectsStore.ensureLoaded()
  document.addEventListener('click', onDocumentClick)
})
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick))
</script>

<template>
  <div
    ref="root"
    class="relative shrink-0"
  >
    <button
      type="button"
      class="inline-flex max-w-44 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
      :class="project
        ? 'border-theme-700 bg-theme-800 text-theme-200 hover:border-theme-600'
        : 'border-transparent text-ink-muted hover:bg-theme-800 hover:text-theme-200'"
      :title="project ? `Project: ${project.name}` : 'Add this chat to a project'"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click.stop="open = !open"
    >
      <span
        v-if="project"
        class="h-2.5 w-2.5 shrink-0 rounded-full"
        :style="{ backgroundColor: project.color || 'var(--color-accent-500, #6366f1)' }"
        aria-hidden="true"
      />
      <Icon
        v-else
        icon="lucide:folder-plus"
        class="h-3.5 w-3.5 shrink-0"
      />
      <span class="hidden truncate md:inline">{{ project?.name ?? 'Project' }}</span>
    </button>

    <div
      v-if="open"
      role="menu"
      class="absolute left-0 top-full z-40 mt-1 w-64 overflow-hidden rounded-lg border border-theme-700 bg-theme-900 py-1 shadow-xl"
      @click.stop
    >
      <template v-if="project">
        <button
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
          @click="openProject"
        >
          <Icon
            icon="lucide:folder-open"
            class="h-3.5 w-3.5 text-ink-muted"
          />
          Open {{ project.name }}
        </button>
        <button
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
          @click="choose(null)"
        >
          <Icon
            icon="lucide:folder-minus"
            class="h-3.5 w-3.5 text-ink-muted"
          />
          {{ isNewChat ? 'Start outside the project' : 'Remove from project' }}
        </button>
        <div class="my-1 border-t border-theme-800" />
      </template>

      <div class="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
        {{ project ? 'Move to' : (isNewChat ? 'Start in project' : 'Add to project') }}
      </div>
      <div class="max-h-64 overflow-y-auto">
        <button
          v-for="candidate in choices"
          :key="candidate.id"
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
          @click="choose(candidate.id)"
        >
          <span
            class="h-2.5 w-2.5 shrink-0 rounded-full"
            :style="{ backgroundColor: candidate.color || 'var(--color-accent-500, #6366f1)' }"
            aria-hidden="true"
          />
          <span class="truncate">{{ candidate.name }}</span>
        </button>
        <p
          v-if="!choices.length"
          class="px-3 py-2 text-xs text-ink-faint"
        >
          No {{ project ? 'other ' : '' }}projects yet.
        </p>
      </div>
      <div class="my-1 border-t border-theme-800" />
      <button
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
        @click="newProject"
      >
        <Icon
          icon="lucide:plus"
          class="h-3.5 w-3.5 text-ink-muted"
        />
        New project…
      </button>
    </div>

    <p
      v-if="error"
      role="alert"
      class="absolute left-0 top-full mt-1 w-56 rounded bg-status-danger/10 px-2 py-1 text-[11px] text-status-danger"
    >
      {{ error }}
    </p>
  </div>
</template>
