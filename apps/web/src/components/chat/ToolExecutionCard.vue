<script setup lang="ts">
import { ref, computed } from 'vue'
import { Icon } from '@iconify/vue'
import { usePreferencesStore } from '../../stores/preferences.store'
import CollapsibleSection from '../shared/CollapsibleSection.vue'

export interface ToolExecStep {
  iteration: number
  status: string
  message?: string
  toolCalls?: { name: string; arguments: string }[]
  results?: { name: string; success: boolean; output: string; error?: string; images?: string[] }[]
  streamingChoosing?: string
  timestamp: number
  taskId?: string
  maCodename?: string
  maAgentName?: string
  maPhase?: string
}

const props = defineProps<{
  /** Iteration number (1-based) */
  iteration: number
  /** Execution steps for this iteration */
  steps: ToolExecStep[]
  /** Whether this iteration is actively executing */
  isActive: boolean
}>()

const prefs = usePreferencesStore()
const expanded = ref(prefs.autoExpandToolCalls)
const lightboxSrc = ref<string | null>(null)
const statusMeta: Record<string, { label: string; icon: string; color: string }> = {
  'routing-tools': { label: 'Tool routing', icon: 'lucide:route', color: 'text-accent-300' },
  'awaiting-approval': { label: 'Awaiting approval', icon: 'lucide:shield-question', color: 'text-amber-400' },
  denied: { label: 'Denied', icon: 'lucide:shield-x', color: 'text-red-400' },
  executing: { label: 'Executing', icon: 'lucide:play', color: 'text-emerald-400' },
  'ma-status': { label: 'Orchestrator', icon: 'lucide:network', color: 'text-violet-400' },
  'ma-subagent-running': { label: 'Sub-agent running', icon: 'lucide:bot', color: 'text-indigo-400' },
  'ma-subagent-done': { label: 'Sub-agent done', icon: 'lucide:check', color: 'text-emerald-400' },
  'ma-subagent-failed': { label: 'Sub-agent failed', icon: 'lucide:x', color: 'text-red-400' },
  'ma-done': { label: 'Complete', icon: 'lucide:check-circle-2', color: 'text-emerald-400' },
  'ma-error': { label: 'Error', icon: 'lucide:alert-circle', color: 'text-red-400' },
  'ma-file': { label: 'File', icon: 'lucide:file-text', color: 'text-theme-400' },
  'memory-retrieved': { label: 'Memory retrieved', icon: 'lucide:brain', color: 'text-accent-300' },
}

function meta(s: string) {
  return statusMeta[s] ?? { label: s, icon: 'lucide:circle', color: 'text-theme-400' }
}

/** Current phase — the last meaningful status in this iteration */
const currentPhase = computed(() => {
  if (!props.steps.length) return meta('executing')
  const last = props.steps[props.steps.length - 1]
  return meta(last.status)
})

/** All tool names from this iteration */
const toolNames = computed(() => {
  for (const step of props.steps) {
    if (step.toolCalls?.length) return step.toolCalls.map(tc => tc.name)
  }
  return []
})

/** Latest results from this iteration */
const results = computed(() => {
  for (const step of [...props.steps].reverse()) {
    if (step.results?.length) return step.results
  }
  return []
})

/** Tool call arguments from this iteration */
const toolCallArgs = computed(() => {
  for (const step of props.steps) {
    if (step.toolCalls?.length) return step.toolCalls
  }
  return []
})

/** Whether all results succeeded */
const allSuccess = computed(() => results.value.length > 0 && results.value.every(r => r.success))
const anyFailed = computed(() => results.value.some(r => !r.success))

/** Elapsed time for this iteration */
const elapsedMs = computed(() => {
  if (!props.steps.length) return 0
  const first = props.steps[0].timestamp
  const last = props.steps[props.steps.length - 1].timestamp
  return last - first
})

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function prettifyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** Streaming content from this iteration */
const streamingText = computed(() => {
  for (const step of [...props.steps].reverse()) {
    if (step.streamingChoosing && !step.toolCalls?.length) return { label: 'Choosing tools…', text: step.streamingChoosing }
  }
  return null
})

