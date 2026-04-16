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

    <!-- Thinking / Reasoning -->
    <div class="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <Icon
              icon="lucide:brain"
              class="w-4 h-4 text-indigo-400"
            />
            <h3 class="text-sm font-medium text-zinc-200">
              Thinking / Reasoning
            </h3>
          </div>
          <p class="text-xs text-zinc-500 leading-relaxed">
            When enabled, models that support reasoning tokens will output their chain-of-thought
            before responding. This improves answer quality for complex tasks but uses more tokens.
            Applies to providers like OpenAI (o-series, GPT-5), OpenRouter (Claude, DeepSeek) and Anthropic.
          </p>
        </div>
        <ToggleSwitch
          :model-value="agent.thinkingEnabled !== false"
          color="indigo"
          class="mt-0.5"
          @update:model-value="emit('update', 'thinkingEnabled', $event)"
        />
      </div>
    </div>
  </div>
</template>
