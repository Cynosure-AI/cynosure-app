<script setup lang="ts">
import { computed } from 'vue'
import { useChatStore } from '../../../stores/chat.store'
import { Icon } from '@iconify/vue'
import HoverMenu from '../../shared/HoverMenu.vue'
import type { ReasoningEffort } from '@shared/types'

const chatStore = useChatStore()

type ReasoningLevel = ReasoningEffort | 'off'

const levels: Array<{
  value: ReasoningLevel
  label: string
  shortLabel: string
  icon: string
  description: string
}> = [
  {
    value: 'off',
    label: 'Off',
    shortLabel: '',
    icon: 'lucide:circle-off',
    description: 'Fastest response with no extra reasoning.',
  },
  {
    value: 'low',
    label: 'Low',
    shortLabel: 'L',
    icon: 'lucide:gauge',
    description: 'Quick reasoning for straightforward tasks.',
  },
  {
    value: 'medium',
    label: 'Medium',
    shortLabel: 'M',
    icon: 'lucide:brain',
    description: 'Balanced quality, speed, and token use.',
  },
  {
    value: 'high',
    label: 'High',
    shortLabel: 'H',
    icon: 'lucide:sparkles',
    description: 'More thorough reasoning for complex tasks.',
  },
]

const selectedLevel = computed<ReasoningLevel>(() =>
  chatStore.sessionThinkingEnabled ? chatStore.sessionReasoningEffort : 'off'
)

const selectedOption = computed(() =>
  levels.find((level) => level.value === selectedLevel.value) ?? levels[2]
)

function selectLevel(level: ReasoningLevel, close: () => void): void {
  chatStore.setSessionReasoningEffort(level)
  close()
}
</script>

<template>
  <HoverMenu
    placement="above"
    :max-width="280"
    :close-delay="180"
  >
    <template #trigger="{ open, toggle }">
      <button
        type="button"
        class="relative p-2.5 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-accent-500"
        :class="selectedLevel !== 'off'
          ? 'text-accent-400 hover:text-accent-300'
          : 'text-theme-500 hover:text-theme-300'"
        aria-haspopup="menu"
        :aria-expanded="open"
        :aria-label="`Reasoning level: ${selectedOption.label}`"
        :title="`Reasoning: ${selectedOption.label}`"
        @click.stop="toggle"
      >
        <Icon
          icon="lucide:lightbulb"
          class="h-5 w-5"
        />
        <span
          v-if="selectedOption.shortLabel"
          class="absolute right-0 top-0 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent-600 px-0.5 text-[8px] font-bold leading-none text-white shadow-sm"
        >
          {{ selectedOption.shortLabel }}
        </span>
      </button>
    </template>

    <template #content="{ close }">
      <div
        class="w-64"
        role="menu"
        aria-label="Reasoning level"
        @click.stop
      >
        <div class="px-2 pb-1.5 pt-1">
          <div class="text-xs font-medium text-theme-200">
            Reasoning level
          </div>
          <div class="mt-0.5 text-[10px] leading-relaxed text-theme-500">
            Higher levels may improve complex answers, but take longer and use more tokens.
          </div>
        </div>

        <div class="mt-1 border-t border-theme-800 pt-1">
          <button
            v-for="level in levels"
            :key="level.value"
            type="button"
            role="menuitemradio"
            :aria-checked="selectedLevel === level.value"
            class="group flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-500"
            :class="selectedLevel === level.value
              ? 'bg-accent-600/15 text-theme-100'
              : 'text-theme-300 hover:bg-theme-800'"
            @click="selectLevel(level.value, close)"
          >
            <span
              class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
              :class="selectedLevel === level.value
                ? 'bg-accent-600/20 text-accent-300'
                : 'bg-theme-800 text-theme-500 group-hover:text-theme-300'"
            >
              <Icon
                :icon="level.icon"
                class="h-3.5 w-3.5"
              />
            </span>

            <span class="min-w-0 flex-1">
              <span class="flex items-center justify-between gap-2">
                <span class="text-xs font-medium">{{ level.label }}</span>
                <Icon
                  v-if="selectedLevel === level.value"
                  icon="lucide:check"
                  class="h-3.5 w-3.5 shrink-0 text-accent-400"
                />
              </span>
              <span class="mt-0.5 block text-[10px] leading-relaxed text-theme-500">
                {{ level.description }}
              </span>
            </span>
          </button>
        </div>

        <div class="mt-1 border-t border-theme-800 px-2 pb-1 pt-1.5 text-[10px] text-theme-600">
          Applied when the selected model supports configurable reasoning.
        </div>
      </div>
    </template>
  </HoverMenu>
</template>
