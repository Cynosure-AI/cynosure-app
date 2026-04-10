<script setup lang="ts">
import { computed } from 'vue'

interface DayData {
  date: string
  conversations: number
  messages: number
  tokens: number
}

const props = defineProps<{
  data: DayData[]
  days: number
}>()

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
    result.push(byDate.get(key) ?? { date: key, conversations: 0, messages: 0, tokens: 0 })
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
  <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 mb-6">
    <h3 class="text-xs font-medium text-zinc-400 mb-3">
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
        class="absolute left-6 right-0 border-t border-zinc-800/60"
        :style="{ bottom: (line / maxMessages * 100) + '%' }"
      >
        <span class="absolute -left-6 -top-2 text-[9px] text-zinc-600 w-5 text-right">
          {{ line }}
        </span>
      </div>

      <!-- Bars container -->
      <div class="absolute inset-0 left-6 flex items-end gap-px">
        <div
          v-for="(day, i) in filledData"
          :key="day.date"
          class="flex-1 h-full flex flex-col items-center justify-end"
          style="min-width: 3px;"
        >
          <!-- Bar -->
          <div
            v-if="day.messages > 0"
            class="w-full rounded-t-sm bg-blue-500/60 hover:bg-blue-400/80 transition-colors cursor-default"
            :style="{ height: (day.messages / maxMessages * 100) + '%' }"
            :title="`${shortDate(day.date)}: ${day.messages} msgs, ${day.conversations} convos, ${formatNumber(day.tokens)} tokens`"
          />

          <!-- Date label -->
          <span
            v-if="i % labelInterval === 0 || i === filledData.length - 1"
            class="absolute -bottom-4 text-[9px] text-zinc-600 whitespace-nowrap"
          >
            {{ shortDate(day.date) }}
          </span>
        </div>
      </div>
    </div>

    <!-- Bottom spacer for labels -->
    <div class="h-5" />
  </div>
</template>
