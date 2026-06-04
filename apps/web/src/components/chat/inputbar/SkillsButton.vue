<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Icon } from '@iconify/vue'
import { useChatStore } from '../../../stores/chat.store'
import { useSkillDefinitionsStore } from '../../../stores/skill-definitions.store'
import ModalDialog from '../../shared/ModalDialog.vue'
import HoverTooltip from '../../shared/HoverTooltip.vue'

const chatStore = useChatStore()
const skillsStore = useSkillDefinitionsStore()
const showModal = ref(false)

const enabledSkills = computed(() => skillsStore.skills.filter((skill) => skill.enabled))
const selectedSkills = computed(() =>
  enabledSkills.value.filter((skill) => chatStore.freeChatSkillIds.includes(skill.id))
)

onMounted(() => {
  if (!skillsStore.loaded) skillsStore.load().catch(() => { })
})

function toggleSkill(id: string): void {
  const selected = chatStore.freeChatSkillIds
  chatStore.freeChatSkillIds = selected.includes(id)
    ? selected.filter((skillId) => skillId !== id)
    : [...selected, id]
  chatStore.markOverridesModified()
}

function toggleAuto(): void {
  chatStore.sessionAutoSkillRouting = !chatStore.sessionAutoSkillRouting
  chatStore.markOverridesModified()
}
</script>

<template>
  <HoverTooltip :max-width="280">
    <button
      class="relative p-2.5 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-accent-500 text-theme-500 hover:text-theme-300"
      aria-label="Skills"
      @click="showModal = true"
    >
      <Icon
        icon="lucide:book-open-check"
        class="h-5 w-5"
      />
      <span
        class="absolute -top-0.5 -right-0.5 min-w-4 h-4 flex items-center justify-center rounded-full text-[9px] font-bold text-white px-1 leading-none"
        :class="chatStore.sessionAutoSkillRouting ? 'bg-emerald-600' : 'bg-accent-600'"
      >
        <Icon
          v-if="chatStore.sessionAutoSkillRouting"
          icon="lucide:sparkles"
          class="w-2.5 h-2.5"
        />
        <template v-else>
          {{ selectedSkills.length }}
        </template>
      </span>
    </button>
    <template #content>
      <div class="font-medium text-theme-300 mb-1.5">
        Skills
      </div>
      <div
        v-if="chatStore.sessionAutoSkillRouting"
        class="mb-1.5 px-1 py-1 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[10px]"
      >
        Auto-selection enabled
      </div>
      <div
        v-if="selectedSkills.length"
        class="space-y-1"
      >
        <div
          v-for="skill in selectedSkills.slice(0, 8)"
          :key="skill.id"
          class="text-theme-300 text-[11px] truncate"
        >
          {{ skill.name }}
        </div>
      </div>
      <div
        v-else
        class="text-theme-500"
      >
        No manual skills selected
      </div>
      <div class="text-theme-600 text-[10px] mt-1.5 border-t border-theme-800 pt-1.5">
        Click to configure
      </div>
    </template>
  </HoverTooltip>

  <ModalDialog
    :show="showModal"
    title="Skills"
    max-width="max-w-2xl"
    @close="showModal = false"
  >
    <div class="space-y-4">
      <label class="flex items-center justify-between gap-3 rounded border border-theme-700 bg-theme-900 px-3 py-2">
        <span>
          <span class="block text-sm font-medium text-theme-200">Auto-select relevant skills</span>
          <span class="block text-xs text-theme-500">Uses the current request to pull in matching skill instructions.</span>
        </span>
        <input
          type="checkbox"
          :checked="chatStore.sessionAutoSkillRouting"
          class="accent-accent-500"
          @change="toggleAuto"
        >
      </label>

      <div class="max-h-96 overflow-y-auto rounded border border-theme-700 bg-theme-900">
        <label
          v-for="skill in enabledSkills"
          :key="skill.id"
          class="flex items-start gap-3 px-3 py-2.5 border-b border-theme-800 last:border-b-0 hover:bg-theme-800/60 cursor-pointer"
        >
          <input
            type="checkbox"
            :checked="chatStore.freeChatSkillIds.includes(skill.id)"
            class="mt-1 accent-accent-500"
            @change="toggleSkill(skill.id)"
          >
          <span class="min-w-0">
            <span class="block text-sm text-theme-200 truncate">{{ skill.name }}</span>
            <span
              v-if="skill.category"
              class="block text-[10px] uppercase tracking-wide text-theme-500"
            >{{ skill.category }}</span>
            <span class="block text-xs text-theme-500 line-clamp-2">{{ skill.description }}</span>
          </span>
        </label>
        <div
          v-if="!enabledSkills.length"
          class="px-3 py-8 text-center text-sm text-theme-500"
        >
          No skills yet. Create skills from the Skills page.
        </div>
      </div>
    </div>
  </ModalDialog>
</template>
