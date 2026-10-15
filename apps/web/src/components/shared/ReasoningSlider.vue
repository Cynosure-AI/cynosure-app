<script setup lang="ts">
import { computed } from 'vue'
import type { ReasoningEffort } from '@shared/types'

type ReasoningLevel = ReasoningEffort | 'off'

const props = defineProps<{
  modelValue: ReasoningLevel
  levels: Array<{ value: ReasoningLevel; label: string }>
  id?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: ReasoningLevel] }>()

const selectedIndex = computed(() => {
  const index = props.levels.findIndex(level => level.value === props.modelValue)
  return index < 0 ? 0 : index
})
const selectedOption = computed(() => props.levels[selectedIndex.value])
const fillPercentage = computed(() => `${(selectedIndex.value / (props.levels.length - 1)) * 100}%`)

function selectIndex(event: Event): void {
  const level = props.levels[Number((event.target as HTMLInputElement).value)]
  if (level) emit('update:modelValue', level.value)
}
</script>

<template>
  <div>
    <div class="flex items-baseline justify-between gap-3">
      <label
        :for="id"
        class="text-xs font-medium text-theme-200"
      >Reasoning</label>
      <span class="text-xs font-medium text-accent-400">{{ selectedOption.label }}</span>
    </div>

    <div class="reasoning-slider mt-3">
      <div
        class="reasoning-slider__rail"
        aria-hidden="true"
      >
        <div
          class="reasoning-slider__fill"
          :style="{ width: fillPercentage }"
        />
        <span
          v-for="(level, index) in levels"
          :key="level.value"
          class="reasoning-slider__dot"
          :class="{
            'reasoning-slider__dot--active': index <= selectedIndex,
            'reasoning-slider__dot--endpoint': index === 0 || index === levels.length - 1,
          }"
          :style="{ left: `${(index / (levels.length - 1)) * 100}%` }"
        />
      </div>
      <input
        :id="id"
        class="reasoning-slider__input"
        type="range"
        min="0"
        :max="levels.length - 1"
        step="1"
        :value="selectedIndex"
        aria-label="Reasoning level"
        :aria-valuetext="selectedOption.label"
        @input="selectIndex"
      >
    </div>
  </div>
</template>

<style scoped>
.reasoning-slider {
  position: relative;
  height: 2rem;
}

.reasoning-slider__rail {
  position: absolute;
  inset: 0.375rem 0.875rem;
  height: 1.25rem;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--color-theme-600) 42%, transparent);
  border-radius: 9999px;
  background: color-mix(in srgb, var(--color-theme-700) 38%, transparent);
  box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.12);
}

.reasoning-slider__fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  background: var(--color-accent-500);
  transition: width 120ms ease;
}

.reasoning-slider__dot {
  position: absolute;
  top: 50%;
  width: 0.25rem;
  height: 0.25rem;
  border-radius: 9999px;
  background: var(--color-theme-500);
  transform: translate(-50%, -50%);
}

.reasoning-slider__dot--active {
  background: color-mix(in srgb, white 40%, var(--color-accent-300));
}

.reasoning-slider__dot--endpoint {
  opacity: 0;
}

.reasoning-slider__input {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 2rem;
  margin: 0;
  cursor: pointer;
  appearance: none;
  background: transparent;
}

.reasoning-slider__input::-webkit-slider-runnable-track {
  height: 1.25rem;
  background: transparent;
}

.reasoning-slider__input::-webkit-slider-thumb {
  width: 1.75rem;
  height: 1.75rem;
  margin-top: -0.25rem;
  appearance: none;
  border: 1px solid color-mix(in srgb, var(--color-theme-500) 35%, transparent);
  border-radius: 9999px;
  background: var(--color-theme-50);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.24);
}

.reasoning-slider__input::-moz-range-track {
  height: 1.25rem;
  background: transparent;
}

.reasoning-slider__input::-moz-range-thumb {
  width: 1.75rem;
  height: 1.75rem;
  border: 1px solid color-mix(in srgb, var(--color-theme-500) 35%, transparent);
  border-radius: 9999px;
  background: var(--color-theme-50);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.24);
}
</style>
