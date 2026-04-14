<script setup lang="ts">
import type { AgentDefinition } from '../../api/client'
import { Icon } from '@iconify/vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()
</script>

<template>
  <div class="space-y-6">
    <!-- Auto-approve tools -->
    <div class="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <Icon
              icon="lucide:shield-check"
              class="w-4 h-4 text-amber-400"
            />
            <h3 class="text-sm font-medium text-zinc-200">
              Auto-Approve All Tools
            </h3>
          </div>
          <p class="text-xs text-zinc-500 leading-relaxed">
            When enabled, this agent will execute all tool calls without requiring manual approval.
            This applies to chat, sub-agent delegations, and cron jobs.
            When disabled, tool calls follow per-tool approval settings (HITL gate).
          </p>
        </div>
        <ToggleSwitch
          :model-value="agent.autoApproveTools"
          color="amber"
          class="mt-0.5"
          @update:model-value="emit('update', 'autoApproveTools', $event)"
        />
      </div>
    </div>

    <!-- Max tool output chars -->
    <div class="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <Icon
              icon="lucide:scissors"
              class="w-4 h-4 text-sky-400"
            />
            <h3 class="text-sm font-medium text-zinc-200">
              Max Tool Output Size
            </h3>
          </div>
          <p class="text-xs text-zinc-500 leading-relaxed">
            Maximum characters per tool result before truncation. Large outputs are buffered and accessible
            via a <code class="text-zinc-400">read_long_output</code> tool the LLM can call to page through
            the full content. Set to 0 to disable truncation (pass full output into context).
          </p>
          <div class="mt-3 flex items-center gap-3">
            <input
              type="number"
              :value="agent.maxToolOutputChars"
              min="0"
              step="1024"
              class="w-32 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
              @input="emit('update', 'maxToolOutputChars', Math.max(0, Number(($event.target as HTMLInputElement).value) || 0))"
            >
            <span class="text-xs text-zinc-500">chars (default: 16384 ≈ 4K tokens)</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Show in dashboard carousel -->
    <div class="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <Icon
              icon="lucide:layout-dashboard"
              class="w-4 h-4 text-teal-400"
            />
            <h3 class="text-sm font-medium text-zinc-200">
              Show in Dashboard Carousel
            </h3>
          </div>
          <p class="text-xs text-zinc-500 leading-relaxed">
            When enabled, this agent appears in the agent carousel on the dashboard.
            Disable to hide utility or internal agents from the quick-launch view.
          </p>
        </div>
        <ToggleSwitch
          :model-value="agent.showInCarousel"
          color="emerald"
          class="mt-0.5"
          @update:model-value="emit('update', 'showInCarousel', $event)"
        />
      </div>
    </div>
  </div>
</template>
