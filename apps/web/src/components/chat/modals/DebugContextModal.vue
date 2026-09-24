<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import type { ChatEvent } from '@shared/types'
import { api } from '../../../api/client'
import ModalDialog from '../../shared/ModalDialog.vue'

const props = defineProps<{
  modelValue: boolean
  conversationId: string | null
}>()

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const events = ref<ChatEvent[]>([])
const loading = ref(false)
const error = ref('')
const copied = ref(false)
const selectedExecution = ref<string | null>(null)
let refreshVersion = 0
const executions = computed(() => [...new Set(events.value.map(event => event.executionId))])
const visibleEvents = computed(() => selectedExecution.value
  ? events.value.filter(event => event.executionId === selectedExecution.value)
  : events.value)
const rawJson = computed(() => JSON.stringify(visibleEvents.value, null, 2))

function formatTime(value: number): string {
  return new Date(value).toLocaleString()
}

async function refresh(): Promise<void> {
  const version = ++refreshVersion
  if (!props.conversationId) {
    events.value = []
    error.value = 'Start a conversation to inspect its chat protocol.'
    return
  }
  loading.value = true
  error.value = ''
  try {
    const conversationId = props.conversationId
    const result: ChatEvent[] = []
    let after = 0
    while (true) {
      const page = await api.chat.getEvents(conversationId, after, 5000)
      result.push(...page.events)
      if (!page.events.length || page.events.at(-1)!.sequence >= page.latestSequence) break
      after = page.events.at(-1)!.sequence
    }
    if (version !== refreshVersion || props.conversationId !== conversationId) return
    events.value = result
    if (selectedExecution.value && !result.some(event => event.executionId === selectedExecution.value)) {
      selectedExecution.value = null
    }
  } catch {
    if (version === refreshVersion) {
      events.value = []
      error.value = 'Could not load the chat protocol from the database.'
    }
  } finally {
    if (version === refreshVersion) loading.value = false
  }
}

async function copyAll(): Promise<void> {
  await navigator.clipboard.writeText(rawJson.value)
  copied.value = true
  window.setTimeout(() => { copied.value = false }, 1500)
}

function downloadAll(): void {
  if (!props.conversationId) return
  const blob = new Blob([rawJson.value], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `cynosure-chat-protocol-${props.conversationId}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

watch(
  [() => props.modelValue, () => props.conversationId],
  ([open], previous) => {
    if (previous && props.conversationId !== previous[1]) selectedExecution.value = null
    if (open) void refresh()
  },
)
</script>

<template>
  <ModalDialog
    :show="modelValue"
    title="Chat Protocol Inspector"
    icon="lucide:bug"
    icon-color="amber"
    max-width="max-w-7xl"
    max-height="max-h-[94vh]"
    @close="emit('update:modelValue', false)"
  >
    <div class="space-y-4">
      <div class="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
        <p class="max-w-3xl text-xs leading-relaxed text-theme-400">
          Persisted chat protocol events for this conversation, in database sequence order. Events include messages,
          tool activity, routing decisions, model output, usage, and errors. Exports may contain sensitive content.
        </p>
        <div class="flex gap-2">
          <button class="inline-flex items-center gap-1.5 rounded-lg border border-theme-700 bg-theme-800 px-3 py-1.5 text-xs text-theme-300 hover:bg-theme-700" :disabled="loading" @click="refresh">
            <Icon icon="lucide:refresh-cw" class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" /> Refresh
          </button>
          <button class="inline-flex items-center gap-1.5 rounded-lg border border-theme-700 bg-theme-800 px-3 py-1.5 text-xs text-theme-300 hover:bg-theme-700 disabled:opacity-40" :disabled="!events.length" @click="copyAll">
            <Icon :icon="copied ? 'lucide:check' : 'lucide:copy'" class="h-3.5 w-3.5" /> {{ copied ? 'Copied' : 'Copy JSON' }}
          </button>
          <button class="inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-500 disabled:opacity-40" :disabled="!events.length" @click="downloadAll">
            <Icon icon="lucide:download" class="h-3.5 w-3.5" /> Export
          </button>
        </div>
      </div>

      <div v-if="loading && !events.length" class="py-16 text-center text-sm text-theme-500">Loading chat protocol…</div>
      <div v-else-if="error" class="rounded-lg border border-theme-700 bg-theme-850 p-8 text-center text-sm text-theme-400">{{ error }}</div>
      <div v-else-if="!events.length" class="rounded-lg border border-theme-700 bg-theme-850 p-8 text-center text-sm text-theme-400">No persisted chat events yet.</div>
      <template v-else>
        <div class="flex flex-wrap items-center gap-2 text-xs text-theme-400">
          <span>{{ visibleEvents.length }} events</span>
          <span>·</span>
          <span>{{ executions.length }} executions</span>
          <select v-model="selectedExecution" class="rounded-lg border border-theme-700 bg-theme-850 px-2 py-1 text-theme-300" aria-label="Filter by execution">
            <option :value="null">All executions</option>
            <option v-for="executionId in executions" :key="executionId" :value="executionId">{{ executionId }}</option>
          </select>
        </div>
        <div class="max-h-[65vh] space-y-2 overflow-y-auto pr-1">
          <details v-for="event in visibleEvents" :key="event.sequence" class="rounded-lg border border-theme-700 bg-theme-850">
            <summary class="cursor-pointer px-3 py-2 text-xs text-theme-300">
              <span class="font-semibold">#{{ event.sequence }} · {{ event.type }}</span>
              <span class="ml-2 text-theme-500">{{ formatTime(event.createdAt) }} · {{ event.executionId }}</span>
            </summary>
            <pre class="debug-pre border-t border-theme-700 p-3">{{ JSON.stringify(event, null, 2) }}</pre>
          </details>
        </div>
      </template>
    </div>
  </ModalDialog>
</template>

<style scoped>
.debug-pre {
  max-width: 100%;
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  line-height: 1.55;
  color: var(--color-theme-300);
}
</style>
