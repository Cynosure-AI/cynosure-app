<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue'
import { api } from '../api/client'
import type { MemorySpace } from '../api/types'
import { Icon } from '@iconify/vue'
import ModalDialog from '../components/shared/ModalDialog.vue'
import MemoryDocumentList from '../components/memory/MemoryDocumentList.vue'

// --- Space management ---
const spaces = ref<MemorySpace[]>([])
const spacesLoading = ref(false)
const selectedSpaceId = ref<string | null>(null)
const showCreateDialog = ref(false)
const editingSpace = ref<MemorySpace | null>(null)
const spaceName = ref('')
const spaceDescription = ref('')
const showDeleteConfirm = ref(false)
const pendingDeleteSpace = ref<MemorySpace | null>(null)

const docList = ref<InstanceType<typeof MemoryDocumentList> | null>(null)

function confirmDeleteSpace(space: MemorySpace) {
  pendingDeleteSpace.value = space
  showDeleteConfirm.value = true
}

// --- Drag-and-drop reorder ---
const draggedSpaceId = ref<string | null>(null)
const dragOverSpaceId = ref<string | null>(null)
const dropPosition = ref<'before' | 'after'>('before')

function onSpaceDragStart(e: DragEvent, spaceId: string) {
  draggedSpaceId.value = spaceId
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', spaceId)
  }
}

function onSpaceDragOver(e: DragEvent, spaceId: string) {
  if (!draggedSpaceId.value || draggedSpaceId.value === spaceId) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dropPosition.value = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
  dragOverSpaceId.value = spaceId
}

function onSpaceDragLeave(e: DragEvent, spaceId: string) {
  const related = e.relatedTarget as HTMLElement | null
  const current = e.currentTarget as HTMLElement
  if (!related || !current.contains(related)) {
    if (dragOverSpaceId.value === spaceId) dragOverSpaceId.value = null
  }
}

async function onSpaceDrop(e: DragEvent, targetSpaceId: string) {
  e.preventDefault()
  const pos = dropPosition.value
  dragOverSpaceId.value = null
  const srcId = draggedSpaceId.value
  draggedSpaceId.value = null
  if (!srcId || srcId === targetSpaceId) return

  const list = [...spaces.value]
  const srcIdx = list.findIndex(s => s.id === srcId)
  let tgtIdx = list.findIndex(s => s.id === targetSpaceId)
  if (srcIdx === -1 || tgtIdx === -1) return

  const [moved] = list.splice(srcIdx, 1)
  // Adjust target index after removal
  if (srcIdx < tgtIdx) tgtIdx--
  if (pos === 'after') tgtIdx++
  list.splice(tgtIdx, 0, moved)
  spaces.value = list

  await api.memorySpaces.reorder(list.map(s => s.id))
}

function onSpaceDragEnd() {
  draggedSpaceId.value = null
  dragOverSpaceId.value = null
  dropTargetSpaceId.value = null
}

async function onSpaceOrFileDrop(e: DragEvent, spaceId: string) {
  if (draggedSpaceId.value) {
    return onSpaceDrop(e, spaceId)
  }
  return onFileDrop(e, spaceId)
}

const selectedSpace = computed(() => spaces.value.find(s => s.id === selectedSpaceId.value))

async function loadSpaces() {
  spacesLoading.value = true
  try {
    spaces.value = await api.memorySpaces.list()
    if (!selectedSpaceId.value && spaces.value.length > 0) {
      selectedSpaceId.value = spaces.value[0].id
    }
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
  showDeleteConfirm.value = false
  pendingDeleteSpace.value = null
  try {
    await api.memorySpaces.remove(space.id)
    await loadSpaces()
  } catch { /* error */ }
}

// --- File drag-and-drop ---
const dragCounter = ref(0)
const dropTargetSpaceId = ref<string | null>(null)

function onDragEnter(e: DragEvent, spaceId?: string) {
  e.preventDefault()
  if (spaceId) {
    if (!draggedSpaceId.value) dropTargetSpaceId.value = spaceId
  } else {
    dragCounter.value++
  }
}

function onDragLeave(e: DragEvent, spaceId?: string) {
  e.preventDefault()
  if (spaceId) {
    if (dropTargetSpaceId.value === spaceId) dropTargetSpaceId.value = null
  } else {
    dragCounter.value--
    if (dragCounter.value <= 0) dragCounter.value = 0
  }
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer && !draggedSpaceId.value) e.dataTransfer.dropEffect = 'copy'
}

