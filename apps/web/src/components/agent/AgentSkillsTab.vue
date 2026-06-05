<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { Icon } from '@iconify/vue'
import type { AgentDefinition } from '../../api/types'
import { useSkillDefinitionsStore } from '../../stores/skill-definitions.store'
import ToggleSwitch from '../shared/ToggleSwitch.vue'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()
const skillStore = useSkillDefinitionsStore()

const skills = computed(() => skillStore.skills.filter((skill) => skill.enabled))

onMounted(() => {
  if (!skillStore.loaded) skillStore.load().catch(() => { })
})

function toggleSkill(id: string): void {
  const current = props.agent.skills || []
  emit('update', 'skills', current.includes(id)
    ? current.filter((skillId) => skillId !== id)
    : [...current, id])
}
</script>

<template>
  <div class="space-y-4">
    <!-- Auto Skill Routing -->
    <div class="bg-theme-800 border border-theme-700 rounded-xl p-5">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <Icon
              icon="lucide:book-open-check"
              class="w-4 h-4 text-accent-400"
            />
            <h3 class="text-sm font-medium text-theme-200">
              Auto Skill Routing
            </h3>
          </div>
          <p class="text-xs text-theme-500 leading-relaxed">
            When enabled, this agent automatically selects relevant skills for each request.
            Manual skills from the Skills tab are always included.
          </p>
        </div>
        <ToggleSwitch
          :model-value="agent.autoSkillRouting !== false"
          color="accent"
          class="mt-0.5"
          @update:model-value="emit('update', 'autoSkillRouting', $event)"
        />
      </div>
    </div>

    <div class="rounded-lg border border-theme-700 bg-theme-900/70 px-4 py-3">
      <div class="flex items-center gap-2">
        <Icon
          icon="lucide:book-open-check"
          class="h-4 w-4 text-accent-400"
        />
        <p class="text-sm font-medium text-theme-200">
          Agent skills
        </p>
      </div>
      <p class="mt-1 text-xs text-theme-500">
        Selected skills are always added to this agent. Chat can also auto-select additional relevant skills per request.
      </p>
    </div>

    <div class="rounded border border-theme-700 bg-theme-900">
      <label
        v-for="skill in skills"
        :key="skill.id"
        class="flex items-start gap-3 border-b border-theme-800 px-3 py-2.5 last:border-b-0 hover:bg-theme-800/60 cursor-pointer"
      >
        <input
          type="checkbox"
          :checked="(agent.skills || []).includes(skill.id)"
          class="mt-1 accent-accent-500"
          @change="toggleSkill(skill.id)"
        >
        <span class="min-w-0">
          <span class="block text-sm text-theme-200">{{ skill.name }}</span>
          <span
            v-if="skill.category"
            class="block text-[10px] uppercase tracking-wide text-theme-500"
          >{{ skill.category }}</span>
          <span class="block text-xs text-theme-500">{{ skill.description }}</span>
        </span>
      </label>
      <div
        v-if="!skills.length"
        class="px-4 py-12 text-center text-sm text-theme-500"
      >
        No enabled skills yet.
      </div>
    </div>
  </div>
</template>
