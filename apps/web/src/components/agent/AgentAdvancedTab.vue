<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import type { AgentDefinition } from '../../api/types'
import { Icon } from '@iconify/vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()

// ── Max Context Tokens local state ──
const maxCtxEnabled = computed(() => typeof props.agent.maxContextTokens === 'number' && props.agent.maxContextTokens > 0)
const maxCtxInput = ref(props.agent.maxContextTokens ?? '')

watch(() => props.agent.maxContextTokens, (v) => {
  maxCtxInput.value = typeof v === 'number' && v > 0 ? v : ''
})

function onMaxCtxToggle(enabled: boolean) {
  if (enabled) {
    const val = Number(maxCtxInput.value) || 30720 // default to 30k if enabling without a value
    maxCtxInput.value = val
    emit('update', 'maxContextTokens', val)
  } else {
    maxCtxInput.value = ''
    emit('update', 'maxContextTokens', null)
  }
}

function onMaxCtxBlur() {
  const val = Number(maxCtxInput.value)
  if (val > 0) {
    emit('update', 'maxContextTokens', val)
  } else {
    maxCtxInput.value = ''
    emit('update', 'maxContextTokens', null)
  }
}
</script>

<template>
  <div class="space-y-4">
    <!-- Auto-approve tools -->
    <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-5">
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
    <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-5">
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
    <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-5">
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

    <!-- Max Context Tokens -->
    <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-5">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <Icon
              icon="lucide:ruler"
              class="w-4 h-4 text-amber-400"
            />
            <h3 class="text-sm font-medium text-zinc-200">
              Max Context Tokens
            </h3>
          </div>
          <p class="text-xs text-zinc-500 leading-relaxed">
            Set a hard cap on the number of tokens sent to the model.
            When set, the context trimmer will trigger at this limit instead of the model's full context window.
            Useful to reduce costs and mitigate the "lost in the middle" effect on long conversations.
          </p>
          <div
            v-if="maxCtxEnabled"
            class="mt-3"
          >
            <input
              v-model.number="maxCtxInput"
              type="number"
              min="2048"
              step="2048"
              placeholder="e.g. 16384"
              class="w-40 bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
              @blur="onMaxCtxBlur"
            >
            <span class="ml-2 text-xs text-zinc-600">tokens</span>
          </div>
        </div>
        <ToggleSwitch
          :model-value="maxCtxEnabled"
          color="amber"
          class="mt-0.5"
          @update:model-value="onMaxCtxToggle"
        />
      </div>
    </div>
  </div>
</template>
