<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Icon } from '@iconify/vue'
import { useSkillDefinitionsStore } from '../stores/skill-definitions.store'
import type { SkillDefinition } from '../api/types'
import DataTable from '../components/shared/DataTable.vue'
import type { Column } from '../components/shared/DataTable.vue'
import ToggleSwitch from '../components/shared/ToggleSwitch.vue'
import ModalDialog from '../components/shared/ModalDialog.vue'

const skillStore = useSkillDefinitionsStore()

// --- Add modal ---
const showAddModal = ref(false)
const addForm = reactive({ name: '', category: '', description: '', content: '', enabled: true })

function openAddModal(): void {
  Object.assign(addForm, { name: '', category: '', description: '', content: '', enabled: true })
  showAddModal.value = true
}

async function submitAdd(): Promise<void> {
  await skillStore.create({ ...addForm })
  showAddModal.value = false
}

// --- Inline editing ---
const editingId = ref<string | null>(null)
const editForm = reactive({ name: '', category: '', description: '', content: '', enabled: true })

function startEditing(skill: SkillDefinition): void {
  editingId.value = skill.id
  Object.assign(editForm, {
    name: skill.name,
    category: skill.category,
    description: skill.description,
    content: skill.content,
    enabled: skill.enabled,
  })
}

function cancelEditing(): void {
  editingId.value = null
}

async function saveEditing(id: string): Promise<void> {
  await skillStore.update(id, { ...editForm })
  editingId.value = null
}

// --- Delete confirmation ---
const confirmDeleteId = ref<string | null>(null)
const skillToDelete = computed(() => skillStore.skills.find(s => s.id === confirmDeleteId.value) ?? null)

function promptDelete(id: string): void {
  confirmDeleteId.value = id
}

async function confirmDelete(): Promise<void> {
  if (!confirmDeleteId.value) return
  if (editingId.value === confirmDeleteId.value) editingId.value = null
  await skillStore.remove(confirmDeleteId.value)
  confirmDeleteId.value = null
}

// --- Toggle enabled ---
async function setEnabled(skill: SkillDefinition, enabled: boolean): Promise<void> {
  await skillStore.update(skill.id, { enabled })
}

// --- Table ---
const sortedSkills = computed(() =>
  [...skillStore.skills].sort((a, b) => `${a.category}/${a.name}`.localeCompare(`${b.category}/${b.name}`))
)

const columns: Column<SkillDefinition>[] = [
  { key: 'name', label: 'Name', width: 'minmax(180px,1.2fr)', sortable: true, sortValue: s => s.name },
  { key: 'description', label: 'Description', width: 'minmax(200px,1.8fr)' },
  { key: 'enabled', label: 'Enable', width: '60px', sortable: true, sortValue: s => s.enabled },
  { key: 'actions', label: 'Actions', width: '100px' },
]

onMounted(() => {
  skillStore.load().catch(() => { })
})
</script>

