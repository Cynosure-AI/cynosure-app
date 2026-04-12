<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { api } from '../api/client'
import type { MemorySpace } from '../api/client'
import { Icon } from '@iconify/vue'

// --- Space management ---
const spaces = ref<MemorySpace[]>([])
const spacesLoading = ref(false)
const selectedSpaceId = ref<string | null>(null)
const showCreateDialog = ref(false)
const editingSpace = ref<MemorySpace | null>(null)
const spaceName = ref('')
const spaceDescription = ref('')

const selectedSpace = computed(() => spaces.value.find(s => s.id === selectedSpaceId.value))

async function loadSpaces() {
  spacesLoading.value = true
  try {
    spaces.value = await api.memorySpaces.list()
    // Auto-select first space
    if (!selectedSpaceId.value && spaces.value.length > 0) {
      selectedSpaceId.value = spaces.value[0].id
    }
    // If selected space was deleted, clear selection
    if (selectedSpaceId.value && !spaces.value.find(s => s.id === selectedSpaceId.value)) {
      selectedSpaceId.value = spaces.value.length > 0 ? spaces.value[0].id : null
    }
  } catch { spaces.value = [] }
  spacesLoading.value = false
}

function openCreateDialog() {
  editingSpace.value = null
  spaceName.value = ''
  spaceDescription.value = ''
  showCreateDialog.value = true
}

function openEditDialog(space: MemorySpace) {
  editingSpace.value = space
  spaceName.value = space.name
  spaceDescription.value = space.description
  showCreateDialog.value = true
}

async function saveSpace() {
  if (!spaceName.value.trim()) return
  try {
    if (editingSpace.value) {
      await api.memorySpaces.update(editingSpace.value.id, { name: spaceName.value.trim(), description: spaceDescription.value })
    } else {
      const space = await api.memorySpaces.create(spaceName.value.trim(), spaceDescription.value)
      selectedSpaceId.value = space.id
    }
    await loadSpaces()
  } catch { /* error */ }
  showCreateDialog.value = false
}

async function deleteSpace(space: MemorySpace) {
  try {
    await api.memorySpaces.remove(space.id)
    await loadSpaces()
  } catch { /* error */ }
}

// --- Document management ---
interface DocumentGroup {
  sourceFile: string
  chunkCount: number
  createdAt: number
}

interface MemoryEntry {
  id: string
  text: string
  source: string
  tags?: string
  sourceFile?: string
  chunkIndex?: number
  createdAt: number
}

const groups = ref<DocumentGroup[]>([])
const groupsLoading = ref(false)
const groupChunks = ref<Map<string, MemoryEntry[]>>(new Map())
const groupChunksLoading = ref<Set<string>>(new Set())
const expandedGroup = ref<string | null>(null)
const groupViewMode = ref<Record<string, 'merged' | 'chunks'>>({})
const selectedGroups = ref<Set<string>>(new Set())
const deleting = ref(false)
const moving = ref(false)
const exporting = ref(false)
const showMoveDialog = ref(false)

// Document viewer modal
const showDocumentModal = ref(false)
const modalSourceFile = ref('')
const modalViewMode = ref<'merged' | 'chunks'>('merged')

// Upload
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadProgress = ref({ current: 0, total: 0 })
const uploadResults = ref<{ fileName: string; chunks: number; error?: string }[]>([])

// Reingest
const reingestingGroup = ref<string | null>(null)
const reingestFileInput = ref<HTMLInputElement | null>(null)
let pendingReingestSourceFile = ''

// Search + pagination
const GROUPS_PAGE_SIZE = 30
const searchQuery = ref('')
const page = ref(0)

const filteredGroups = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return groups.value
  return groups.value.filter(g => (g.sourceFile || '').toLowerCase().includes(q))
})
const totalPages = computed(() => Math.max(1, Math.ceil(filteredGroups.value.length / GROUPS_PAGE_SIZE)))
const pagedGroups = computed(() => {
  const start = page.value * GROUPS_PAGE_SIZE
  return filteredGroups.value.slice(start, start + GROUPS_PAGE_SIZE)
})

