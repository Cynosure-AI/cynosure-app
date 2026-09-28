<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../../../api/client'
import type { ActivityArtifact, ActivityItem, ConversationUpload } from '../../../api/types'
import ModalDialog from '../../shared/ModalDialog.vue'
import TabBar, { type TabDef } from '../../shared/TabBar.vue'

type LibraryTab = 'attachments' | 'generated'
type ArtifactSelection = ActivityArtifact & { id: string }

const props = defineProps<{
  show: boolean
  alreadySelectedIds?: string[]
}>()

const emit = defineEmits<{
  close: []
  add: [selection: {
    images: { id: string; name: string; url: string }[]
    files: { id: string; name: string; content?: string; existingAttachmentId?: string }[]
    audio: { id: string; name: string; url: string }[]
  }]
}>()

const PAGE_SIZE = 60
const tabs: TabDef<LibraryTab>[] = [
  { value: 'attachments', label: 'Attachments', icon: 'lucide:paperclip' },
  { value: 'generated', label: 'Generated', icon: 'lucide:sparkles' },
]
const activeTab = ref<LibraryTab>('attachments')
const uploads = ref<ConversationUpload[]>([])
const artifactItems = ref<ActivityItem[]>([])
const uploadTotal = ref(0)
const artifactsHaveMore = ref(false)
const query = ref('')
const selectedUploadIds = ref(new Set<string>())
const selectedArtifacts = ref(new Map<string, ArtifactSelection>())
const loading = ref(false)
const adding = ref(false)
const error = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null
let requestSequence = 0

const artifactEntries = computed(() => {
  const entries: (ArtifactSelection & { conversationTitle: string; createdAt: number })[] = []
  const seen = new Set<string>()
  for (const item of artifactItems.value) {
    for (const [index, artifact] of (item.artifacts || []).entries()) {
      if (seen.has(artifact.href)) continue
      seen.add(artifact.href)
      entries.push({ ...artifact, id: `${item.id}:${index}`, conversationTitle: item.description, createdAt: item.createdAt })
    }
  }
  return entries
})
const hasMore = computed(() => activeTab.value === 'attachments'
  ? uploads.value.length < uploadTotal.value
  : artifactsHaveMore.value)
const selectedCount = computed(() => selectedUploadIds.value.size + selectedArtifacts.value.size)
const unavailableIds = computed(() => new Set(props.alreadySelectedIds || []))
const visibleCount = computed(() => activeTab.value === 'attachments' ? uploads.value.length : artifactEntries.value.length)

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(timestamp)
}

function artifactIcon(kind: ActivityArtifact['kind']): string {
  if (kind === 'image') return 'lucide:image'
  if (kind === 'video') return 'lucide:film'
  if (kind === 'audio') return 'lucide:audio-lines'
  return 'lucide:file-text'
}

async function loadEntries(reset = true): Promise<void> {
  const sequence = ++requestSequence
  loading.value = true
  error.value = ''
  try {
    if (activeTab.value === 'attachments') {
      const offset = reset ? 0 : uploads.value.length
      const response = await api.chat.listUploads(PAGE_SIZE, offset, query.value)
      if (sequence !== requestSequence) return
      uploads.value = reset ? response.items : [...uploads.value, ...response.items]
      uploadTotal.value = response.total
    } else {
      const offset = reset ? 0 : artifactItems.value.length
      const response = await api.activity.list({ limit: PAGE_SIZE, offset, types: ['artifact'], search: query.value })
      if (sequence !== requestSequence) return
      artifactItems.value = reset ? response.items : [...artifactItems.value, ...response.items]
      artifactsHaveMore.value = Boolean(response.hasMore)
    }
  } catch (err) {
    if (sequence === requestSequence) error.value = err instanceof Error ? err.message : 'Could not load library'
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}

function toggleUpload(upload: ConversationUpload): void {
  if (unavailableIds.value.has(upload.id) || upload.staged || (upload.status && upload.status !== 'ready')) return
  const next = new Set(selectedUploadIds.value)
  if (next.has(upload.id)) next.delete(upload.id)
  else next.add(upload.id)
  selectedUploadIds.value = next
}

function toggleArtifact(artifact: ArtifactSelection): void {
  if (artifact.kind === 'video' || unavailableIds.value.has(artifact.id)) return
  const next = new Map(selectedArtifacts.value)
  if (next.has(artifact.id)) next.delete(artifact.id)
  else next.set(artifact.id, artifact)
  selectedArtifacts.value = next
}

async function addSelected(): Promise<void> {
  if (!selectedCount.value || adding.value) return
  adding.value = true
  error.value = ''
  try {
    const [uploadsResponse, artifactsResponse] = await Promise.all([
      selectedUploadIds.value.size ? api.chat.resolveUploads([...selectedUploadIds.value]) : Promise.resolve({ files: [] }),
      selectedArtifacts.value.size ? api.chat.resolveArtifacts([...selectedArtifacts.value.values()]) : Promise.resolve({ images: [], audio: [], files: [] }),
    ])
    emit('add', {
      images: artifactsResponse.images,
      audio: artifactsResponse.audio,
      files: [
        ...uploadsResponse.files,
        ...artifactsResponse.files,
      ],
    })
    emit('close')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not add the selected context'
  } finally {
    adding.value = false
  }
}

function selectTab(tab: LibraryTab): void {
  if (activeTab.value === tab) return
  activeTab.value = tab
  query.value = ''
  void loadEntries()
}

watch(() => props.show, (show) => {
  if (!show) return
  activeTab.value = 'attachments'
  query.value = ''
  selectedUploadIds.value = new Set()
  selectedArtifacts.value = new Map()
  void loadEntries()
})

watch(query, () => {
  if (!props.show) return
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void loadEntries(), 250)
})
</script>

