<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { Icon } from '@iconify/vue'

defineProps<{
  categories: string[]
  modelValue: string
  showUncategorized?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'add': [name: string]
  'remove': [name: string]
  'rename': [payload: { oldName: string; newName: string }]
  'drop': [payload: { itemId: string; category: string }]
  'reorder': [payload: { from: string; to: string; before: boolean }]
}>()

const showAddInput = ref(false)
const newCategoryName = ref('')

const dragOverTab = ref<string | null>(null)
const editingTab = ref<string | null>(null)
const editingName = ref('')
const editInputRef = ref<HTMLInputElement | null>(null)

// Category-tab reorder DnD state
const catReorderFrom = ref<string | null>(null)
const catDropTarget = ref<string | null>(null)
const catDropPos = ref<'before' | 'after'>('before')

function startRename(cat: string) {
  editingTab.value = cat
  editingName.value = cat
  nextTick(() => editInputRef.value?.select())
}

function commitRename(oldName: string) {
  const newName = editingName.value.trim()
  editingTab.value = null
  if (newName && newName !== oldName) {
    emit('rename', { oldName, newName })
  }
}

function cancelRename() {
  editingTab.value = null
}

function addCategory() {
  const name = newCategoryName.value.trim()
  if (name) {
    emit('add', name)
    newCategoryName.value = ''
  }
  showAddInput.value = false
}

function cancelAdd() {
  newCategoryName.value = ''
  showAddInput.value = false
}

function onDragOver(e: DragEvent, tab: string) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  if (e.dataTransfer?.types.includes('text/x-cat-reorder')) {
    if (catReorderFrom.value && catReorderFrom.value !== tab) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      catDropPos.value = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
      catDropTarget.value = tab
    }
  } else {
    dragOverTab.value = tab
  }
}

function onDragLeave(e: DragEvent, tab: string) {
  const related = e.relatedTarget as HTMLElement | null
  const current = e.currentTarget as HTMLElement
  if (!related || !current.contains(related)) {
    if (dragOverTab.value === tab) dragOverTab.value = null
    if (catDropTarget.value === tab) catDropTarget.value = null
  }
}

function onDrop(e: DragEvent, category: string) {
  e.preventDefault()
  dragOverTab.value = null
  catDropTarget.value = null
  if (e.dataTransfer?.types.includes('text/x-cat-reorder')) {
    const from = e.dataTransfer.getData('text/x-cat-reorder')
    catReorderFrom.value = null
    if (from && from !== category) {
      emit('reorder', { from, to: category, before: catDropPos.value === 'before' })
    }
    return
  }
  const itemId = e.dataTransfer?.getData('text/plain')
  if (itemId) {
    emit('drop', { itemId, category })
  }
}

function onCatDragStart(e: DragEvent, cat: string) {
  catReorderFrom.value = cat
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/x-cat-reorder', cat)
  }
}

function onCatDragEnd() {
  catReorderFrom.value = null
  catDropTarget.value = null
}
</script>

