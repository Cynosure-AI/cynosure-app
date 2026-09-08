<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../../../api/client'
import type { ConversationUpload } from '../../../api/types'
import ModalDialog from '../../shared/ModalDialog.vue'

const props = defineProps<{
  show: boolean
  alreadySelectedIds?: string[]
}>()

const emit = defineEmits<{
  close: []
  add: [files: { id: string; name: string; content: string }[]]
}>()

const PAGE_SIZE = 60
const uploads = ref<ConversationUpload[]>([])
const total = ref(0)
const query = ref('')
const selectedIds = ref(new Set<string>())
const loading = ref(false)
const adding = ref(false)
const error = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null
let requestSequence = 0

const hasMore = computed(() => uploads.value.length < total.value)
const selectedCount = computed(() => selectedIds.value.size)
const unavailableIds = computed(() => new Set(props.alreadySelectedIds || []))

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(timestamp)
}

async function loadUploads(reset = true): Promise<void> {
  const sequence = ++requestSequence
  loading.value = true
  error.value = ''
  try {
    const offset = reset ? 0 : uploads.value.length
    const response = await api.chat.listUploads(PAGE_SIZE, offset, query.value)
    if (sequence !== requestSequence) return
    uploads.value = reset ? response.items : [...uploads.value, ...response.items]
    total.value = response.total
  } catch (err) {
    if (sequence === requestSequence) error.value = err instanceof Error ? err.message : 'Could not load uploads'
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}

function toggle(upload: ConversationUpload): void {
  if (unavailableIds.value.has(upload.id)) return
  const next = new Set(selectedIds.value)
  if (next.has(upload.id)) next.delete(upload.id)
  else next.add(upload.id)
  selectedIds.value = next
}

async function addSelected(): Promise<void> {
  if (!selectedIds.value.size || adding.value) return
  adding.value = true
  error.value = ''
  try {
    const response = await api.chat.resolveUploads([...selectedIds.value])
    emit('add', response.files)
    emit('close')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not add the selected uploads'
  } finally {
    adding.value = false
  }
}

watch(() => props.show, (show) => {
  if (!show) return
  query.value = ''
  selectedIds.value = new Set()
  void loadUploads()
})

watch(query, () => {
  if (!props.show) return
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void loadUploads(), 250)
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
    <div class="flex h-[min(62vh,620px)] min-h-80 flex-col gap-4">
      <label class="relative block shrink-0">
        <span class="sr-only">Filter uploaded files</span>
        <Icon
          icon="lucide:search"
          class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-500"
        />
        <input
          v-model="query"
          type="search"
          placeholder="Filter uploaded files…"
          class="w-full rounded-lg border border-theme-700 bg-theme-800 py-2.5 pl-9 pr-3 text-sm text-theme-100 outline-none placeholder:text-theme-500 focus:border-accent-500"
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
          v-if="loading && !uploads.length"
          class="flex h-full items-center justify-center text-sm text-theme-500"
        >
          <Icon
            icon="lucide:loader-circle"
            class="mr-2 h-4 w-4 animate-spin"
          />
          Loading uploads…
        </div>
        <div
          v-else-if="!uploads.length"
          class="flex h-full flex-col items-center justify-center text-center text-theme-500"
        >
          <Icon
            :icon="query ? 'lucide:search-x' : 'lucide:files'"
            class="mb-3 h-9 w-9"
          />
          <p class="text-sm text-theme-300">
            {{ query ? 'No matching files' : 'No uploaded files yet' }}
          </p>
          <p class="mt-1 text-xs">
            Files attached to sent messages will appear here.
          </p>
        </div>
        <div
          v-else
          class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
        >
          <button
            v-for="upload in uploads"
            :key="upload.id"
            type="button"
            class="group min-w-0 rounded-xl border p-3 text-left transition-colors"
            :class="[
              selectedIds.has(upload.id) ? 'border-accent-500 bg-accent-500/10' : 'border-theme-700 bg-theme-800 hover:border-theme-600 hover:bg-theme-700',
              unavailableIds.has(upload.id) ? 'cursor-default opacity-50' : '',
            ]"
            :disabled="unavailableIds.has(upload.id)"
            :aria-pressed="selectedIds.has(upload.id)"
            @click="toggle(upload)"
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
                  <span class="truncate text-sm font-medium text-theme-100">{{ upload.name }}</span>
                  <Icon
                    v-if="selectedIds.has(upload.id)"
                    icon="lucide:circle-check"
                    class="h-4 w-4 shrink-0 text-accent-400"
                  />
                </div>
                <p class="mt-1 truncate text-xs text-theme-500">
                  {{ upload.conversationTitle }}
                </p>
                <p class="mt-1 text-[11px] text-theme-600">
                  {{ formatSize(upload.sizeBytes) }} · {{ formatDate(upload.createdAt) }}
                </p>
                <p
                  v-if="unavailableIds.has(upload.id)"
                  class="mt-1 text-[11px] text-theme-400"
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
          class="mx-auto mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-theme-400 hover:bg-theme-800 hover:text-theme-200 disabled:opacity-50"
          :disabled="loading"
          @click="loadUploads(false)"
        >
          <Icon
            v-if="loading"
            icon="lucide:loader-circle"
            class="h-3.5 w-3.5 animate-spin"
          />
          Load more
        </button>
      </div>

      <div class="flex shrink-0 items-center justify-between border-t border-theme-800 pt-4">
        <span class="text-xs text-theme-500">{{ selectedCount }} selected</span>
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
            class="flex items-center gap-2 rounded-lg bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!selectedCount || adding"
            @click="addSelected"
          >
            <Icon
              v-if="adding"
              icon="lucide:loader-circle"
              class="h-4 w-4 animate-spin"
            />
            Add {{ selectedCount ? `(${selectedCount})` : '' }}
          </button>
        </div>
      </div>
    </div>
  </ModalDialog>
</template>
