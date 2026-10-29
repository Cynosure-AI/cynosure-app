<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Icon } from '@iconify/vue'
import { useRouter } from 'vue-router'
import { api } from '../../api/client'
import type { CronResult } from '../../api/types'
import { formatRelativeTime } from '../../utils/project-format'
import { INTRO_PILLS_MS } from './chatIntro'

const props = defineProps<{ introStartedAt: number }>()
const router = useRouter()
const results = ref<CronResult[]>([])
const now = ref(Date.now())
const delays = new Map<string, number>()
let pollTimer: ReturnType<typeof setInterval> | undefined
let disposed = false
let loading = false

// Keep paragraphs and list contents readable without filling the preview with
// Markdown syntax. The full formatted reply is one click away.
function preview(content: string): string {
  const text = content
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text.length <= 600) return text
  const snippet = text.slice(0, 600)
  const lastSpace = snippet.search(/\s+\S*$/)
  return `${lastSpace > 520 ? snippet.slice(0, lastSpace) : snippet}…`
}

const cards = computed(() => results.value.slice(0, 3).map(result => ({
  ...result,
  preview: preview(result.content),
})))

async function loadResults(): Promise<void> {
  if (loading) return
  loading = true
  now.value = Date.now()
  try {
    const latest = await api.cronJobs.recentResults()
    if (disposed) return
    latest.forEach((result, index) => {
      if (!delays.has(result.conversationId)) {
        delays.set(result.conversationId,
          Math.max(0, INTRO_PILLS_MS - (performance.now() - props.introStartedAt)) + index * 120)
      }
    })
    results.value = latest
  } catch {
    // Keep the last known results through a transient connection failure.
  } finally {
    loading = false
  }
}

onMounted(() => {
  void loadResults()
  pollTimer = setInterval(() => void loadResults(), 30_000)
})
onBeforeUnmount(() => {
  disposed = true
  clearInterval(pollTimer)
})
</script>

<template>
  <section
    v-if="cards.length"
    class="recent-cron-results order-3 md:order-0 mx-auto w-full shrink-0 px-4 pb-4"
    aria-label="Recent cron results"
  >
    <div class="mx-auto max-w-5xl">
      <div class="mb-2 flex items-center justify-between gap-3 px-0.5 text-[11px] text-ink-muted">
        <span class="inline-flex items-center gap-1.5">
          <Icon
            icon="lucide:history"
            class="h-3.5 w-3.5"
          />
          Latest scheduled results
        </span>
        <RouterLink
          :to="{ name: 'triggers-cron' }"
          class="rounded transition-colors hover:text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
        >
          All schedules
        </RouterLink>
      </div>
      <div class="cron-result-grid flex gap-3 overflow-x-auto pb-1 md:grid md:grid-cols-3 md:overflow-visible">
        <button
          v-for="card in cards"
          :key="card.conversationId"
          type="button"
          class="cron-result-card group flex min-w-0 shrink-0 flex-col rounded-xl border border-theme-700/70 bg-theme-900/75 p-4 text-left transition-colors hover:border-accent-500/50 hover:bg-theme-800/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500"
          :style="{ animationDelay: `${delays.get(card.conversationId) ?? 0}ms` }"
          :aria-label="`Open scheduled result: ${card.title}`"
          @click="router.push({ name: 'conversation', params: { conversationId: card.conversationId } })"
        >
          <div class="mb-2.5 flex w-full items-center gap-2">
            <Icon
              icon="lucide:clock-check"
              class="h-3.5 w-3.5 shrink-0 text-accent-fg"
            />
            <span
              class="min-w-0 flex-1 truncate text-xs font-medium text-theme-200"
              :title="card.title"
            >
              {{ card.title }}
            </span>
            <time
              :datetime="new Date(card.completedAt).toISOString()"
              :title="new Date(card.completedAt).toLocaleString()"
              class="shrink-0 text-[10px] tabular-nums text-ink-muted"
            >
              {{ formatRelativeTime(card.completedAt, now) }}
            </time>
          </div>
          <p class="cron-result-preview line-clamp-7 whitespace-pre-line break-words text-xs leading-relaxed text-ink-secondary">
            {{ card.preview }}
          </p>
          <span class="mt-auto flex items-center gap-1 pt-3 text-[10px] text-ink-muted transition-colors group-hover:text-accent-fg">
            View full result
            <Icon
              icon="lucide:arrow-up-right"
              class="h-3 w-3"
            />
          </span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cron-result-card {
  width: min(82vw, 22rem);
  opacity: 0;
  animation: cron-result-in 480ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

.cron-result-preview {
  overflow-wrap: anywhere;
}

@keyframes cron-result-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (min-width: 768px) {
  .cron-result-card { width: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .cron-result-card { opacity: 1; animation: none; }
}
</style>
