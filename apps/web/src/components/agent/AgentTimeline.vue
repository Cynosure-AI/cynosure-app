<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { usePreferencesStore } from '../../stores/preferences.store'
import CollapsibleSection from '../shared/CollapsibleSection.vue'

const agentStore = useAgentStore()
const prefs = usePreferencesStore()
const expandedSteps = ref<Set<number>>(new Set())

function stepCollapseId(iteration: number, stepIndex: number): number {
  return stepIndex + iteration * 100
}

function isStepExpanded(iteration: number, stepIndex: number): boolean {
  return prefs.autoExpandSteps || expandedSteps.value.has(stepCollapseId(iteration, stepIndex))
}

function setStepExpanded(iteration: number, stepIndex: number, expanded: boolean): void {
  if (expanded) expandedSteps.value.add(stepCollapseId(iteration, stepIndex))
  else expandedSteps.value.delete(stepCollapseId(iteration, stepIndex))
}

const statusMeta: Record<string, { label: string; icon: string; color: string; line: string }> = {
  'routing-tools': {
    label: 'Tool Routing',
    icon: '◇',
    color: 'text-blue-300',
    line: 'bg-blue-500/40'
  },
  'choosing-tools': {
    label: 'Choosing Tools',
    icon: '⚙',
    color: 'text-cyan-400',
    line: 'bg-cyan-500/40'
  },
  'awaiting-approval': {
    label: 'Awaiting Approval',
    icon: '⏳',
    color: 'text-amber-400',
    line: 'bg-amber-500/40'
  },
  executing: {
    label: 'Executing',
    icon: '▶',
    color: 'text-emerald-400',
    line: 'bg-emerald-500/40'
  },
  'memory-retrieved': { label: 'Memory Retrieved', icon: '🧠', color: 'text-blue-300', line: 'bg-blue-400/40' },
  // MA orchestrator statuses
  'ma-status': { label: 'Orchestrator', icon: '◆', color: 'text-violet-400', line: 'bg-violet-500/40' },
  'ma-subagent-running': { label: 'Sub-Agent Running', icon: '▸', color: 'text-indigo-400', line: 'bg-indigo-500/40' },
  'ma-subagent-done': { label: 'Sub-Agent Done', icon: '✓', color: 'text-emerald-400', line: 'bg-emerald-500/40' },
  'ma-subagent-failed': { label: 'Sub-Agent Failed', icon: '✗', color: 'text-red-400', line: 'bg-red-500/40' },
  'ma-done': { label: 'Complete', icon: '✓', color: 'text-emerald-400', line: 'bg-emerald-500/40' },
  'ma-error': { label: 'Error', icon: '✗', color: 'text-red-400', line: 'bg-red-500/40' },
  'ma-file': { label: 'File', icon: '📄', color: 'text-zinc-400', line: 'bg-zinc-500/40' },
}

function meta(s: string) {
  return statusMeta[s] ?? { label: s, icon: '·', color: 'text-zinc-400', line: 'bg-zinc-600' }
}

function elapsed(step: { timestamp: number }, nextStep?: { timestamp: number }): string {
  const end = nextStep?.timestamp ?? Date.now()
  const ms = end - step.timestamp
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}

const iterationGroups = computed(() => {
  // Group by taskId + iteration to keep different executors separate
  const groups: { iteration: number; steps: (typeof agentStore.executionSteps)[number][] }[] = []
  for (const step of agentStore.executionSteps) {
    const key = `${step.taskId || ''}-${step.iteration}`
    let group = groups.find((g) => `${g.steps[0]?.taskId || ''}-${g.iteration}` === key)
    if (!group) {
      group = { iteration: step.iteration, steps: [] }
      groups.push(group)
    }
    group.steps.push(step)
  }
  return groups
})
</script>