<template>
  <div class="flex items-center gap-1 border-b border-zinc-800 overflow-x-auto overflow-y-hidden scrollbar-none">
    <!-- All tab -->
    <button
      class="flex items-center gap-1.5 px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px whitespace-nowrap shrink-0"
      :class="modelValue === ''
        ? 'text-blue-400 border-blue-400'
        : 'text-zinc-500 border-transparent hover:text-zinc-300'"
      @click="emit('update:modelValue', '')"
      @dragover="onDragOver($event, '')"
      @dragleave="onDragLeave($event, '')"
      @drop="onDrop($event, '')"
    >
      <Icon
        icon="lucide:layers"
        class="w-3.5 h-3.5"
      />
      All
    </button>

    <!-- Uncategorized tab -->
    <button
      v-if="showUncategorized"
      class="flex items-center gap-1.5 px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px whitespace-nowrap shrink-0"
      :class="modelValue === '__uncategorized__'
        ? 'text-blue-400 border-blue-400'
        : 'text-zinc-500 border-transparent hover:text-zinc-300'"
      @click="emit('update:modelValue', '__uncategorized__')"
      @dragover="onDragOver($event, '')"
      @dragleave="onDragLeave($event, '')"
      @drop="onDrop($event, '')"
    >
      <Icon
        icon="lucide:inbox"
        class="w-3.5 h-3.5"
      />
      Uncategorized
    </button>

    <!-- Category tabs -->
    <div
      v-for="cat in categories"
      :key="cat"
      class="group relative flex items-center shrink-0"
      @dragover="onDragOver($event, cat)"
      @dragleave="onDragLeave($event, cat)"
      @drop="onDrop($event, cat)"
    >
      <!-- Drop indicator: left edge (before) -->
      <div
        v-if="catDropTarget === cat && catDropPos === 'before'"
        class="absolute inset-y-1 left-0 w-0.5 rounded-full bg-blue-400 z-10 pointer-events-none"
      />
      <!-- Drop indicator: right edge (after) -->
      <div
        v-if="catDropTarget === cat && catDropPos === 'after'"
        class="absolute inset-y-1 right-0 w-0.5 rounded-full bg-blue-400 z-10 pointer-events-none"
      />
      <!-- Inline rename input -->
      <div
        v-if="editingTab === cat"
        class="flex items-center gap-1 px-1 border-b-2 border-blue-400 -mb-px"
      >
        <input
          ref="editInputRef"
          v-model="editingName"
          type="text"
          class="w-28 px-2 py-1 bg-zinc-800 border border-zinc-600 rounded text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
          @keydown.enter="commitRename(cat)"
          @keydown.escape="cancelRename"
          @blur="commitRename(cat)"
        >
      </div>
      <!-- Normal tab button -->
      <button
        v-else
        draggable="true"
        class="flex items-center gap-1.5 px-4 py-2.5 text-sm transition-all border-b-2 -mb-px whitespace-nowrap cursor-grab active:cursor-grabbing"
        :class="[
          modelValue === cat
            ? 'text-blue-400 border-blue-400'
            : 'text-zinc-500 border-transparent hover:text-zinc-300',
          dragOverTab === cat ? 'bg-blue-500/10 text-blue-400' : '',
          catReorderFrom === cat ? 'opacity-40' : ''
        ]"
        @click="emit('update:modelValue', cat)"
        @dblclick.stop="startRename(cat)"
        @dragstart.stop="onCatDragStart($event, cat)"
        @dragend.stop="onCatDragEnd"
      >
        {{ cat }}
      </button>
      <button
        v-if="editingTab !== cat"
        class="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-600 hover:text-red-400 transition-all -ml-1 mr-1"
        title="Remove category"
        @click.stop="emit('remove', cat)"
      >
        <Icon
          icon="lucide:x"
          class="w-3 h-3"
        />
      </button>
    </div>

    <!-- Add category button / input -->
    <div class="shrink-0 flex items-center -mb-px">
      <div
        v-if="showAddInput"
        class="flex items-center gap-1 px-1"
      >
        <input
          v-model="newCategoryName"
          type="text"
          placeholder="Category name"
          class="w-28 px-2 py-1 bg-zinc-800 border border-zinc-600 rounded text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
          autofocus
          @keydown.enter="addCategory"
          @keydown.escape="cancelAdd"
        >
        <button
          class="p-1 text-green-400 hover:text-green-300 transition-colors"
          @click="addCategory"
        >
          <Icon
            icon="lucide:check"
            class="w-3.5 h-3.5"
          />
        </button>
        <button
          class="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
          @click="cancelAdd"
        >
          <Icon
            icon="lucide:x"
            class="w-3.5 h-3.5"
          />
        </button>
      </div>
      <button
        v-else
        class="flex items-center gap-1 px-3 py-2.5 text-xs text-zinc-600 hover:text-zinc-400 transition-colors border-b-2 border-transparent"
        @click="showAddInput = true"
      >
        <Icon
          icon="lucide:plus"
          class="w-3.5 h-3.5"
        />
      </button>
    </div>
  </div>
</template>

<style scoped>
div:first-child {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
div:first-child::-webkit-scrollbar {
  display: none;
}
</style>
