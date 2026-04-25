<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue'
import type { AgentDefinition } from '../../api/types'
import { Icon } from '@iconify/vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import ProviderSelect from '../shared/ProviderSelect.vue'
import ModelSelect from '../shared/ModelSelect.vue'
import { useProviderStore } from '../../stores/provider.store'
import { usePreferencesStore } from '../../stores/preferences.store'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()

const providerStore = useProviderStore()
const prefs = usePreferencesStore()

const toolRouterModels = ref<string[]>([])
const toolRouterLoadingModels = ref(false)

const effectiveToolRouterProviderId = computed(() =>
  props.agent.toolRouterProviderId || prefs.toolRouterProviderId || props.agent.providerId || ''
)

async function fetchToolRouterModels(providerId: string) {
  if (!providerId) {
    toolRouterModels.value = []
    return
  }
  toolRouterLoadingModels.value = true
  try {
    toolRouterModels.value = await providerStore.listModels(providerId, 'llm')
  } catch {
    toolRouterModels.value = []
  } finally {
    toolRouterLoadingModels.value = false
  }
}

onMounted(() => {
  if (providerStore.providers.length === 0) {
    providerStore.loadProviders()
  }
})

watch(() => props.agent.toolRouterProviderId, (_id, oldId) => {
  if (oldId !== undefined) emit('update', 'toolRouterModel', '')
})

watch(effectiveToolRouterProviderId, (providerId) => {
  fetchToolRouterModels(providerId)
}, { immediate: true })

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

    <!-- Tool Router Model -->
    <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-5">
      <div class="flex items-start gap-4">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <Icon
              icon="lucide:route"
              class="w-4 h-4 text-emerald-400"
            />
            <h3 class="text-sm font-medium text-zinc-200">
              Tool Router Model
            </h3>
          </div>
          <p class="text-xs text-zinc-500 leading-relaxed">
            Override the provider and model this agent uses when auto tool routing is enabled.
            Leave blank to use the global router settings from Preferences.
          </p>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4 pt-4 border-t border-zinc-700">
            <div>
              <label class="block text-xs text-zinc-400 mb-1.5">Provider</label>
              <ProviderSelect
                :model-value="agent.toolRouterProviderId || ''"
                :providers="providerStore.providers"
                include-default
                default-label="Use global router provider"
                placeholder="Use global router provider"
                @update:model-value="emit('update', 'toolRouterProviderId', $event)"
              />
            </div>
            <div>
              <label class="block text-xs text-zinc-400 mb-1.5">Model</label>
              <ModelSelect
                :model-value="agent.toolRouterModel || ''"
                :models="toolRouterModels"
                include-default
                :default-label="toolRouterLoadingModels ? 'Loading models...' : 'Use global router model'"
                :placeholder="toolRouterLoadingModels ? 'Loading models...' : 'Use global router model'"
                :filterable="true"
                @update:model-value="emit('update', 'toolRouterModel', $event)"
              />
            </div>
          </div>
        </div>
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
