<template>
  <div class="max-w-2xl mx-auto px-4 py-6 w-full space-y-4">
    <div class="mb-5">
      <h2 class="text-xl font-bold text-zinc-100">
        Memory Space Ready
      </h2>
      <p class="text-sm text-zinc-500 mt-1">
        Cynosure includes a default memory space automatically. You can upload documents now,
        and create additional spaces later from the Memory section.
      </p>
    </div>

    <!-- Space creation -->
    <div class="bg-zinc-800/50 border border-zinc-700/60 rounded-xl p-5 space-y-4">
      <h3 class="text-sm font-semibold text-zinc-200">
        Active Space
      </h3>

      <div v-if="!createdSpace && !loadingSpace">
        <label class="block text-xs font-medium text-zinc-400 mb-1.5">Space Name</label>
        <div class="flex gap-2">
          <input
            v-model="spaceName"
            type="text"
            placeholder="e.g. Personal Knowledge Base"
            class="flex-1 bg-zinc-900 border border-zinc-600 text-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
            @keydown.enter="createSpace"
          >
          <button
            class="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
            :disabled="!spaceName.trim() || creatingSpace"
            @click="createSpace"
          >
            <Icon
              :icon="creatingSpace ? 'lucide:loader-2' : 'lucide:plus'"
              class="w-4 h-4"
              :class="{ 'animate-spin': creatingSpace }"
            />
            {{ creatingSpace ? 'Creating…' : 'Create' }}
          </button>
        </div>
        <p
          v-if="spaceError"
          class="text-xs text-red-400 mt-2"
        >
          {{ spaceError }}
        </p>
      </div>

      <div
        v-else-if="loadingSpace"
        class="flex items-center gap-2 text-zinc-500 text-sm"
      >
        <Icon
          icon="lucide:loader-2"
          class="w-4 h-4 animate-spin"
        />
        Loading default memory space…
      </div>

      <!-- Space created confirmation -->
      <div
        v-else
        class="flex items-center gap-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-3"
      >
        <Icon
          icon="lucide:brain"
          class="w-5 h-5 text-emerald-400 shrink-0"
        />
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-zinc-100">
            {{ createdSpace.name }}
          </p>
          <p class="text-xs text-zinc-500">
            Memory space ready
          </p>
        </div>
        <Icon
          icon="lucide:check-circle-2"
          class="w-4 h-4 text-emerald-400 shrink-0"
        />
      </div>
    </div>

    <!-- Document upload (shown after space is created) -->
    <Transition name="slide-down">
      <div
        v-if="createdSpace"
        class="bg-zinc-800/50 border border-zinc-700/60 rounded-xl p-5 space-y-4"
      >
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold text-zinc-200">
            Add Documents <span class="font-normal text-zinc-500">(optional)</span>
          </h3>
          <span class="text-xs text-zinc-600">txt, md, pdf, docx, and more</span>
        </div>
        <p class="text-xs text-zinc-500">
          Upload documents now to give your agents immediate context. You can always add more later.
        </p>

        <!-- Upload drop zone -->
        <div
          class="border-2 border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer"
          :class="dragging
            ? 'border-blue-500 bg-blue-500/5'
            : 'border-zinc-700 hover:border-zinc-500'"
          @click="fileInput?.click()"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <Icon
            :icon="uploading ? 'lucide:loader-2' : 'lucide:upload-cloud'"
            class="w-8 h-8 mx-auto mb-2"
            :class="[uploading ? 'animate-spin text-blue-400' : 'text-zinc-500']"
          />
          <p class="text-sm text-zinc-400">
            {{ uploading ? `Uploading ${uploadProgress.current} / ${uploadProgress.total}…` : 'Click or drag files here to upload' }}
          </p>
          <input
            ref="fileInput"
            type="file"
            multiple
            class="hidden"
            accept=".txt,.md,.csv,.json,.pdf,.docx,.pptx,.xlsx,.odt,.odp,.ods,.rtf"
            @change="onFileChange"
          >
        </div>

        <!-- Upload results -->
        <div
          v-if="uploadResults.length"
          class="space-y-1.5"
        >
          <div
            v-for="r in uploadResults"
            :key="r.fileName"
            class="flex items-center gap-2 text-xs rounded-lg px-3 py-2"
            :class="r.error ? 'bg-red-500/10 text-red-300' : 'bg-emerald-500/10 text-emerald-300'"
          >
            <Icon
              :icon="r.error ? 'lucide:x-circle' : 'lucide:file-check'"
              class="w-3.5 h-3.5 shrink-0"
            />
            <span class="font-medium truncate">{{ r.fileName }}</span>
            <span
              v-if="!r.error"
              class="text-zinc-500 shrink-0"
            >{{ r.chunks }} chunk{{ r.chunks !== 1 ? 's' : '' }}</span>
            <span
              v-else
              class="text-red-400/80 shrink-0"
            >{{ r.error }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../../api/client'
import type { MemorySpace } from '../../api/types'

const spaceName = ref('Personal Knowledge Base')
const creatingSpace = ref(false)
const loadingSpace = ref(false)
const createdSpace = ref<MemorySpace | null>(null)
const spaceError = ref('')

const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const uploading = ref(false)
const uploadProgress = ref({ current: 0, total: 0 })
const uploadResults = ref<{ fileName: string; chunks: number; error?: string }[]>([])

const PARSEABLE_DOC_EXTENSIONS = new Set([
  '.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods', '.pdf', '.rtf',
])

function readFileContent(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (PARSEABLE_DOC_EXTENSIONS.has(ext)) {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.readAsDataURL(file)
    } else {
      file.text().then(resolve, reject)
    }
  })
}

