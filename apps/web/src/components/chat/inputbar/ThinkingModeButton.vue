<script setup lang="ts">
import { computed } from 'vue'
import type { PermissionMode, ReasoningEffort } from '@shared/types'
import { useChatStore } from '../../../stores/chat.store'
import HoverMenu from '../../shared/HoverMenu.vue'
import ReasoningSlider from '../../shared/ReasoningSlider.vue'
import PermissionModeOptions from './PermissionModeOptions.vue'

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
    description: 'Plain model mode. Reasoning is disabled.',
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
const gaugeColors = [
  '#64748b', // off
  '#38bdf8', // minimal
  '#22c55e', // low
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

const permissionBadge = computed(() => {
  if (chatStore.permissionMode === 'full') return { mode: 'full', label: 'Full Access', ariaLabel: 'full tool access' }
  if (chatStore.permissionMode === 'read-only') return { mode: 'read-only', label: 'Read Only', ariaLabel: 'read-only tools' }
  return null
})

function setPermissionMode(mode: PermissionMode): void {
  chatStore.setPermissionMode(mode).catch((err: unknown) => {
    console.error('[chat] Failed to change tool permissions:', err)
  })
}
</script>

<template>
  <HoverMenu
    placement="above"
    :max-width="304"
    :close-delay="240"
  >
    <template #trigger="{ open, toggle }">
      <button
        type="button"
        class="relative shrink-0 rounded-xl p-2.5 transition-colors focus:outline-none focus:ring-1 focus:ring-accent-500 text-theme-500 hover:text-theme-300"
        aria-haspopup="dialog"
        :aria-expanded="open"
        :aria-label="`Reasoning level: ${selectedOption.label}${permissionBadge ? `, ${permissionBadge.ariaLabel}` : ''}`"
        :title="`Reasoning: ${selectedOption.label}${permissionBadge ? ` · ${permissionBadge.label}` : ''}`"
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
        <span
          v-if="permissionBadge"
          class="permission-badge"
          :class="`permission-badge--${permissionBadge.mode}`"
          aria-hidden="true"
        >
          <svg
            v-if="permissionBadge.mode === 'full'"
            viewBox="0 0 24 24"
          >
            <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
          </svg>
          <svg
            v-else
            viewBox="0 0 24 24"
          >
            <path d="M12 5C6.5 5 2.5 12 2.5 12s4 7 9.5 7 9.5-7 9.5-7-4-7-9.5-7zm0 10.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" />
          </svg>
        </span>
      </button>
    </template>

    <template #content>
      <div
        class="w-[18rem] px-2 py-1.5"
        role="dialog"
        aria-label="Run settings"
        @click.stop
      >
        <PermissionModeOptions
          :model-value="chatStore.permissionMode"
          @update:model-value="setPermissionMode"
        />
        <div class="my-3 border-t border-theme-700/50" />
        <ReasoningSlider
          :model-value="selectedLevel"
          :levels="levels"
          @update:model-value="chatStore.setSessionReasoningEffort"
        />
      </div>
    </template>
  </HoverMenu>
</template>

<style scoped>
.permission-badge {
  position: absolute;
  top: 0.3rem;
  right: 0.3rem;
  display: flex;
  width: 0.8rem;
  height: 0.8rem;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  box-shadow: 0 0 0 1.5px var(--color-theme-900);
}

.permission-badge--full {
  background: #f59e0b;
}

.permission-badge--read-only {
  background: #38bdf8;
}

.permission-badge svg {
  width: 0.5rem;
  height: 0.5rem;
  fill: var(--color-theme-900);
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