async function loadGroups() {
  if (!selectedSpaceId.value) { groups.value = []; return }
  groupsLoading.value = true
  try {
    groups.value = await api.memorySpaces.listGroups(selectedSpaceId.value)
  } catch { groups.value = [] }
  groupsLoading.value = false
}

async function loadGroupChunks(sourceFile: string) {
  if (!selectedSpaceId.value) return
  if (groupChunks.value.has(sourceFile) || groupChunksLoading.value.has(sourceFile)) return
  const loading = new Set(groupChunksLoading.value)
  loading.add(sourceFile)
  groupChunksLoading.value = loading
  try {
    const entries = await api.memorySpaces.listEntries(selectedSpaceId.value, sourceFile)
    const newMap = new Map(groupChunks.value)
    newMap.set(sourceFile, entries as MemoryEntry[])
    groupChunks.value = newMap
  } catch { /* error */ }
  const l2 = new Set(groupChunksLoading.value)
  l2.delete(sourceFile)
  groupChunksLoading.value = l2
}

function toggleExpandGroup(sourceFile: string) {
  modalSourceFile.value = sourceFile
  modalViewMode.value = 'merged'
  showDocumentModal.value = true
  loadGroupChunks(sourceFile)
}

function toggleSelectGroup(sourceFile: string) {
  const s = new Set(selectedGroups.value)
  if (s.has(sourceFile)) s.delete(sourceFile)
  else s.add(sourceFile)
  selectedGroups.value = s
}

function selectAllOnPage() {
  selectedGroups.value = new Set(pagedGroups.value.map(g => g.sourceFile))
}

function selectAll() {
  selectedGroups.value = new Set(filteredGroups.value.map(g => g.sourceFile))
}

const allFilteredSelected = computed(() =>
  filteredGroups.value.length > 0 &&
  filteredGroups.value.every(g => selectedGroups.value.has(g.sourceFile))
)

async function deleteSelectedGroups() {
  if (selectedGroups.value.size === 0 || !selectedSpaceId.value) return
  deleting.value = true
  try {
    await api.memorySpaces.deleteGroups(selectedSpaceId.value, Array.from(selectedGroups.value))
    const deleted = selectedGroups.value
    selectedGroups.value = new Set()
    const newMap = new Map(groupChunks.value)
    for (const sf of deleted) newMap.delete(sf)
    groupChunks.value = newMap
    groups.value = groups.value.filter(g => !deleted.has(g.sourceFile))
    // Update space document count locally
    const space = spaces.value.find(s => s.id === selectedSpaceId.value)
    if (space) space.documentCount = groups.value.length
  } catch { /* error */ }
  deleting.value = false
}

async function moveSelectedGroups(targetSpaceId: string) {
  if (selectedGroups.value.size === 0 || !selectedSpaceId.value || targetSpaceId === selectedSpaceId.value) return
  moving.value = true
  try {
    await api.memorySpaces.moveGroups(selectedSpaceId.value, Array.from(selectedGroups.value), targetSpaceId)
    const moved = selectedGroups.value
    selectedGroups.value = new Set()
    const newMap = new Map(groupChunks.value)
    for (const sf of moved) newMap.delete(sf)
    groupChunks.value = newMap
    groups.value = groups.value.filter(g => !moved.has(g.sourceFile))
    const space = spaces.value.find(s => s.id === selectedSpaceId.value)
    if (space) space.documentCount = groups.value.length
    showMoveDialog.value = false
    await loadSpaces()
  } catch { /* error */ }
  moving.value = false
}

// Upload
const PARSEABLE_DOC_EXTENSIONS = new Set([
  '.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods', '.pdf', '.rtf'
])

function isParseableDoc(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  return PARSEABLE_DOC_EXTENSIONS.has(ext)
}

/** Read file content — returns base64 data URL for document files, plain text otherwise */
function readFileContent(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (isParseableDoc(file.name)) {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.readAsDataURL(file)
    } else {
      file.text().then(resolve, reject)
    }
  })
}

