<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Icon } from '@iconify/vue'
import { useSkillDefinitionsStore } from '../stores/skill-definitions.store'
import type { SkillDefinition } from '../api/types'

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
        <div class="rounded border border-theme-800 bg-theme-900">
          <div
            v-for="skill in sortedSkills"
            :key="skill.id"
            class="flex items-start justify-between gap-3 border-b border-theme-800 px-4 py-3 last:border-b-0"
          >
            <button
              class="min-w-0 flex-1 text-left"
              @click="editSkill(skill)"
            >
              <div class="flex items-center gap-2">
                <span class="truncate text-sm font-medium text-theme-100">{{ skill.name }}</span>
                <span
                  v-if="!skill.enabled"
                  class="rounded bg-theme-800 px-1.5 py-0.5 text-[10px] uppercase text-theme-500"
                >Disabled</span>
              </div>
              <div
                v-if="skill.category"
                class="mt-0.5 text-[10px] uppercase tracking-wide text-theme-500"
              >
                {{ skill.category }}
              </div>
              <p class="mt-1 line-clamp-2 text-xs text-theme-400">
                {{ skill.description || skill.content }}
              </p>
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
          <div
            v-if="!sortedSkills.length"
            class="px-4 py-12 text-center text-sm text-theme-500"
          >
            No skills yet.
          </div>
        </div>

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