async function createSpace() {
  if (!spaceName.value.trim()) return
  creatingSpace.value = true
  spaceError.value = ''
  try {
    createdSpace.value = await api.memorySpaces.create(spaceName.value.trim())
  } catch (e) {
    spaceError.value = e instanceof Error ? e.message : 'Failed to create memory space'
  } finally {
    creatingSpace.value = false
  }
}

async function loadInitialSpace() {
  loadingSpace.value = true
  spaceError.value = ''
  try {
    const spaces = await api.memorySpaces.list()
    const defaultSpace = spaces.find((s) => s.isDefault)
    createdSpace.value = defaultSpace || spaces[0] || null
  } catch (e) {
    spaceError.value = e instanceof Error ? e.message : 'Failed to load memory spaces'
  } finally {
    loadingSpace.value = false
  }
}

async function ingestFiles(files: File[]) {
  if (!createdSpace.value) return
  uploading.value = true
  uploadProgress.value = { current: 0, total: files.length }
  const results: typeof uploadResults.value = []
  for (const file of files) {
    uploadProgress.value.current++
    if (file.size > 10 * 1024 * 1024) {
      results.push({ fileName: file.name, chunks: 0, error: 'File too large (max 10 MB)' })
      uploadResults.value = [...results]
      continue
    }
    try {
      const content = await readFileContent(file)
      const res = await api.memorySpaces.ingestFile(createdSpace.value.id, file.name, content)
      results.push({ fileName: res.fileName, chunks: res.chunksStored })
    } catch (err) {
      results.push({ fileName: file.name, chunks: 0, error: (err as Error).message })
    }
    uploadResults.value = [...results]
  }
  uploadResults.value = results
  uploading.value = false
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files?.length) return
  ingestFiles(Array.from(input.files))
  input.value = ''
}

function onDrop(event: DragEvent) {
  dragging.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length) ingestFiles(files)
}

onMounted(() => {
  void loadInitialSpace()
})
</script>

<style scoped>
.slide-down-enter-from { opacity: 0; transform: translateY(-10px); }
.slide-down-enter-active { transition: opacity 0.3s ease, transform 0.3s ease; }
.slide-down-leave-to { opacity: 0; }
.slide-down-leave-active { transition: opacity 0.2s ease; }
</style>
