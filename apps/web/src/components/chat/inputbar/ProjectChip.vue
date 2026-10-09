<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { Icon } from '@iconify/vue'
import { useChatStore } from '../../../stores/chat.store'
import { useProjectsStore } from '../../../stores/projects.store'
import ProjectIcon from '../../project/ProjectIcon.vue'

const chatStore = useChatStore()
const projectsStore = useProjectsStore()
const project = computed(() => projectsStore.get(chatStore.activeProjectId))

onMounted(() => { void projectsStore.ensureLoaded().catch(() => undefined) })
</script>

<template>
  <span
    v-if="project"
    class="inline-flex min-w-0 shrink items-center gap-1 rounded-full border border-theme-700 bg-theme-800 py-1 pl-2 pr-1 text-xs text-theme-200 shadow-sm"
    data-testid="project-chip"
  >
    <ProjectIcon
      :project="project"
      class="h-3.5 w-3.5"
    />
    <RouterLink
      :to="{ name: 'project-detail', params: { id: project.id } }"
      class="max-w-36 truncate hover:text-theme-100 focus-visible:outline-none focus-visible:underline"
      :title="`Project: ${project.name}`"
    >{{ project.name }}</RouterLink>
    <button
      type="button"
      class="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-theme-700 hover:text-theme-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
      :aria-label="chatStore.activeConversationId ? `Remove this chat from ${project.name}` : `Start outside ${project.name}`"
      @click="chatStore.setConversationProject(null)"
    >
      <Icon
        icon="lucide:x"
        class="h-3 w-3"
      />
    </button>
  </span>
</template>