<template>
  <div
    v-if="agentStore.hasSteps || agentStore.isExecuting"
    class="flex gap-3 px-4 py-1"
  >
    <!-- Left margin to align with avatar -->
    <div class="w-7 shrink-0" />

    <!-- Timeline -->
    <div class="flex-1 max-w-[80%]">
      <div class="relative pl-4">
        <!-- Vertical timeline line -->
        <div
          class="absolute left-1.25 top-2 bottom-2 w-px"
          :class="agentStore.isExecuting ? 'bg-blue-500/30' : 'bg-zinc-700/50'"
        />

        <!-- Each iteration group -->
        <div
          v-for="group in iterationGroups"
          :key="group.iteration"
          class="mb-1 last:mb-0"
        >
          <!-- Steps in this iteration -->
          <div
            v-for="(step, sIdx) in group.steps"
            :key="sIdx"
            class="relative"
          >
            <!-- Timeline node -->
            <div
              class="absolute -left-2.75 top-1.75 h-2.5 w-2.5 rounded-full border-2"
              :class="[
                meta(step.status).line,
                step === agentStore.executionSteps[agentStore.executionSteps.length - 1] &&
                  agentStore.isExecuting
                  ? 'animate-pulse border-current ' + meta(step.status).color
                  : 'border-zinc-800 bg-zinc-600'
              ]"
            />

            <!-- Step content -->
            <CollapsibleSection
              :model-value="isStepExpanded(group.iteration, sIdx)"
              @update:model-value="setStepExpanded(group.iteration, sIdx, $event)"
            >
              <template #trigger="{ toggle }">
                <button
                  class="w-full text-left flex items-center gap-1.5 py-1 pl-1 pr-2 text-xs rounded hover:bg-zinc-800/40 transition group"
                  @click="toggle"
                >
                  <span
                    v-if="step.maCodename"
                    class="text-[10px] text-indigo-400/80 tabular-nums truncate max-w-20"
                    :title="step.maAgentName || step.maCodename"
                  >
                    {{ step.maCodename }}
                  </span>
                  <span
                    v-else-if="step.maPhase"
                    class="text-[10px] text-violet-400/80 tabular-nums"
                  >
                    {{ step.maPhase === 'planning' ? 'orch' : step.maPhase === 'synthesizing' ? 'synth' : step.maPhase }}
                  </span>
                  <span
                    v-else
                    class="text-[10px] text-zinc-600 tabular-nums w-5"
                  >
                    #{{ step.iteration + 1 }}
                  </span>
                  <span
                    :class="meta(step.status).color"
                    class="font-medium text-[11px]"
                  >
                    {{ meta(step.status).icon }} {{ step.message || meta(step.status).label }}
                  </span>

                  <!-- Tool badges (compact) -->
                  <span
                    v-for="tc in step.toolCalls?.slice(0, 2)"
                    :key="tc.name"
                    class="rounded bg-blue-500/15 px-1 py-0.5 text-[9px] text-blue-300/80"
                  >
                    {{ tc.name }}
                  </span>
                  <span
                    v-if="(step.toolCalls?.length ?? 0) > 2"
                    class="text-[9px] text-zinc-600"
                  >
                    +{{ (step.toolCalls?.length ?? 0) - 2 }}
                  </span>

                  <!-- Elapsed time -->
                  <span
                    class="ml-auto text-[9px] text-zinc-600 tabular-nums opacity-0 group-hover:opacity-100 transition"
                  >
                    {{
                      elapsed(
                        step,
                        agentStore.executionSteps[agentStore.executionSteps.indexOf(step) + 1]
                      )
                    }}
                  </span>
                </button>
              </template>

              <!-- Streaming text — always visible when actively streaming -->
              <div
                v-if="step.streamingChoosing && !step.toolCalls?.length"
                class="ml-6 mb-1 space-y-1.5 text-[10px]"
              >
                <div
                  v-if="step.streamingChoosing && !step.toolCalls?.length"
                  class="rounded bg-cyan-500/5 border border-cyan-500/10 px-2.5 py-1.5 text-zinc-400 whitespace-pre-wrap"
                >
                  <span class="text-cyan-400/70 text-[9px] font-medium block mb-0.5">Choosing tools…</span>
                  {{ step.streamingChoosing }}
                  <span class="inline-block w-1.5 h-3 bg-cyan-400/60 animate-pulse ml-0.5 align-middle" />
                </div>
              </div>

              <!-- Expanded details -->
              <div class="ml-6 mb-1 space-y-1.5 text-[10px]">
                <!-- Tool Selection Reasoning (only in expanded mode, after streaming is complete) -->
                <div
                  v-if="step.streamingChoosing && step.toolCalls?.length"
                  class="rounded bg-zinc-800/70 px-2.5 py-1.5"
                >
                  <div class="text-[10px] uppercase tracking-wider text-zinc-500 mb-0.5">
                    Tool Selection
                  </div>
                  <div class="text-zinc-400 whitespace-pre-wrap">
                    {{ step.streamingChoosing }}
                  </div>
                </div>

                <!-- Tool calls with args -->
                <div
                  v-if="step.toolCalls?.length"
                  class="space-y-1"
                >
                  <div
                    v-for="(tc, ti) in step.toolCalls"
                    :key="ti"
                    class="rounded bg-zinc-800/70 p-2"
                  >
                    <span class="text-blue-300 font-medium">{{ tc.name }}</span>
                    <pre
                      v-if="tc.arguments"
                      class="mt-1 text-zinc-500 whitespace-pre-wrap break-all bg-zinc-900/60 rounded p-1.5 overflow-x-auto"
                    >{{ formatArgs(tc.arguments) }}</pre>
                  </div>
                </div>

                <!-- Results -->
                <div
                  v-if="step.results?.length"
                  class="space-y-1"
                >
                  <div
                    v-for="(r, ri) in step.results"
                    :key="ri"
                    class="rounded p-2 border"
                    :class="
                      r.success
                        ? 'bg-emerald-500/5 border-emerald-500/15'
                        : 'bg-red-500/5 border-red-500/15'
                    "
                  >
                    <div class="flex items-center gap-1 mb-1">
                      <span
                        :class="r.success ? 'text-emerald-400' : 'text-red-400'"
                        class="font-bold"
                      >
                        {{ r.success ? '✓' : '✗' }}
                      </span>
                      <span class="text-zinc-300">{{ r.name }}</span>
                    </div>
                    <pre
                      class="whitespace-pre-wrap break-all bg-zinc-900/50 rounded p-1.5 overflow-x-auto max-h-128 overflow-y-auto"
                      :class="r.success ? 'text-zinc-400' : 'text-red-300'"
                    >{{ r.output }}</pre>
                    <!-- Image thumbnails from tool result -->
                    <div
                      v-if="r.images?.length"
                      class="flex gap-2 mt-1.5 flex-wrap"
                    >
                      <img
                        v-for="(img, ii) in r.images"
                        :key="ii"
                        :src="img"
                        class="h-24 rounded border border-zinc-600 object-cover cursor-pointer hover:border-zinc-400 transition"
                        :title="`Image ${ii + 1} from ${r.name}`"
                      >
                    </div>
                    <div
                      v-if="r.error"
                      class="mt-1 text-red-400"
                    >
                      Error: {{ r.error }}
                    </div>
                  </div>
                </div>
              </div>
            </CollapsibleSection>
          </div>
        </div>

        <!-- Active pulse at bottom when running -->
        <div
          v-if="agentStore.isExecuting"
          class="relative py-1"
        >
          <div
            class="absolute -left-2 top-1.75 h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse"
          />
          <span class="pl-1 text-[10px] text-zinc-500 animate-pulse">Working…</span>
        </div>
      </div>
    </div>
  </div>
</template>
