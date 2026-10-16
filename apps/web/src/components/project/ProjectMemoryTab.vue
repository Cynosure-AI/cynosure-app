<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import type { ProjectDto } from '@shared/types'
import MemoryDocumentSection from '../memory/MemoryDocumentSection.vue'
import MemoryFolderDialogs from '../memory/MemoryFolderDialogs.vue'
import { useChatStore } from '../../stores/chat.store'

/** The project's memory folder and its subfolders, browsed with the same explorer as the Memory page. */
const props = defineProps<{ project: ProjectDto }>()
const emit = defineEmits<{ openSettings: [] }>()

const chatStore = useChatStore()
const route = useRoute()
const router = useRouter()
const loading = ref(false)
/** The subfolder named in the address, or the project folder when there is none. */
const linkedFolderId = computed(() => typeof route.query.folder === 'string' ? route.query.folder : props.project.memoryFolderId ?? null)
const selectedFolderId = ref<string | null>(linkedFolderId.value)
const folderDialogs = ref<InstanceType<typeof MemoryFolderDialogs> | null>(null)
const actionError = ref('')

const rootFolder = computed(() => chatStore.memoryFolders.find((folder) => folder.id === props.project.memoryFolderId) ?? null)
const scopedFolders = computed(() => {
  const root = rootFolder.value
  if (!root) return []
  return chatStore.memoryFolders.filter((folder) => folder.id === root.id || folder.folderPath.startsWith(`${root.folderPath}/`))
})
const selectedFolder = computed(() => scopedFolders.value.find((folder) => folder.id === selectedFolderId.value) ?? null)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    await chatStore.loadMemoryFolders()
  } finally {
    loading.value = false
  }
}

function showFolder(folderId: string): void {
  selectedFolderId.value = folderId
  void refresh()
}

// Keep the open subfolder in the address so a reload or a shared link returns to it.
watch(selectedFolderId, (folderId) => {
  const folder = folderId && folderId !== props.project.memoryFolderId ? folderId : undefined
  if (route.query.folder === folder) return
  void router.replace({ query: { ...route.query, folder } })
})

// Follow the address as well, for a link to another folder of this project opened while the tab is showing.
watch(linkedFolderId, (folderId) => {
  if (folderId !== selectedFolderId.value) selectedFolderId.value = folderId
})

// Stay inside the project folder: a removed subfolder, a stale link, or a changed project folder falls back to
// its root. Nothing is judged before the folders have loaded, so a linked subfolder survives a reload.
watch([() => props.project.memoryFolderId, scopedFolders], ([rootId]) => {
  if (!scopedFolders.value.length) return
  if (!selectedFolderId.value || !scopedFolders.value.some((folder) => folder.id === selectedFolderId.value)) {
    selectedFolderId.value = rootId ?? null
  }
}, { immediate: true }) // Registered last so the address watchers see its first correction.

onMounted(() => void refresh())
</script>

<template>
  <div
    v-if="!project.memoryFolderId"
    class="rounded-xl border border-dashed border-theme-700 px-6 py-12 text-center text-sm text-ink-muted"
  >
    <Icon
      icon="lucide:database"
      class="mx-auto mb-3 h-8 w-8 text-ink-faint"
    />
    <p>This project has no memory folder yet. Link or create one so agents can keep lasting knowledge for it.</p>
    <button
      type="button"
      class="mt-4 rounded-lg border border-theme-700 px-3 py-1.5 text-sm text-theme-300 hover:bg-theme-800"
      @click="emit('openSettings')"
    >
      Choose a memory folder
    </button>
  </div>

  <div
    v-else-if="!rootFolder"
    class="flex items-center justify-center gap-2 py-12 text-sm text-ink-muted"
  >
    <template v-if="loading">
      <Icon
        icon="lucide:loader-2"
        class="h-5 w-5 animate-spin"
      />
      Loading memory…
    </template>
    <div
      v-else
      class="text-center"
    >
      <p>The linked memory folder no longer exists.</p>
      <button
        type="button"
        class="mt-3 text-xs text-accent-fg hover:underline"
        @click="emit('openSettings')"
      >
        Choose another folder
      </button>
    </div>
  </div>

  <div v-else>
    <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
      <p class="max-w-2xl text-xs leading-relaxed text-ink-muted">
        Lasting facts and documents for this project. Agents working in the project read and add to this folder; you can browse, edit, and upload here.
      </p>
      <RouterLink
        :to="{ name: 'memory-folders', params: { section: 'documents' }, query: { folder: selectedFolderId || rootFolder.id } }"
        class="inline-flex shrink-0 items-center gap-1.5 text-xs text-ink-secondary hover:text-accent-fg"
      >
        <Icon
          icon="lucide:external-link"
          class="h-3.5 w-3.5"
        />
        Open in Memory
      </RouterLink>
    </div>

    <p
      v-if="actionError"
      role="alert"
      class="mb-3 flex items-center gap-2 rounded-lg bg-status-danger/10 px-3 py-2 text-sm text-status-danger"
    >
      <span class="min-w-0 flex-1">{{ actionError }}</span>
      <button
        type="button"
        class="shrink-0 rounded p-1 hover:bg-status-danger/10"
        aria-label="Dismiss error"
        @click="actionError = ''"
      >
        <Icon
          icon="lucide:x"
          class="h-3.5 w-3.5"
        />
      </button>
    </p>

    <MemoryDocumentSection
      v-model:selected-folder-id="selectedFolderId"
      :spaces="scopedFolders"
      :spaces-loading="loading"
      :selected-folder="selectedFolder"
      :root-folder-id="rootFolder.id"
      active-view="folder"
      @create-folder="folderDialogs?.openCreate($event ?? selectedFolder)"
      @edit-folder="folderDialogs?.openEdit($event)"
      @delete-folder="folderDialogs?.confirmRemove($event)"
      @toggle-auto-memory-exclusion="folderDialogs?.toggleAutoMemoryExclusion($event)"
      @refresh-spaces="refresh"
    />

    <MemoryFolderDialogs
      ref="folderDialogs"
      :spaces="scopedFolders"
      @saved="showFolder"
      @changed="refresh"
      @removed="refresh"
      @error="actionError = $event"
    />
  </div>
</template>