/** MA context */
const maContext = computed(() => {
  for (const step of props.steps) {
    if (step.maCodename) return { codename: step.maCodename, agentName: step.maAgentName }
    if (step.maPhase) return { phase: step.maPhase }
  }
  return null
})
</script>

<template>
  <div class="px-4 py-1.5">
    <div class="max-w-[80%] ml-3 md:ml-12">
      <CollapsibleSection v-model="expanded">
        <template #trigger="{ expanded: isExpanded, toggle, triggerAttrs }">
          <!-- Compact header — always visible -->
          <button
            v-bind="triggerAttrs"
            class="w-full flex items-center gap-2 px-3 py-2 rounded-2xl text-[13px] font-medium transition-all group shadow-sm"
            :class="[
              isExpanded
                ? 'bg-theme-800 border border-theme-700/60 shadow-md'
                : 'bg-theme-800/60 hover:bg-theme-800 hover:border-theme-700/50 border border-transparent',
            ]"
            @click="toggle"
          >
            <!-- Status icon -->
            <Icon
              :icon="currentPhase.label === 'Denied' ? 'lucide:shield-x' : currentPhase.label === 'Tool routing' ? 'lucide:route' : toolNames.length && !results.length ? (isActive ? 'svg-spinners:ring-resize' : 'lucide:circle-slash') : allSuccess ? 'lucide:check-circle' : anyFailed ? 'lucide:alert-circle' : currentPhase.icon"
              class="w-3.5 h-3.5 shrink-0"
              :class="[
                currentPhase.label === 'Denied' ? 'text-red-400' :
                currentPhase.label === 'Tool routing' ? 'text-accent-300' :
                toolNames.length && !results.length ? (isActive ? 'text-accent-400' : 'text-theme-500') :
                allSuccess ? 'text-emerald-400' :
                anyFailed ? 'text-red-400' :
                currentPhase.color
              ]"
            />

            <!-- MA context label -->
            <span
              v-if="maContext?.codename"
              class="text-[10px] text-indigo-400/80 truncate max-w-16"
              :title="maContext.agentName || maContext.codename"
            >{{ maContext.codename }}</span>
            <span
              v-else-if="maContext?.phase"
              class="text-[10px] text-violet-400/80"
            >{{ maContext.phase }}</span>

            <!-- Tool names -->
            <div class="flex items-center gap-1 flex-1 min-w-0 overflow-hidden">
              <template v-if="toolNames.length">
                <span
                  v-for="name in toolNames.slice(0, 3)"
                  :key="name"
                  class="inline-flex items-center rounded-md bg-accent-500/10 px-1.5 py-0.5 text-[10px] text-accent-300 font-medium truncate max-w-35"
                >{{ name }}</span>
                <span
                  v-if="toolNames.length > 3"
                  class="text-[10px] text-theme-500"
                >+{{ toolNames.length - 3 }}</span>
              </template>
              <span
                v-else
                class="text-theme-400"
                :class="currentPhase.color"
              >{{ currentPhase.label }}</span>
            </div>

            <!-- Result count / status -->
            <span
              v-if="results.length"
              class="text-[10px] shrink-0"
              :class="allSuccess ? 'text-emerald-400/70' : 'text-red-400/70'"
            >{{ results.filter(r => r.success).length }}/{{ results.length }} ok</span>

            <!-- Elapsed -->
            <span
              v-if="elapsedMs > 0"
              class="text-[10px] text-theme-600 tabular-nums shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
            >{{ formatElapsed(elapsedMs) }}</span>

            <!-- Expand icon -->
            <Icon
              icon="lucide:chevron-down"
              class="w-3 h-3 text-theme-600 shrink-0 transition-transform"
              :class="{ 'rotate-180': isExpanded }"
            />
          </button>
        </template>

        <!-- Streaming text (always visible when actively streaming) -->
        <div
          v-if="streamingText && isActive"
          class="mt-1.5 ml-3 px-3 py-2 rounded-lg bg-theme-800/50 border border-theme-700/30"
        >
          <span class="text-[10px] text-theme-500 font-medium block mb-0.5">{{ streamingText.label }}</span>
          <p class="text-[11px] text-theme-400 whitespace-pre-wrap">
            {{ streamingText.text }}<span class="inline-block w-1.5 h-3 bg-theme-400/60 animate-pulse ml-0.5 align-middle" />
          </p>
        </div>

        <!-- Expanded details -->
        <div class="mt-1.5 ml-3 space-y-2">
          <!-- Tool call arguments -->
          <div
            v-if="toolCallArgs.length"
            class="space-y-1.5"
          >
            <div
              v-for="(tc, i) in toolCallArgs"
              :key="i"
              class="rounded-lg bg-theme-900/60 border border-theme-700/30 px-3 py-2"
            >
              <div class="flex items-center gap-1.5 mb-1">
                <Icon
                  icon="lucide:terminal"
                  class="w-3 h-3 text-accent-400"
                />
                <span class="text-[11px] text-accent-300 font-medium">{{ tc.name }}</span>
              </div>
              <pre
                v-if="tc.arguments && tc.arguments !== '{}'"
                class="text-[10px] text-theme-500 whitespace-pre-wrap break-all bg-theme-950/50 rounded px-2 py-1.5 max-h-32 overflow-y-auto font-mono"
              >{{ prettifyJson(tc.arguments) }}</pre>
            </div>
          </div>

          <!-- Results -->
          <div
            v-if="results.length"
            class="space-y-1.5"
          >
            <div
              v-for="(r, i) in results"
              :key="i"
              class="rounded-lg border px-3 py-2"
              :class="r.success
                ? 'bg-emerald-500/5 border-emerald-500/15'
                : 'bg-red-500/5 border-red-500/15'"
            >
              <div class="flex items-center gap-1.5 mb-1">
                <Icon
                  :icon="r.success ? 'lucide:check' : 'lucide:x'"
                  class="w-3 h-3"
                  :class="r.success ? 'text-emerald-400' : 'text-red-400'"
                />
                <span
                  class="text-[11px] font-medium"
                  :class="r.success ? 'text-theme-300' : 'text-red-300'"
                >{{ r.name }}</span>
              </div>
              <pre
                class="text-[10px] whitespace-pre-wrap break-all rounded px-2 py-1.5 max-h-64 overflow-y-auto font-mono"
                :class="r.success
                  ? 'text-theme-400 bg-theme-900/50'
                  : 'text-red-300/80 bg-red-950/30'"
              >{{ prettifyJson(r.output) }}</pre>
              <!-- Image thumbnails -->
              <div
                v-if="r.images?.length"
                class="flex gap-2 mt-2 flex-wrap"
              >
                <img
                  v-for="(img, ii) in r.images"
                  :key="ii"
                  :src="img"
                  class="h-24 rounded-lg border border-theme-600 object-cover cursor-pointer hover:border-accent-500 transition-colors"
                  :title="`Click to enlarge — Image ${ii + 1} from ${r.name}`"
                  @click.stop="lightboxSrc = img"
                >
              </div>
              <p
                v-if="r.error"
                class="mt-1 text-[10px] text-red-400"
              >
                {{ r.error }}
              </p>
            </div>
          </div>
        </div>
      </CollapsibleSection>
    </div>
  </div>

  <!-- Image lightbox -->
  <Teleport to="body">
    <div
      v-if="lightboxSrc"
      class="fixed inset-0 z-100 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      tabindex="0"
      @click.self="lightboxSrc = null"
      @keydown.escape="lightboxSrc = null"
    >
      <button
        class="absolute top-4 right-4 p-2 rounded-full bg-theme-800/80 text-theme-300 hover:text-white hover:bg-theme-700 transition-colors z-10"
        title="Close"
        @click="lightboxSrc = null"
      >
        <Icon
          icon="mdi:close"
          class="w-5 h-5"
        />
      </button>
      <img
        :src="lightboxSrc"
        class="max-w-[90vw] max-h-[90vh] rounded-xl shadow-2xl object-contain"
        @click.stop
      >
    </div>
  </Teleport>
</template>