<template>
  <div class="h-full overflow-auto">
    <div class="mx-auto max-w-6xl p-6">
      <div class="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold">
            Skills
          </h1>
          <p class="mt-1 text-sm text-theme-500">
            Reusable instructions that can be selected manually or pulled into chat automatically.
          </p>
        </div>
        <button
          class="h-10 px-4 bg-accent-600 hover:bg-accent-500 text-white text-sm font-medium rounded-lg transition-colors"
          @click="openAddModal"
        >
          Add Skill
        </button>
      </div>

      <DataTable
        :items="sortedSkills"
        :columns="columns"
        empty-message="No skills yet. Click 'Add Skill' to create one."
      >
        <template #col-name="{ item: skill }">
          <div class="min-w-0">
            <div class="flex min-w-0 items-center gap-2">
              <span class="truncate text-sm font-medium text-theme-100">{{ skill.name }}</span>
            </div>
            <div
              v-if="skill.category"
              class="mt-0.5 text-[10px] uppercase tracking-wide text-theme-500"
            >
              {{ skill.category }}
            </div>
          </div>
        </template>

        <template #col-description="{ item: skill }">
          <p class="line-clamp-2 text-xs text-theme-400">
            {{ skill.description || skill.content }}
          </p>
        </template>

        <template #col-enabled="{ item: skill }">
          <div @click.stop>
            <ToggleSwitch
              :model-value="skill.enabled"
              size="sm"
              color="green"
              @update:model-value="setEnabled(skill, $event)"
            />
          </div>
        </template>

        <template #col-actions="{ item: skill }">
          <div
            v-if="editingId !== skill.id"
            class="flex items-center gap-1.5"
            @click.stop
          >
            <button
              class="px-2.5 py-1.5 text-xs bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-md transition-colors"
              @click="startEditing(skill)"
            >
              Edit
            </button>
            <button
              class="p-1.5 text-theme-600 hover:text-red-400 rounded-md hover:bg-red-500/10 transition-colors"
              @click="promptDelete(skill.id)"
            >
              <Icon
                icon="lucide:trash-2"
                class="w-3.5 h-3.5"
              />
            </button>
          </div>
        </template>

        <!-- Inline edit form -->
        <template #row-expand="{ item: skill }">
          <div
            v-if="editingId === skill.id"
            class="border-t border-theme-800 px-5 py-4 space-y-3"
            @click.stop
          >
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label class="block text-xs text-theme-400 mb-1">Name</label>
                <input
                  v-model="editForm.name"
                  type="text"
                  class="w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
              </div>
              <div>
                <label class="block text-xs text-theme-400 mb-1">Category</label>
                <input
                  v-model="editForm.category"
                  type="text"
                  placeholder="e.g. Download Media"
                  class="w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
                >
              </div>
            </div>
            <div>
              <label class="block text-xs text-theme-400 mb-1">When to use</label>
              <textarea
                v-model="editForm.description"
                rows="2"
                placeholder="When should this skill be used?"
                class="w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-1.5 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
              />
            </div>
            <div>
              <label class="block text-xs text-theme-400 mb-1">Instructions</label>
              <textarea
                v-model="editForm.content"
                rows="10"
                class="w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-1.5 font-mono text-sm resize-y focus:outline-none focus:ring-1 focus:ring-accent-500"
              />
            </div>
            <div class="flex justify-end gap-2">
              <button
                class="px-3 py-1.5 text-xs bg-theme-700 hover:bg-theme-600 text-theme-300 rounded-md transition-colors"
                @click="cancelEditing"
              >
                Cancel
              </button>
              <button
                :disabled="!editForm.name || !editForm.content"
                class="px-3 py-1.5 text-xs bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white rounded-md transition-colors"
                @click="saveEditing(skill.id)"
              >
                Save
              </button>
            </div>
          </div>
        </template>
      </DataTable>
    </div>
  </div>

  <!-- Add Skill Modal -->
  <ModalDialog
    :show="showAddModal"
    title="New Skill"
    icon="lucide:sparkles"
    icon-color="accent"
    max-width="max-w-2xl"
    @close="showAddModal = false"
  >
    <form
      class="space-y-3"
      @submit.prevent="submitAdd"
    >
      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label class="block text-xs text-theme-400 mb-1">Name</label>
          <input
            v-model="addForm.name"
            required
            type="text"
            placeholder="Skill name"
            class="w-full bg-theme-950 border border-theme-700 text-theme-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
          >
        </div>
        <div>
          <label class="block text-xs text-theme-400 mb-1">Category</label>
          <input
            v-model="addForm.category"
            type="text"
            placeholder="e.g. Download Media"
            class="w-full bg-theme-950 border border-theme-700 text-theme-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
          >
        </div>
      </div>
      <div>
        <label class="block text-xs text-theme-400 mb-1">When to use</label>
        <textarea
          v-model="addForm.description"
          rows="2"
          placeholder="When should this skill be used?"
          class="w-full bg-theme-950 border border-theme-700 text-theme-200 rounded-lg px-3 py-2 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
        />
      </div>
      <div>
        <label class="block text-xs text-theme-400 mb-1">Instructions</label>
        <textarea
          v-model="addForm.content"
          required
          rows="12"
          placeholder="Skill instructions..."
          class="w-full bg-theme-950 border border-theme-700 text-theme-200 rounded-lg px-3 py-2 font-mono text-sm resize-y focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
        />
      </div>
    </form>
    <template #actions>
      <div class="flex justify-end gap-2">
        <button
          class="px-4 py-2 text-sm bg-theme-700 hover:bg-theme-600 text-theme-300 rounded-lg transition-colors"
          @click="showAddModal = false"
        >
          Cancel
        </button>
        <button
          :disabled="!addForm.name || !addForm.content"
          class="px-4 py-2 text-sm bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white rounded-lg transition-colors"
          @click="submitAdd"
        >
          Create Skill
        </button>
      </div>
    </template>
  </ModalDialog>

  <!-- Delete confirmation modal -->
  <ModalDialog
    :show="!!confirmDeleteId"
    title="Delete Skill"
    icon="lucide:trash-2"
    icon-color="red"
    @close="confirmDeleteId = null"
  >
    <p class="text-sm text-theme-300">
      Are you sure you want to delete
      <span class="font-medium text-theme-100">{{ skillToDelete?.name }}</span>?
      This action cannot be undone.
    </p>
    <template #actions>
      <div class="flex justify-end gap-2">
        <button
          class="px-4 py-2 text-sm bg-theme-700 hover:bg-theme-600 text-theme-300 rounded-lg transition-colors"
          @click="confirmDeleteId = null"
        >
          Cancel
        </button>
        <button
          class="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors"
          @click="confirmDelete"
        >
          Delete
        </button>
      </div>
    </template>
  </ModalDialog>
</template>