async function handleFileUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const files = input.files
  if (!files?.length || !selectedSpaceId.value) return
  uploading.value = true
  uploadResults.value = []
  const fileList = Array.from(files)
  uploadProgress.value = { current: 0, total: fileList.length }
  const results: typeof uploadResults.value = []

  for (const file of fileList) {
    uploadProgress.value.current++
    if (file.size > 10 * 1024 * 1024) {
      results.push({ fileName: file.name, chunks: 0, error: 'File too large (max 10MB)' })
      continue
    }
    try {
      const content = await readFileContent(file)
      const res = await api.memorySpaces.ingestFile(selectedSpaceId.value!, file.name, content)
      results.push({ fileName: res.fileName, chunks: res.chunksStored })
    } catch (err) {
      results.push({ fileName: file.name, chunks: 0, error: (err as Error).message })
    }
    uploadResults.value = [...results]
  }
  uploadResults.value = results
  uploading.value = false
  input.value = ''
  // Invalidate and reload
  const newMap = new Map(groupChunks.value)
  for (const r of results) { if (!r.error) newMap.delete(r.fileName) }
  groupChunks.value = newMap
  loadGroups()
  loadSpaces()
}

// Reingest
function startReingest(sourceFile: string) {
  pendingReingestSourceFile = sourceFile
  reingestFileInput.value?.click()
}

async function handleReingestFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !pendingReingestSourceFile || !selectedSpaceId.value) return
  const sourceFile = pendingReingestSourceFile
  reingestingGroup.value = sourceFile
  try {
    const content = await readFileContent(file)
    const res = await api.memorySpaces.reingestFile(selectedSpaceId.value, sourceFile, content)
    const idx = groups.value.findIndex(g => g.sourceFile === sourceFile)
    if (idx !== -1) groups.value[idx] = { ...groups.value[idx], chunkCount: res.chunksStored, createdAt: Date.now() }
    const newMap = new Map(groupChunks.value)
    newMap.delete(sourceFile)
    groupChunks.value = newMap
    if (expandedGroup.value === sourceFile) loadGroupChunks(sourceFile)
  } catch { /* error */ }
  reingestingGroup.value = null
}

// View mode helpers
function getGroupViewMode(sf: string): 'merged' | 'chunks' { return groupViewMode.value[sf] || 'merged' }
function setGroupViewMode(sf: string, mode: 'merged' | 'chunks') { groupViewMode.value = { ...groupViewMode.value, [sf]: mode }; modalViewMode.value = mode }

function findOverlap(a: string, b: string): number {
  const maxLen = Math.min(a.length, b.length, 300)
  for (let len = maxLen; len > 0; len--) {
    if (a.endsWith(b.slice(0, len))) return len
  }
  return 0
}

function getMergedText(sf: string): string {
  const chunks = (groupChunks.value.get(sf) || []).slice().sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0))
  if (chunks.length === 0) return ''
  let result = chunks[0].text
  for (let i = 1; i < chunks.length; i++) {
    const overlap = findOverlap(result, chunks[i].text)
    result += chunks[i].text.slice(overlap)
  }
  return result
}

function getLoadedChunks(sf: string): MemoryEntry[] {
  return (groupChunks.value.get(sf) || []).slice().sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0))
}

async function exportSelectedDocuments() {
  exporting.value = true
  try {
    for (const sf of selectedGroups.value) {
      await exportDocument(sf)
    }
  } finally {
    exporting.value = false
  }
}

async function exportDocument(sourceFile: string) {
  // Ensure chunks are loaded
  if (!groupChunks.value.has(sourceFile)) {
    await loadGroupChunks(sourceFile)
  }
  let text = getMergedText(sourceFile)
  if (!text) return

  // Strip ingestion metadata header (e.g. [File: ...]\n---\nfrontmatter\n---\n)
  text = text.replace(/^\[File:[^\]]*\]\n(?:---\n[\s\S]*?\n---\n)?/, '').trimStart()

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = sourceFile || 'document.txt'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// Lifecycle
watch(selectedSpaceId, () => {
  groups.value = []
  groupChunks.value = new Map()
  expandedGroup.value = null
  selectedGroups.value = new Set()
  searchQuery.value = ''
  page.value = 0
  loadGroups()
})

