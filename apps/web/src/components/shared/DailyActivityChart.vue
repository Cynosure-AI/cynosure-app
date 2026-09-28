<script setup lang="ts">
import { ref, computed } from 'vue'

interface ModelBreakdown {
  model: string
  messages: number
  tokens: number
  estimatedCost?: number | null
}

interface DayData {
  date: string
  conversations: number
  messages: number
  tokens: number
  estimatedCost: number | null
  models: ModelBreakdown[]
}

import BaseCard from './BaseCard.vue'

const props = defineProps<{
  data: DayData[]
  days: number
}>()

const hoveredIndex = ref<number | null>(null)
const popoverStyle = ref<Record<string, string>>({})

const hoveredDay = computed(() =>
  hoveredIndex.value !== null ? filledData.value[hoveredIndex.value] : null
)

function onBarEnter(e: MouseEvent, i: number) {
  hoveredIndex.value = i
  updatePopoverPos(e)
}

function onBarMove(e: MouseEvent) {
  updatePopoverPos(e)
}

function updatePopoverPos(e: MouseEvent) {
  const popoverWidth = 250
  let left = e.clientX + 12
  if (left + popoverWidth > window.innerWidth - 8) left = e.clientX - popoverWidth - 12
  popoverStyle.value = {
    position: 'fixed',
    top: `${e.clientY - 8}px`,
    left: `${left}px`,
    transform: 'translateY(-100%)',
  }
}

function localDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

function shortDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const emptyDay: DayData = { date: '', conversations: 0, messages: 0, tokens: 0, estimatedCost: null, models: [] }

/** Fill all dates in the selected period, including today. */
const filledData = computed<DayData[]>(() => {
  const byDate = new Map(props.data.map(d => [d.date, d]))
  const result: DayData[] = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const start = new Date(today)
  start.setDate(start.getDate() - props.days + 1)

  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const key = localDateStr(d)
    result.push(byDate.get(key) ?? { ...emptyDay, date: key })
  }
  return result
})

const maxMessages = computed(() => Math.max(...filledData.value.map(d => d.messages), 1))

/** Decide how many date labels to show (avoid overlap). */
const labelInterval = computed(() => {
  const total = filledData.value.length
  if (total <= 7) return 1
  if (total <= 14) return 2
  if (total <= 31) return 5
  if (total <= 60) return 7
  return 14
})

/** Y-axis grid lines: pick 4 nice round values. */
const gridLines = computed(() => {
  const max = maxMessages.value
  if (max <= 4) return Array.from({ length: max }, (_, i) => i + 1)
  const step = Math.ceil(max / 4)
  const lines: number[] = []
  for (let v = step; v < max; v += step) lines.push(v)
  lines.push(max)
  return lines
})


</script>

<template>
  <BaseCard class="p-4 mb-6">
    <h3 class="text-xs font-medium text-ink-secondary mb-3">
      Daily Activity
    </h3>

    <div
      class="relative"
      style="height: 140px;"
    >
      <!-- Horizontal grid lines -->
      <div
        v-for="line in gridLines"
        :key="line"
        class="absolute left-6 right-0 border-theme-800/60"
        :style="{ bottom: (line / maxMessages * 100) + '%' }"
      >
        <span class="absolute -left-6 -top-2 text-[9px] text-ink-faint w-5 text-right">
          {{ line }}
        </span>
      </div>

      <!-- Bars container -->
      <div class="absolute inset-0 left-6 flex items-end gap-px">
        <div
          v-for="(day, i) in filledData"
          :key="day.date"
          class="flex-1 h-full flex flex-col items-center justify-end relative"
          style="min-width: 3px;"
          @mouseenter="onBarEnter($event, i)"
          @mousemove="onBarMove"
          @mouseleave="hoveredIndex = null"
        >
          <!-- Bar -->
          <div
            v-if="day.messages > 0"
            class="w-full rounded-t-sm bg-accent-500/60 transition-colors cursor-default"
            :class="hoveredIndex === i ? 'bg-accent-400/90' : ''"
            :style="{ height: (day.messages / maxMessages * 100) + '%' }"
          />



          <!-- Tick mark -->
          <div class="absolute w-px bg-theme-700/80 h-full bottom-0 left-0" />

          <!-- Date label -->
          <span
            v-if="i % labelInterval === 0 || i === filledData.length - 1"
            class="absolute -bottom-4 text-[9px] text-ink-faint whitespace-nowrap"
          >
            {{ shortDate(day.date) }}
          </span>
        </div>
      </div>
    </div>

    <!-- Bottom spacer for labels -->
    <div class="h-5" />

    <!-- Popover (teleported to body to avoid overflow clipping) -->
    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="hoveredDay && hoveredDay.messages > 0"
          class="w-72 rounded-lg border border-theme-700 bg-theme-900 shadow-xl shadow-black/40 p-2.5 text-xs pointer-events-none z-9999"
          :style="popoverStyle"
        >
          <div class="font-medium text-theme-300 mb-1.5">
            {{ shortDate(hoveredDay.date) }}
          </div>
          <div class="flex justify-between text-ink-secondary mb-0.5">
            <span>Messages</span><span class="text-theme-300">{{ hoveredDay.messages }}</span>
          </div>
          <div class="flex justify-between text-ink-secondary mb-0.5">
            <span>Conversations</span><span class="text-theme-300">{{ hoveredDay.conversations }}</span>
          </div>
          <div class="flex justify-between text-ink-secondary">
            <span>Tokens</span><span class="text-theme-300">{{ formatNumber(hoveredDay.tokens) }}</span>
          </div>
          <div
            v-if="hoveredDay.estimatedCost != null"
            class="flex justify-between text-ink-secondary mt-0.5"
          >
            <span>Est. Cost</span>
            <span class="text-status-warning">
              ${{ hoveredDay.estimatedCost < 0.01 ? hoveredDay.estimatedCost.toFixed(4) : hoveredDay.estimatedCost.toFixed(2) }}
            </span>
          </div>

          <template v-if="hoveredDay.models?.length">
            <div class="border-t border-theme-800 mt-2 pt-1.5 mb-1">
              <!-- header row -->
              <div
                class="grid text-[10px] text-ink-muted uppercase tracking-wider mb-1"
                style="grid-template-columns: 1fr 2.5rem 3.5rem;"
              >
                <span>Model</span>
                <span class="text-right">Reqs</span>
                <span class="text-right">Cost</span>
              </div>
              <!-- data rows -->
              <div
                v-for="m in hoveredDay.models.slice(0, 6)"
                :key="m.model"
                class="grid items-baseline text-ink-secondary mb-0.5"
                style="grid-template-columns: 1fr 2.5rem 3.5rem;"
              >
                <span class="truncate text-theme-300 pr-2">{{ m.model }}</span>
                <span class="text-right tabular-nums">{{ m.messages }}</span>
                <span
                  class="text-right tabular-nums"
                  :class="m.estimatedCost != null ? 'text-status-warning' : 'text-ink-faint'"
                >
                  <template v-if="m.estimatedCost != null">
                    ${{ m.estimatedCost < 0.01 ? m.estimatedCost.toFixed(4) : m.estimatedCost.toFixed(2) }}
                  </template>
                  <template v-else>—</template>
                </span>
              </div>
              <div
                v-if="hoveredDay.models.length > 6"
                class="text-ink-faint text-[10px] mt-0.5"
              >
                +{{ hoveredDay.models.length - 6 }} more
              </div>
            </div>
          </template>
        </div>
      </Transition>
    </Teleport>
  </BaseCard>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
