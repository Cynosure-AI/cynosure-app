<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import type { DebugContextRound, DebugContextSnapshot } from '@shared/types'
import { api } from '../../../api/client'
import ModalDialog from '../../shared/ModalDialog.vue'

const props = defineProps<{
  modelValue: boolean
  conversationId: string | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const snapshot = ref<DebugContextSnapshot | null>(null)
const selectedRound = ref(0)
const loading = ref(false)
const error = ref('')
const copied = ref(false)

const activeRound = computed(() => snapshot.value?.rounds[selectedRound.value] ?? null)
const rawJson = computed(() => snapshot.value ? JSON.stringify(snapshot.value, null, 2) : '')
const assistantResponse = computed(() => {
  const response = activeRound.value?.response
  if (!response) return null
  return {
    role: 'assistant',
    content: response.content,
    ...(response.thinking ? { thinking: response.thinking } : {}),
    ...(response.toolCalls?.length ? { toolCalls: response.toolCalls } : {}),
    ...(response.images?.length ? { images: response.images } : {}),
    ...(response.usage ? { usage: response.usage } : {}),
    ...(response.error ? { error: response.error } : {}),
    completedAt: response.completedAt,
  }
})

function close(): void {
  emit('update:modelValue', false)
}

function formatTime(value?: number): string {
  return value ? new Date(value).toLocaleString() : '—'
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function roundTabLabel(round: DebugContextRound, index: number): string {
  if (round.phase === 'task-context') return 'Query plan'
  if (round.phase === 'memory-curation') return 'Memory verify'
  if (round.phase === 'tool-curation') return 'Tool curate'
  const agentRound = snapshot.value?.rounds
    .slice(0, index + 1)
    .filter((item) => !item.phase || item.phase === 'main-agent').length || 1
  return `Agent ${agentRound}`
}

async function refresh(): Promise<void> {
  if (!props.conversationId) {
    snapshot.value = null
    error.value = 'Start a conversation and send a message to capture its context.'
    return
  }

  loading.value = true
  error.value = ''
  try {
    snapshot.value = await api.chat.getDebugContext(props.conversationId)
    selectedRound.value = Math.max(0, snapshot.value.rounds.length - 1)
  } catch {
    snapshot.value = null
    error.value = 'No capture is available yet. Send a message while Debug Mode is enabled, then open the inspector again.'
  } finally {
    loading.value = false
  }
}

async function copyAll(): Promise<void> {
  if (!rawJson.value) return
  await navigator.clipboard.writeText(rawJson.value)
  copied.value = true
  window.setTimeout(() => { copied.value = false }, 1500)
}

function downloadAll(): void {
  if (!snapshot.value) return
  const blob = new Blob([rawJson.value], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `cynosure-context-${snapshot.value.conversationId}-${snapshot.value.executionId}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

watch(
  [() => props.modelValue, () => props.conversationId],
  ([open]) => {
    if (open) void refresh()
  },
)
</script>

<template>
  <ModalDialog
    :show="modelValue"
    title="LLM Context Inspector"
    icon="lucide:bug"
    icon-color="amber"
    max-width="max-w-7xl"
    max-height="max-h-[94vh]"
    @close="close"
  >
    <div class="space-y-4">
      <div class="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
        <p class="max-w-3xl text-xs leading-relaxed text-theme-400">
          This shows the complete request Cynosure assembled at its LLM gateway boundary for every model round,
          plus all output and reasoning the provider returned. It may contain sensitive prompts, memories, files,
          and tool results. Provider-private chain-of-thought is not available to Cynosure.
        </p>
        <div class="flex gap-2">
          <button
            class="inline-flex items-center gap-1.5 rounded-lg border border-theme-700 bg-theme-800 px-3 py-1.5 text-xs text-theme-300 hover:bg-theme-700"
            :disabled="loading"
            @click="refresh"
          >
            <Icon
              icon="lucide:refresh-cw"
              class="h-3.5 w-3.5"
              :class="{ 'animate-spin': loading }"
            />
            Refresh
          </button>
          <button
            class="inline-flex items-center gap-1.5 rounded-lg border border-theme-700 bg-theme-800 px-3 py-1.5 text-xs text-theme-300 hover:bg-theme-700 disabled:opacity-40"
            :disabled="!snapshot"
            @click="copyAll"
          >
            <Icon
              :icon="copied ? 'lucide:check' : 'lucide:copy'"
              class="h-3.5 w-3.5"
            />
            {{ copied ? 'Copied' : 'Copy JSON' }}
          </button>
          <button
            class="inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-500 disabled:opacity-40"
            :disabled="!snapshot"
            @click="downloadAll"
          >
            <Icon
              icon="lucide:download"
              class="h-3.5 w-3.5"
            />
            Export
          </button>
        </div>
      </div>

      <div
        v-if="loading && !snapshot"
        class="py-16 text-center text-sm text-theme-500"
      >
        Loading captured context…
      </div>

      <div
        v-else-if="error"
        class="rounded-lg border border-theme-700 bg-theme-850 p-8 text-center"
      >
        <Icon
          icon="lucide:scan-search"
          class="mx-auto mb-3 h-8 w-8 text-theme-600"
        />
        <p class="text-sm text-theme-400">
          {{ error }}
        </p>
      </div>

      <template v-else-if="snapshot">
        <div class="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-6">
          <div class="rounded-lg bg-theme-850 p-2.5">
            <span class="block text-theme-600">Provider</span><span class="text-theme-300">{{ snapshot.providerId || 'default' }}</span>
          </div>
          <div class="rounded-lg bg-theme-850 p-2.5">
            <span class="block text-theme-600">Model</span><span class="break-all text-theme-300">{{ snapshot.model || 'default' }}</span>
          </div>
          <div class="rounded-lg bg-theme-850 p-2.5">
            <span class="block text-theme-600">Rounds</span><span class="text-theme-300">{{ snapshot.rounds.length }}</span>
          </div>
          <div class="rounded-lg bg-theme-850 p-2.5">
            <span class="block text-theme-600">Context limit</span><span class="text-theme-300">{{ snapshot.contextWindow?.toLocaleString() || 'unknown' }}</span>
          </div>
          <div class="rounded-lg bg-theme-850 p-2.5">
            <span class="block text-theme-600">Strategy</span><span class="text-theme-300">{{ snapshot.contextStrategy || 'default' }}</span>
          </div>
          <div class="rounded-lg bg-theme-850 p-2.5">
            <span class="block text-theme-600">Updated</span><span class="text-theme-300">{{ formatTime(snapshot.updatedAt) }}</span>
          </div>
        </div>

        <div
          v-if="snapshot.rounds.length"
          class="flex gap-1 overflow-x-auto border-b border-theme-700 pb-2"
        >
          <button
            v-for="(round, index) in snapshot.rounds"
            :key="round.round"
            class="shrink-0 rounded-md px-3 py-1.5 text-xs transition-colors"
            :class="selectedRound === index ? 'bg-accent-600 text-white' : 'bg-theme-850 text-theme-400 hover:bg-theme-800'"
            @click="selectedRound = index"
          >
            {{ roundTabLabel(round, index) }}
          </button>
        </div>

        <div v-if="activeRound">
          <section class="space-y-3">
            <h4 class="flex items-center gap-2 text-sm font-medium text-theme-200">
              <Icon
                icon="lucide:arrow-up-to-line"
                class="h-4 w-4 text-sky-400"
              />
              {{ activeRound.label || 'Context sequence' }} · {{ activeRound.request.messages.length }} input messages · {{ activeRound.request.tools.length }} tools
            </h4>

            <div class="max-h-[58vh] space-y-2 overflow-y-auto pr-1">
              <details
                v-for="(message, index) in activeRound.request.messages"
                :key="index"
                class="rounded-lg border border-theme-700 bg-theme-850"
              >
                <summary class="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-theme-400">
                  {{ index + 1 }} · {{ message.role }}
                </summary>
                <pre class="debug-pre border-t border-theme-700 p-3">{{ pretty(message) }}</pre>
              </details>

              <details
                v-if="assistantResponse"
                class="rounded-lg border border-emerald-500/30 bg-emerald-500/5"
              >
                <summary class="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-emerald-400">
                  {{ activeRound.request.messages.length + 1 }} · assistant response
                  <span class="ml-1 normal-case font-normal text-theme-500">· returned after this input</span>
                </summary>
                <pre class="debug-pre border-t border-emerald-500/20 p-3">{{ pretty(assistantResponse) }}</pre>
              </details>

              <div
                v-else
                class="rounded-lg border border-dashed border-theme-700 p-5 text-center text-xs text-theme-500"
              >
                This round is still running. Refresh to append the assistant response.
              </div>

              <details class="rounded-lg border border-theme-700 bg-theme-850">
                <summary class="cursor-pointer px-3 py-2 text-xs font-semibold text-theme-400">
                  Tool definitions ({{ activeRound.request.tools.length }})
                </summary>
                <pre class="debug-pre border-t border-theme-700 p-3">{{ pretty(activeRound.request.tools) }}</pre>
              </details>

              <details class="rounded-lg border border-theme-700 bg-theme-850">
                <summary class="cursor-pointer px-3 py-2 text-xs font-semibold text-theme-400">
                  Request options
                </summary>
                <pre class="debug-pre border-t border-theme-700 p-3">{{ pretty({ model: activeRound.request.model, temperature: activeRound.request.temperature, maxTokens: activeRound.request.maxTokens, thinkingEnabled: activeRound.request.thinkingEnabled, reasoningEffort: activeRound.request.reasoningEffort }) }}</pre>
              </details>
            </div>
          </section>
        </div>

        <div
          v-else
          class="rounded-lg border border-dashed border-theme-700 p-8 text-center text-xs text-theme-500"
        >
          The execution is still preparing its first model request. Refresh in a moment.
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