onMounted(() => loadSpaces())
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-5xl mx-auto px-6 py-6">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-zinc-100">
            Memory Spaces
          </h1>
          <p class="text-sm text-zinc-500 mt-1">
            Shared knowledge bases that can be assigned to multiple agents.
          </p>
        </div>
        <button
          class="px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          @click="openCreateDialog"
        >
          <Icon
            icon="lucide:plus"
            class="w-4 h-4"
          />
          New Space
        </button>
      </div>

      <!-- Space selector cards -->
      <div
        v-if="spacesLoading && spaces.length === 0"
        class="flex items-center gap-2 py-8 justify-center text-zinc-500"
      >
        <Icon
          icon="lucide:loader-2"
          class="w-5 h-5 animate-spin"
        />
        Loading spaces…
      </div>

      <div
        v-else-if="spaces.length === 0"
        class="text-center py-12"
      >
        <Icon
          icon="lucide:database"
          class="w-10 h-10 text-zinc-600 mx-auto mb-3"
        />
        <p class="text-zinc-400 mb-1">
          No memory spaces yet
        </p>
        <p class="text-sm text-zinc-600">
          Create a space to start organizing knowledge for your agents.
        </p>
      </div>

      <template v-else>
        <!-- Space cards row -->
        <div class="flex gap-3 mb-6 overflow-x-auto pb-1">
          <button
            v-for="space in spaces"
            :key="space.id"
            class="flex-shrink-0 rounded-xl border px-4 py-3 text-left transition-colors min-w-48"
            :class="selectedSpaceId === space.id
              ? 'border-blue-500/50 bg-blue-500/10'
              : 'border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/60'"
            @click="selectedSpaceId = space.id"
          >
            <div class="flex items-center gap-2 mb-1">
              <Icon
                icon="lucide:database"
                class="w-4 h-4 text-zinc-400"
              />
              <span class="text-sm font-medium text-zinc-200 truncate">{{ space.name }}</span>
            </div>
            <div class="text-xs text-zinc-500">
              {{ space.documentCount }} document{{ space.documentCount !== 1 ? 's' : '' }}
            </div>
          </button>
        </div>

        <!-- Selected space header -->
        <div
          v-if="selectedSpace"
          class="flex items-center justify-between mb-4"
        >
          <div class="flex items-center gap-2">
            <h2 class="text-lg font-medium text-zinc-200">
              {{ selectedSpace.name }}
            </h2>
            <button
              class="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Edit space"
              @click="openEditDialog(selectedSpace!)"
            >
              <Icon
                icon="lucide:pencil"
                class="w-3.5 h-3.5"
              />
            </button>
            <button
              class="p-1 text-zinc-500 hover:text-red-400 transition-colors"
              title="Delete space"
              @click="deleteSpace(selectedSpace!)"
            >
              <Icon
                icon="lucide:trash-2"
                class="w-3.5 h-3.5"
              />
            </button>
          </div>
          <div class="flex items-center gap-2">
            <button
              :disabled="uploading"
              class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition-colors flex items-center gap-2 disabled:opacity-50"
              @click="fileInput?.click()"
            >
              <Icon
                :icon="uploading ? 'lucide:loader-2' : 'lucide:upload'"
                class="w-4 h-4"
                :class="{ 'animate-spin': uploading }"
              />
              Upload
            </button>
          </div>
        </div>

        <!-- Upload progress -->
        <div
          v-if="uploading"
          class="mb-4 px-3 py-2 bg-blue-500/10 border border-blue-500/20 rounded-lg text-xs text-blue-300"
        >
          Uploading {{ uploadProgress.current }}/{{ uploadProgress.total }}…
        </div>

        <!-- Upload results -->
        <div
          v-if="uploadResults.length > 0"
          class="mb-4 space-y-1"
        >
          <div
            v-for="(r, i) in uploadResults"
            :key="i"
            class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs"
            :class="r.error ? 'bg-red-500/10 text-red-300' : 'bg-green-500/10 text-green-300'"
          >
            <Icon
              :icon="r.error ? 'lucide:x-circle' : 'lucide:check-circle'"
              class="w-3.5 h-3.5"
            />
            <span class="truncate">{{ r.fileName }}</span>
            <span
              v-if="!r.error"
              class="text-zinc-500"
            >{{ r.chunks }} chunks</span>
            <span
              v-else
              class="text-red-400"
            >{{ r.error }}</span>
          </div>
          <button
            class="text-xs text-zinc-500 hover:text-zinc-300 px-1"
            @click="uploadResults = []"
          >
            Clear
          </button>
        </div>

        <!-- Document list -->
        <div v-if="selectedSpace">
          <!-- Toolbar -->
          <div class="flex items-center justify-between mb-2">
            <div class="text-xs text-zinc-500">
              {{ filteredGroups.length }} document{{ filteredGroups.length !== 1 ? 's' : '' }}
            </div>
            <div class="flex items-center gap-2">
              <template v-if="selectedGroups.size > 0">
                <button
                  class="flex items-center gap-1 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                  @click="selectedGroups = new Set()"
                >
                  Clear
                </button>
                <button
                  v-if="!allFilteredSelected"
                  class="flex items-center gap-1 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                  @click="selectAll"
                >
                  Select all {{ filteredGroups.length }}
                </button>
                <button
                  :disabled="exporting"
                  class="flex items-center gap-1 px-2 py-1 text-xs bg-green-500/10 text-green-400 hover:bg-green-500/20 rounded transition-colors"
                  @click="exportSelectedDocuments"
                >
                  <Icon
                    :icon="exporting ? 'lucide:loader-2' : 'lucide:download'"
                    class="w-3.5 h-3.5"
                    :class="{ 'animate-spin': exporting }"
                  />
                  Export {{ selectedGroups.size }}
                </button>
                <button
                  v-if="spaces.length > 1"
                  :disabled="moving"
                  class="flex items-center gap-1 px-2 py-1 text-xs bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded transition-colors"
                  @click="showMoveDialog = true"
                >
                  <Icon
                    :icon="moving ? 'lucide:loader-2' : 'lucide:move-right'"
                    class="w-3.5 h-3.5"
                    :class="{ 'animate-spin': moving }"
                  />
                  Move {{ selectedGroups.size }}
                </button>
                <button
                  :disabled="deleting"
                  class="flex items-center gap-1 px-2 py-1 text-xs bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded transition-colors"
                  @click="deleteSelectedGroups"
                >
                  <Icon
                    :icon="deleting ? 'lucide:loader-2' : 'lucide:trash-2'"
                    class="w-3.5 h-3.5"
                    :class="{ 'animate-spin': deleting }"
                  />
                  Delete {{ selectedGroups.size }}
                </button>
              </template>
              <template v-else-if="groups.length > 0">
                <button
                  class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                  @click="selectAllOnPage"
                >
                  Select page
                </button>
                <button
                  class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                  @click="selectAll"
                >
                  Select all {{ filteredGroups.length }}
                </button>
              </template>
              <button
                :disabled="groupsLoading"
                class="px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
                @click="loadGroups"
              >
                <Icon
                  :icon="groupsLoading ? 'lucide:loader-2' : 'lucide:refresh-cw'"
                  class="w-3.5 h-3.5"
                  :class="{ 'animate-spin': groupsLoading }"
                />
              </button>
            </div>
          </div>

          <!-- Search -->
          <div
            v-if="groups.length > 0"
            class="relative mb-3"
          >
            <Icon
              icon="lucide:search"
              class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500"
            />
            <input
              v-model="searchQuery"
              type="text"
              placeholder="Search documents…"
              class="w-full pl-9 pr-3 py-2 text-sm bg-zinc-800/60 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
              @input="page = 0"
            >
          </div>

          <!-- Empty states -->
          <div
            v-if="groups.length === 0 && !groupsLoading"
            class="text-center py-8 text-zinc-500 text-sm"
          >
            No documents in this space yet. Upload files to get started.
          </div>

          <div
            v-else-if="filteredGroups.length === 0 && searchQuery.trim()"
            class="text-center py-8 text-zinc-500 text-sm"
          >
            No documents matching "{{ searchQuery.trim() }}"
          </div>

          <!-- Document rows -->
          <div
            v-else
            class="space-y-2"
          >
            <!-- Top pagination -->
            <div
              v-if="totalPages > 1"
              class="flex items-center justify-center gap-2 mb-2"
            >
              <button
                :disabled="page === 0"
                class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
                @click="page = Math.max(0, page - 1)"
              >
                Prev
              </button>
              <span class="text-xs text-zinc-500">{{ page + 1 }} / {{ totalPages }}</span>
              <button
                :disabled="page >= totalPages - 1"
                class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
                @click="page = Math.min(totalPages - 1, page + 1)"
              >
                Next
              </button>
            </div>

            <div
              v-for="group in pagedGroups"
              :key="group.sourceFile"
              class="rounded-lg border border-zinc-800 overflow-hidden"
            >
              <!-- Group header -->
              <div
                class="group/row flex items-center gap-3 px-3 py-2.5 bg-zinc-800/30 hover:bg-zinc-800/60 transition-colors cursor-pointer"
                @click="toggleExpandGroup(group.sourceFile)"
              >
                <input
                  type="checkbox"
                  class="rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500/30"
                  :checked="selectedGroups.has(group.sourceFile)"
                  @click.stop
                  @change.stop="toggleSelectGroup(group.sourceFile)"
                >
                <Icon
                  icon="lucide:file-text"
                  class="w-4 h-4 text-zinc-400 shrink-0"
                />
                <span class="flex-1 text-sm text-zinc-200 truncate">
                  {{ group.sourceFile || 'Untitled' }}
                </span>
                <span
                  v-if="group.createdAt"
                  class="text-[11px] text-zinc-600 shrink-0"
                >
                  {{ new Date(group.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) }}
                </span>
                <span class="text-xs text-zinc-500 shrink-0">
                  {{ group.chunkCount }} chunk{{ group.chunkCount !== 1 ? 's' : '' }}
                </span>
                <!-- Update button on hover -->
                <button
                  class="p-1 rounded text-zinc-600 hover:text-blue-400 transition-colors shrink-0 opacity-0 group-hover/row:opacity-100"
                  :class="{ 'opacity-100!': reingestingGroup === group.sourceFile }"
                  title="Update document (re-ingest)"
                  @click.stop="startReingest(group.sourceFile)"
                >
                  <Icon
                    :icon="reingestingGroup === group.sourceFile ? 'lucide:loader-2' : 'lucide:refresh-cw'"
                    class="w-3.5 h-3.5"
                    :class="{ 'animate-spin': reingestingGroup === group.sourceFile }"
                  />
                </button>
                <Icon
                  v-if="!groupChunksLoading.has(group.sourceFile)"
                  icon="lucide:eye"
                  class="w-4 h-4 text-zinc-500 shrink-0"
                  title="View document"
                />
                <Icon
                  v-else
                  icon="lucide:loader-2"
                  class="w-4 h-4 text-zinc-500 shrink-0 animate-spin"
                />
              </div>
            </div>
          </div>

          <!-- Pagination -->
          <div
            v-if="totalPages > 1"
            class="flex items-center justify-center gap-2 mt-4"
          >
            <button
              :disabled="page === 0"
              class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
              @click="page = Math.max(0, page - 1)"
            >
              Prev
            </button>
            <span class="text-xs text-zinc-500">{{ page + 1 }} / {{ totalPages }}</span>
            <button
              :disabled="page >= totalPages - 1"
              class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
              @click="page = Math.min(totalPages - 1, page + 1)"
            >
              Next
            </button>
          </div>
        </div>
      </template>

      <!-- Hidden file inputs -->
      <input
        ref="fileInput"
        type="file"
        multiple
        accept=".txt,.md,.markdown,.json,.csv,.log,.xml,.yaml,.yml,.html,.htm,.toml,.ini,.cfg,.conf,.rst,.tex,.py,.js,.ts,.java,.c,.cpp,.h,.hpp,.go,.rs,.rb,.php,.sh,.bat,.ps1,.sql,.r,.swift,.kt,.docx,.pptx,.xlsx,.odt,.odp,.ods,.pdf,.rtf"
        class="hidden"
        @change="handleFileUpload"
      >
      <input
        ref="reingestFileInput"
        type="file"
        accept=".txt,.md,.markdown,.json,.csv,.log,.xml,.yaml,.yml,.html,.htm,.toml,.ini,.cfg,.conf,.rst,.tex,.py,.js,.ts,.java,.c,.cpp,.h,.hpp,.go,.rs,.rb,.php,.sh,.bat,.ps1,.sql,.r,.swift,.kt,.docx,.pptx,.xlsx,.odt,.odp,.ods,.pdf,.rtf"
        class="hidden"
        @change="handleReingestFile"
      >

      <!-- Create/Edit Space Dialog -->
      <Teleport to="body">
        <div
          v-if="showCreateDialog"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          @click.self="showCreateDialog = false"
        >
          <div class="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-md shadow-xl">
            <h3 class="text-base font-medium text-zinc-200 mb-4">
              {{ editingSpace ? 'Edit Space' : 'New Memory Space' }}
            </h3>
            <div class="space-y-3">
              <div>
                <label class="block text-xs text-zinc-400 mb-1">Name</label>
                <input
                  v-model="spaceName"
                  type="text"
                  class="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
                  placeholder="e.g. Company Knowledge"
                  @keydown.enter="saveSpace"
                >
              </div>
              <div>
                <label class="block text-xs text-zinc-400 mb-1">Description (optional)</label>
                <input
                  v-model="spaceDescription"
                  type="text"
                  class="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
                  placeholder="What kind of knowledge is stored here"
                >
              </div>
            </div>
            <div class="flex justify-end gap-2 mt-5">
              <button
                class="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200"
                @click="showCreateDialog = false"
              >
                Cancel
              </button>
              <button
                :disabled="!spaceName.trim()"
                class="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg disabled:opacity-50"
                @click="saveSpace"
              >
                {{ editingSpace ? 'Save' : 'Create' }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Move Dialog -->
      <Teleport to="body">
        <div
          v-if="showMoveDialog"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          @click.self="showMoveDialog = false"
        >
          <div class="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-md shadow-xl">
            <h3 class="text-base font-medium text-zinc-200 mb-2">
              Move {{ selectedGroups.size }} document{{ selectedGroups.size !== 1 ? 's' : '' }}
            </h3>
            <p class="text-sm text-zinc-500 mb-4">
              Select the target memory space:
            </p>
            <div class="space-y-2 max-h-60 overflow-y-auto">
              <button
                v-for="space in spaces.filter(s => s.id !== selectedSpaceId)"
                :key="space.id"
                :disabled="moving"
                class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-zinc-800 hover:border-blue-500/50 hover:bg-blue-500/5 transition-colors text-left disabled:opacity-50"
                @click="moveSelectedGroups(space.id)"
              >
                <Icon
                  icon="lucide:database"
                  class="w-4 h-4 text-zinc-400 shrink-0"
                />
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-zinc-200 truncate">
                    {{ space.name }}
                  </div>
                  <div class="text-xs text-zinc-500">
                    {{ space.documentCount }} document{{ space.documentCount !== 1 ? 's' : '' }}
                  </div>
                </div>
                <Icon
                  v-if="moving"
                  icon="lucide:loader-2"
                  class="w-4 h-4 text-zinc-500 animate-spin shrink-0"
                />
                <Icon
                  v-else
                  icon="lucide:chevron-right"
                  class="w-4 h-4 text-zinc-600 shrink-0"
                />
              </button>
            </div>
            <div class="flex justify-end mt-4">
              <button
                class="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200"
                @click="showMoveDialog = false"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Document Viewer Modal -->
      <Teleport to="body">
        <div
          v-if="showDocumentModal && modalSourceFile"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          @click.self="showDocumentModal = false"
        >
          <div class="bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col">
            <!-- Modal header -->
            <div class="flex items-center justify-between px-5 py-4 border-b border-zinc-800 shrink-0">
              <div class="flex items-center gap-3 min-w-0">
                <Icon
                  icon="lucide:file-text"
                  class="w-5 h-5 text-zinc-400 shrink-0"
                />
                <div class="min-w-0">
                  <h3 class="text-sm font-medium text-zinc-200 truncate">
                    {{ modalSourceFile }}
                  </h3>
                  <p class="text-xs text-zinc-500">
                    {{ groups.find(g => g.sourceFile === modalSourceFile)?.chunkCount || 0 }} chunks
                  </p>
                </div>
              </div>
              <button
                class="p-1.5 text-zinc-500 hover:text-zinc-300 rounded-lg hover:bg-zinc-800 transition-colors"
                @click="showDocumentModal = false"
              >
                <Icon
                  icon="lucide:x"
                  class="w-4 h-4"
                />
              </button>
            </div>

            <!-- View mode toggle -->
            <div class="flex items-center gap-1 px-5 py-2.5 border-b border-zinc-800/60 shrink-0">
              <button
                class="px-3 py-1.5 text-xs rounded-md transition-colors"
                :class="modalViewMode === 'merged'
                  ? 'bg-zinc-700 text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-300'"
                @click="modalViewMode = 'merged'"
              >
                <Icon
                  icon="lucide:file-text"
                  class="w-3 h-3 inline mr-1"
                />
                Document
              </button>
              <button
                class="px-3 py-1.5 text-xs rounded-md transition-colors"
                :class="modalViewMode === 'chunks'
                  ? 'bg-zinc-700 text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-300'"
                @click="modalViewMode = 'chunks'"
              >
                <Icon
                  icon="lucide:layers"
                  class="w-3 h-3 inline mr-1"
                />
                Chunks ({{ groups.find(g => g.sourceFile === modalSourceFile)?.chunkCount || 0 }})
              </button>
            </div>

            <!-- Content -->
            <div class="flex-1 overflow-y-auto">
              <div
                v-if="groupChunksLoading.has(modalSourceFile)"
                class="flex items-center justify-center gap-2 py-12 text-zinc-500 text-xs"
              >
                <Icon
                  icon="lucide:loader-2"
                  class="w-4 h-4 animate-spin"
                />
                Loading…
              </div>

              <template v-else-if="groupChunks.has(modalSourceFile)">
                <!-- Merged view -->
                <div
                  v-if="modalViewMode === 'merged'"
                  class="p-5"
                >
                  <pre class="text-xs text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed">{{ getMergedText(modalSourceFile) }}</pre>
                </div>

                <!-- Chunks view -->
                <div
                  v-else
                  class="divide-y divide-zinc-800/60"
                >
                  <div
                    v-for="chunk in getLoadedChunks(modalSourceFile)"
                    :key="chunk.id"
                    class="px-5 py-3"
                  >
                    <div class="flex items-center gap-2 mb-1.5">
                      <span class="text-[10px] font-mono text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">
                        Chunk #{{ (chunk.chunkIndex ?? 0) + 1 }}
                      </span>
                    </div>
                    <pre class="text-xs text-zinc-400 whitespace-pre-wrap font-mono leading-relaxed">{{ chunk.text }}</pre>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>
      </Teleport>
    </div>
  </div>
</template>
