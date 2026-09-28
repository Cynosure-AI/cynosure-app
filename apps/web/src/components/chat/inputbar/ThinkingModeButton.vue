<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import type { ReasoningEffort } from '@shared/types'
import { useChatStore } from '../../../stores/chat.store'
import HoverMenu from '../../shared/HoverMenu.vue'

const chatStore = useChatStore()

type ReasoningLevel = ReasoningEffort | 'off'

const levels: Array<{
  value: ReasoningLevel
  label: string
  shortLabel: string
  description: string
}> = [
  {
    value: 'off',
    label: 'Off',
    shortLabel: '',
    description: 'Plain model mode. Reasoning and planning tools are disabled.',
  },
  {
    value: 'minimal',
    label: 'Minimal',
    shortLabel: 'MIN',
    description: 'Minimal reasoning for the lowest latency and token use.',
  },
  {
    value: 'low',
    label: 'Low',
    shortLabel: 'LOW',
    description: 'Quick reasoning for straightforward tasks.',
  },
  {
    value: 'medium',
    label: 'Medium',
    shortLabel: 'MED',
    description: 'Balanced reasoning, speed, and token use.',
  },
  {
    value: 'high',
    label: 'High',
    shortLabel: 'HIGH',
    description: 'Deep reasoning for complex tasks.',
  },
  {
    value: 'xhigh',
    label: 'Extra high',
    shortLabel: 'XHIGH',
    description: 'Extra reasoning for especially difficult tasks.',
  },
  {
    value: 'max',
    label: 'Maximum',
    shortLabel: 'MAX',
    description: 'The provider\'s maximum available reasoning effort.',
  },
]

const selectedLevel = computed<ReasoningLevel>(() =>
  chatStore.sessionThinkingEnabled ? chatStore.sessionReasoningEffort : 'off'
)

const selectedIndex = computed(() => {
  const index = levels.findIndex((level) => level.value === selectedLevel.value)
  return index < 0 ? 2 : index
})

const selectedOption = computed(() => levels[selectedIndex.value])
const fillPercentage = computed(() => `${(selectedIndex.value / (levels.length - 1)) * 100}%`)

function selectIndex(event: Event): void {
  const index = Number((event.target as HTMLInputElement).value)
  const level = levels[index]
  if (level) chatStore.setSessionReasoningEffort(level.value)
}

const gaugeColors = [
  '#fff', // off //formerly: #64748b
  '#ddd', // minimal //formerly: #38bdf8
  '#bbb', // low //formerly:#22c55e
  '#a3e635', // medium
  '#eab308', // high
  '#f97316', // xhigh
  '#ef4444', // max
]

const gaugeTicks = computed(() =>
  levels.map((level, index) => ({
    value: level.value,
    angle: -90 + (index / (levels.length - 1)) * 180,
    color: gaugeColors[index],
    active: index <= selectedIndex.value,
  }))
)

const needleAngle = computed(
  () => -90 + (selectedIndex.value / (levels.length - 1)) * 180
)

const needleColor = computed(
  () => gaugeColors[selectedIndex.value] ?? gaugeColors[0]
)
</script>

<template>
  <HoverMenu
    placement="above"
    :max-width="292"
    :close-delay="240"
  >
    <template #trigger="{ open, toggle }">
      <button
        type="button"
        class="relative shrink-0 rounded-xl p-2.5 transition-colors focus:outline-none focus:ring-1 focus:ring-accent-500 text-theme-500 hover:text-theme-300"
        aria-haspopup="dialog"
        :aria-expanded="open"
        :aria-label="`Reasoning level: ${selectedOption.label}`"
        :title="`Reasoning: ${selectedOption.label}`"
        @click.stop="toggle"
      >
        <svg
          class="reasoning-gauge"
          viewBox="0 0 24 19"
          aria-hidden="true"
        >
          <path
            class="reasoning-gauge__background"
            d="M 3 15 A 9 9 0 0 1 21 15"
            pathLength="100"
          />

          <line
            v-for="tick in gaugeTicks"
            :key="tick.value"
            class="reasoning-gauge__tick"
            :class="{ 'reasoning-gauge__tick--active': tick.active }"
            x1="12"
            y1="2.5"
            x2="12"
            y2="6"
            :stroke="tick.color"
            :style="{
              transform: `rotate(${tick.angle}deg)`,
            }"
          />

          <line
            class="reasoning-gauge__needle"
            x1="12"
            y1="14"
            x2="12"
            y2="6.25"
            :stroke="needleColor"
            :style="{
              transform: `rotate(${needleAngle}deg)`,
            }"
          />

          <circle
            cx="12"
            cy="14"
            r="2"
            class="reasoning-gauge__hub"
          />

          <circle
            cx="12"
            cy="14"
            r="0.8"
            :fill="needleColor"
          />
        </svg>
      </button>
    </template>

    <template #content>
      <div
        class="w-[17rem] px-2 py-1.5"
        role="dialog"
        aria-label="Reasoning level"
        @click.stop
      >
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-xs font-medium text-theme-200">Reasoning</span>
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

        <div class="mt-1.5 border-t border-theme-800 pt-2 text-[10px] text-theme-600">
          <span>{{ selectedLevel === 'off' ? 'Planning off' : 'Planning available' }}</span>
        </div>
      </div>
    </template>
  </HoverMenu>
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

.reasoning-gauge {
  width: 1.35rem;
  height: 1.15rem;
  overflow: visible;
}

.reasoning-gauge__background {
  fill: none;
  stroke: color-mix(
    in srgb,
    var(--color-theme-600) 35%,
    transparent
  );
  stroke-width: 1.5;
  stroke-linecap: round;
}

.reasoning-gauge__tick {
  stroke-width: 2;
  stroke-linecap: round;

  opacity: 0.22;

  transform-origin: 12px 14px;
  transform-box: view-box;

  transition:
    opacity 140ms ease,
    filter 140ms ease;
}

.reasoning-gauge__tick--active {
  opacity: 1;
}

.reasoning-gauge__needle {
  stroke-width: 1.6;
  stroke-linecap: round;

  transform-origin: 12px 14px;
  transform-box: view-box;

  transition:
    transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
    stroke 140ms ease;

  filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.35));
}

.reasoning-gauge__hub {
  fill: var(--color-theme-100);
  stroke: color-mix(
    in srgb,
    var(--color-theme-600) 50%,
    transparent
  );
  stroke-width: 0.75;
}

.reasoning-gauge__hub-center {
  transition: fill 140ms ease;
}
</style>