<template>
  <ModalDialog
    :show="show"
    title="Select From Library"
    icon="lucide:library"
    max-width="max-w-4xl"
    max-height="max-h-[82vh]"
    @close="emit('close')"
  >
    <div class="flex h-[min(66vh,660px)] min-h-80 flex-col gap-4">
      <TabBar
        :tabs="tabs"
        :model-value="activeTab"
        @update:model-value="selectTab"
      />

      <label class="relative block shrink-0">
        <span class="sr-only">Filter {{ activeTab }}</span>
        <Icon
          icon="lucide:search"
          class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
        />
        <input
          v-model="query"
          type="search"
          :placeholder="activeTab === 'attachments' ? 'Filter uploaded files…' : 'Filter generated files…'"
          class="w-full rounded-lg border border-theme-700 bg-theme-800 py-2.5 pl-9 pr-3 text-sm text-theme-100 outline-none placeholder:text-ink-muted focus:border-accent-500"
        >
      </label>

      <div
        v-if="error"
        class="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
      >
        <Icon
          icon="lucide:circle-alert"
          class="h-4 w-4 shrink-0"
        />
        <span>{{ error }}</span>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto pr-1">
        <div
          v-if="loading && !visibleCount"
          class="flex h-full items-center justify-center text-sm text-ink-muted"
        >
          <Icon
            icon="lucide:loader-circle"
            class="mr-2 h-4 w-4 animate-spin"
          /> Loading {{ activeTab }}…
        </div>
        <div
          v-else-if="!visibleCount"
          class="flex h-full flex-col items-center justify-center text-center text-ink-muted"
        >
          <Icon
            :icon="query ? 'lucide:search-x' : activeTab === 'attachments' ? 'lucide:files' : 'lucide:sparkles'"
            class="mb-3 h-9 w-9"
          />
          <p class="text-sm text-theme-300">
            {{ query ? 'No matching items' : activeTab === 'attachments' ? 'No uploaded files yet' : 'No generated files yet' }}
          </p>
          <p class="mt-1 text-xs">
            {{ activeTab === 'attachments' ? 'Files attached to sent messages will appear here.' : 'Generated images, audio, videos, and documents will appear here.' }}
          </p>
        </div>

        <div
          v-else-if="activeTab === 'attachments'"
          class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
        >
          <button
            v-for="upload in uploads"
            :key="upload.id"
            type="button"
            class="group min-w-0 rounded-xl border p-3 text-left transition-colors"
            :class="[selectedUploadIds.has(upload.id) ? 'border-accent-500 bg-accent-500/10' : 'border-theme-700 bg-theme-800 hover:border-theme-600 hover:bg-theme-700', unavailableIds.has(upload.id) || upload.staged || (upload.status && upload.status !== 'ready') ? 'cursor-default opacity-50' : '']"
            :disabled="unavailableIds.has(upload.id) || upload.staged || (upload.status && upload.status !== 'ready')"
            :aria-pressed="selectedUploadIds.has(upload.id)"
            @click="toggleUpload(upload)"
          >
            <div class="flex items-start gap-3">
              <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-theme-700 text-theme-300">
                <Icon
                  icon="lucide:file-text"
                  class="h-5 w-5"
                />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="truncate text-sm font-medium text-theme-100">{{ upload.name }}</span><Icon
                    v-if="selectedUploadIds.has(upload.id)"
                    icon="lucide:circle-check"
                    class="h-4 w-4 shrink-0 text-accent-fg"
                  />
                </div>
                <p
                  v-if="upload.status && upload.status !== 'ready'"
                  class="mt-1 text-[11px]"
                  :class="upload.status === 'failed' ? 'text-status-danger' : 'text-accent-fg'"
                >
                  {{ upload.status === 'failed' ? 'Indexing failed' : `Indexing ${upload.progressCurrent || 0}/${upload.progressTotal || '?'} chunks` }}
                </p>
                <p
                  v-else-if="upload.staged"
                  class="mt-1 text-[11px] text-accent-fg"
                >
                  Ready in chat draft
                </p>
                <p class="mt-1 truncate text-xs text-ink-muted">
                  {{ upload.conversationTitle }}
                </p>
                <p class="mt-1 text-[11px] text-ink-faint">
                  {{ formatSize(upload.sizeBytes) }} · {{ formatDate(upload.createdAt) }}
                </p>
                <p
                  v-if="unavailableIds.has(upload.id)"
                  class="mt-1 text-[11px] text-ink-secondary"
                >
                  Already attached
                </p>
              </div>
            </div>
          </button>
        </div>

        <div
          v-else
          class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
        >
          <button
            v-for="artifact in artifactEntries"
            :key="artifact.id"
            type="button"
            class="group min-w-0 overflow-hidden rounded-xl border text-left transition-colors"
            :class="[selectedArtifacts.has(artifact.id) ? 'border-accent-500 bg-accent-500/10' : 'border-theme-700 bg-theme-800 hover:border-theme-600 hover:bg-theme-700', artifact.kind === 'video' || unavailableIds.has(artifact.id) ? 'cursor-default opacity-50' : '']"
            :disabled="artifact.kind === 'video' || unavailableIds.has(artifact.id)"
            :aria-pressed="selectedArtifacts.has(artifact.id)"
            @click="toggleArtifact(artifact)"
          >
            <div
              v-if="artifact.kind === 'image'"
              class="h-24 w-full overflow-hidden bg-theme-950"
            >
              <img
                :src="artifact.href"
                :alt="artifact.label"
                class="h-full w-full object-cover"
                loading="lazy"
              >
            </div>
            <div class="flex items-start gap-3 p-3">
              <div
                v-if="artifact.kind !== 'image'"
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-theme-700 text-theme-300"
              >
                <Icon
                  :icon="artifactIcon(artifact.kind)"
                  class="h-5 w-5"
                />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="truncate text-sm font-medium text-theme-100">{{ artifact.label }}</span><Icon
                    v-if="selectedArtifacts.has(artifact.id)"
                    icon="lucide:circle-check"
                    class="h-4 w-4 shrink-0 text-accent-fg"
                  />
                </div>
                <p class="mt-1 truncate text-xs text-ink-muted">
                  {{ artifact.conversationTitle }}
                </p>
                <p class="mt-1 text-[11px] text-ink-faint">
                  {{ artifact.ext }} · {{ formatDate(artifact.createdAt) }}
                </p>
                <p
                  v-if="artifact.kind === 'video'"
                  class="mt-1 text-[11px] text-ink-secondary"
                >
                  Video context is not supported yet
                </p>
                <p
                  v-else-if="unavailableIds.has(artifact.id)"
                  class="mt-1 text-[11px] text-ink-secondary"
                >
                  Already attached
                </p>
              </div>
            </div>
          </button>
        </div>

        <button
          v-if="hasMore"
          type="button"
          class="mx-auto mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-ink-secondary hover:bg-theme-800 hover:text-theme-200 disabled:opacity-50"
          :disabled="loading"
          @click="loadEntries(false)"
        >
          <Icon
            v-if="loading"
            icon="lucide:loader-circle"
            class="h-3.5 w-3.5 animate-spin"
          /> Load more
        </button>
      </div>

      <div class="flex shrink-0 items-center justify-between border-t border-theme-800 pt-4">
        <span class="text-xs text-ink-muted">{{ selectedCount }} selected</span>
        <div class="flex gap-2">
          <button
            type="button"
            class="rounded-lg px-3 py-2 text-sm text-theme-300 hover:bg-theme-800"
            @click="emit('close')"
          >
            Cancel
          </button>
          <button
            type="button"
            class="flex items-center gap-2 rounded-lg accent-action bg-accent-500 px-4 py-2 text-sm font-medium text-accent-on hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!selectedCount || adding"
            @click="addSelected"
          >
            <Icon
              v-if="adding"
              icon="lucide:loader-circle"
              class="h-4 w-4 animate-spin"
            /> Add {{ selectedCount ? `(${selectedCount})` : '' }}
          </button>
        </div>
      </div>
    </div>
  </ModalDialog>
</template>
