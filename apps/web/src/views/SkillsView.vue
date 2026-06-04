<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Icon } from '@iconify/vue'
import { useSkillDefinitionsStore } from '../stores/skill-definitions.store'
import type { SkillDefinition } from '../api/types'
import DataTable from '../components/shared/DataTable.vue'
import type { Column } from '../components/shared/DataTable.vue'
import ToggleSwitch from '../components/shared/ToggleSwitch.vue'

const skillStore = useSkillDefinitionsStore()
const editingId = ref<string | null>(null)
const form = reactive({
  name: '',
  category: '',
  description: '',
  content: '',
  enabled: true,
})

const sortedSkills = computed(() =>
  [...skillStore.skills].sort((a, b) => `${a.category}/${a.name}`.localeCompare(`${b.category}/${b.name}`))
)

const columns: Column<SkillDefinition>[] = [
  {
    key: 'name',
    label: 'Name',
    width: 'minmax(180px,1.1fr)',
    sortable: true,
    sortValue: (skill) => skill.name,
  },
  {
    key: 'description',
    label: 'Description',
    width: 'minmax(220px,1.6fr)',
  },
  {
    key: 'enabled',
    label: 'Enabled',
    width: '90px',
    sortable: true,
    sortValue: (skill) => skill.enabled,
  },
  {
    key: 'actions',
    label: '',
    width: '80px',
  },
]

onMounted(() => {
  skillStore.load().catch(() => { })
})

function resetForm(): void {
  editingId.value = null
  form.name = ''
  form.category = ''
  form.description = ''
  form.content = ''
  form.enabled = true
}

function editSkill(skill: SkillDefinition): void {
  editingId.value = skill.id
  form.name = skill.name
  form.category = skill.category
  form.description = skill.description
  form.content = skill.content
  form.enabled = skill.enabled
}

async function saveSkill(): Promise<void> {
  const payload = {
    name: form.name,
    category: form.category,
    description: form.description,
    content: form.content,
    enabled: form.enabled,
  }
  if (editingId.value) {
    await skillStore.update(editingId.value, payload)
  } else {
    await skillStore.create(payload)
  }
  resetForm()
}

async function removeSkill(id: string): Promise<void> {
  await skillStore.remove(id)
  if (editingId.value === id) resetForm()
}

async function setEnabled(skill: SkillDefinition, enabled: boolean): Promise<void> {
  await skillStore.update(skill.id, { enabled })
}
</script>

<template>
  <div class="h-full overflow-auto bg-theme-950 text-theme-100">
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
          class="inline-flex items-center gap-2 rounded bg-accent-600 px-3 py-2 text-sm font-medium text-white hover:bg-accent-500"
          @click="resetForm"
        >
          <Icon
            icon="lucide:plus"
            class="h-4 w-4"
          />
          New Skill
        </button>
      </div>

      <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <DataTable
          :items="sortedSkills"
          :columns="columns"
          empty-message="No skills yet."
          @row-click="editSkill"
        >
          <template #col-name="{ item: skill }">
            <div class="min-w-0">
              <div class="flex min-w-0 items-center gap-2">
                <span class="truncate text-sm font-medium text-theme-100">{{ skill.name }}</span>
                <span
                  v-if="!skill.enabled"
                  class="shrink-0 rounded bg-theme-800 px-1.5 py-0.5 text-[10px] uppercase text-theme-500"
                >Disabled</span>
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
                color="accent"
                @update:model-value="setEnabled(skill, $event)"
              />
            </div>
          </template>

          <template #col-actions="{ item: skill }">
            <div
              class="flex items-center justify-end gap-1"
              @click.stop
            >
              <button
                class="rounded p-1.5 text-theme-500 hover:bg-theme-800 hover:text-theme-200"
                aria-label="Edit skill"
                @click="editSkill(skill)"
              >
                <Icon
                  icon="lucide:pencil"
                  class="h-4 w-4"
                />
              </button>
              <button
                class="rounded p-1.5 text-theme-500 hover:bg-red-500/10 hover:text-red-400"
                aria-label="Delete skill"
                @click="removeSkill(skill.id)"
              >
                <Icon
                  icon="lucide:trash-2"
                  class="h-4 w-4"
                />
              </button>
            </div>
          </template>
        </DataTable>

        <form
          class="rounded border border-theme-800 bg-theme-900 p-4"
          @submit.prevent="saveSkill"
        >
          <h2 class="mb-4 text-sm font-semibold text-theme-200">
            {{ editingId ? 'Edit Skill' : 'Create Skill' }}
          </h2>
          <div class="space-y-3">
            <input
              v-model="form.name"
              required
              placeholder="Skill name"
              class="w-full rounded border border-theme-700 bg-theme-950 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none"
            >
            <input
              v-model="form.category"
              placeholder="Category, e.g. Download Media"
              class="w-full rounded border border-theme-700 bg-theme-950 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none"
            >
            <textarea
              v-model="form.description"
              rows="2"
              placeholder="When should this skill be used?"
              class="w-full rounded border border-theme-700 bg-theme-950 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none"
            />
            <textarea
              v-model="form.content"
              required
              rows="12"
              placeholder="Skill instructions"
              class="w-full rounded border border-theme-700 bg-theme-950 px-3 py-2 font-mono text-sm focus:border-accent-500 focus:outline-none"
            />
            <label class="flex items-center gap-2 text-sm text-theme-300">
              <input
                v-model="form.enabled"
                type="checkbox"
                class="accent-accent-500"
              >
              Enabled
            </label>
          </div>
          <div class="mt-4 flex gap-2">
            <button
              type="submit"
              class="rounded bg-accent-600 px-3 py-2 text-sm font-medium text-white hover:bg-accent-500"
            >
              Save
            </button>
            <button
              type="button"
              class="rounded border border-theme-700 px-3 py-2 text-sm text-theme-300 hover:bg-theme-800"
              @click="resetForm"
            >
              Clear
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