async function onFileDrop(e: DragEvent, targetSpaceId?: string) {
  e.preventDefault()
  dragCounter.value = 0
  dropTargetSpaceId.value = null
  const files = e.dataTransfer?.files
  if (!files?.length) return
  const spaceId = targetSpaceId || selectedSpaceId.value
  if (!spaceId) return
  if (spaceId !== selectedSpaceId.value) selectedSpaceId.value = spaceId
  await nextTick()
  docList.value?.ingestFiles(Array.from(files))
}

onMounted(() => loadSpaces())
</script>

<template>
  <div
    class="h-full overflow-y-auto relative"
    @dragenter="onDragEnter($event)"
    @dragleave="onDragLeave($event)"
    @dragover="onDragOver($event)"
    @drop="onFileDrop($event)"
  >
    <!-- Drop overlay for selected space (only for external file drops, not space reordering) -->
    <div
      v-if="dragCounter > 0 && selectedSpaceId && !dropTargetSpaceId && !draggedSpaceId"
      class="absolute inset-0 z-40 flex items-center justify-center bg-blue-500/10 border-2 border-dashed border-blue-500/40 rounded-xl pointer-events-none"
    >
      <div class="text-center">
        <Icon
          icon="lucide:upload-cloud"
          class="w-12 h-12 text-blue-400 mx-auto mb-2"
        />
        <p class="text-blue-300 font-medium">
          Drop files to ingest into {{ selectedSpace?.name || 'selected space' }}
        </p>
        <p class="text-blue-400/60 text-sm mt-1">
          Files will be chunked and indexed automatically
        </p>
      </div>
    </div>
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
        <!-- Space cards grid -->
        <div class="grid grid-cols-4 gap-3 mb-6">
          <button
            v-for="space in spaces"
            :key="space.id"
            draggable="true"
            class="rounded-xl border px-4 py-3 text-left transition-all min-w-0 relative cursor-grab active:cursor-grabbing"
            :class="[
              selectedSpaceId === space.id
                ? 'border-blue-500/50 bg-blue-500/10'
                : 'border-zinc-700 bg-zinc-800/60 hover:bg-zinc-800',
              dropTargetSpaceId === space.id ? 'ring-2 ring-blue-400 border-blue-400/50 bg-blue-500/15' : '',
              draggedSpaceId === space.id ? 'opacity-40' : ''
            ]"
            @click="selectedSpaceId = space.id"
            @dragstart="onSpaceDragStart($event, space.id)"
            @dragover.prevent="onSpaceDragOver($event, space.id)"
            @dragleave.stop="onSpaceDragLeave($event, space.id)"
            @drop.stop.prevent="onSpaceOrFileDrop($event, space.id)"
            @dragend="onSpaceDragEnd"
            @dragenter.stop="onDragEnter($event, space.id)"
          >
            <!-- Drop indicator: left edge (before) -->
            <div
              v-if="dragOverSpaceId === space.id && dropPosition === 'before'"
              class="absolute inset-y-2 left-0 w-0.5 rounded-full bg-blue-400 pointer-events-none z-10"
            />
            <!-- Drop indicator: right edge (after) -->
            <div
              v-if="dragOverSpaceId === space.id && dropPosition === 'after'"
              class="absolute inset-y-2 right-0 w-0.5 rounded-full bg-blue-400 pointer-events-none z-10"
            />
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

        <!-- Document list for selected space -->
        <MemoryDocumentList
          v-if="selectedSpaceId"
          ref="docList"
          :space-id="selectedSpaceId"
          :spaces="spaces"
          @edit-space="openEditDialog(selectedSpace!)"
          @delete-space="confirmDeleteSpace(selectedSpace!)"
          @spaces-changed="loadSpaces"
        />
      </template>

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

      <!-- Delete Confirmation Modal -->
      <ModalDialog
        :show="showDeleteConfirm"
        title="Delete Memory Space"
        icon="lucide:trash-2"
        icon-color="red"
        @close="showDeleteConfirm = false"
      >
        <p class="text-zinc-400 leading-relaxed">
          Are you sure you want to delete <strong class="text-zinc-200">{{ pendingDeleteSpace?.name }}</strong>?
          All documents and chunks in this space will be permanently removed. This action cannot be undone.
        </p>
        <template #actions>
          <button
            class="w-full px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-center font-medium transition-colors"
            @click="deleteSpace(pendingDeleteSpace!)"
          >
            Delete Space
          </button>
          <button
            class="w-full px-4 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-center font-medium transition-colors"
            @click="showDeleteConfirm = false"
          >
            Cancel
          </button>
        </template>
      </ModalDialog>
    </div>
  </div>
</template>
