<script setup lang="ts">
import { ref, watch, computed, onMounted } from "vue";
import type { AgentDefinition } from "../../api/types";
import { Icon } from "@iconify/vue";
import ToggleSwitch from "../shared/ToggleSwitch.vue";
import ProviderModelSelect from "../shared/ProviderModelSelect.vue";
import { useProviderStore } from "../../stores/provider.store";

const props = defineProps<{ agent: AgentDefinition }>();
const emit = defineEmits<{
  update: [field: string, value: unknown];
  updateReasoning: [enabled: boolean, effort: AgentDefinition['reasoningEffort']];
}>();

const AGENT_ROUTER_PROVIDER = "__agent_provider__";
const AGENT_ROUTER_MODEL = "__agent_model__";

const providerStore = useProviderStore();
const MIN_CONTEXT_TOKENS = 2048;
const DEFAULT_CONTEXT_TOKENS = 30720;
const CONTEXT_TOKEN_STEP = 2048;
const DEFAULT_MAX_CONTEXT_TOKENS = 262144;
const REASONING_LEVELS: Array<{
  value: AgentDefinition['reasoningEffort'] | 'off';
  label: string;
  description: string;
}> = [
  { value: 'off', label: 'Off', description: 'Disables reasoning when the selected model permits it. Also disables the task planner.' },
  { value: 'minimal', label: 'Minimal', description: 'Minimal reasoning for the lowest latency and token use.' },
  { value: 'low', label: 'Low', description: 'Quick reasoning for straightforward tasks.' },
  { value: 'medium', label: 'Medium', description: 'Balanced reasoning, speed, and token use.' },
  { value: 'high', label: 'High', description: 'Deep reasoning for complex tasks.' },
  { value: 'xhigh', label: 'Extra high', description: 'Extra reasoning for especially difficult tasks.' },
  { value: 'max', label: 'Maximum', description: "The provider's maximum available reasoning effort." },
];
const selectedReasoning = computed(() => props.agent.thinkingEnabled === false ? 'off' : props.agent.reasoningEffort || 'medium');
const selectedReasoningOption = computed(() => REASONING_LEVELS.find(level => level.value === selectedReasoning.value) || REASONING_LEVELS[3]);

function onReasoningChange(event: Event): void {
  const level = REASONING_LEVELS.find(item => item.value === (event.target as HTMLSelectElement).value);
  if (!level) return;
  emit('updateReasoning', level.value !== 'off', level.value === 'off' ? props.agent.reasoningEffort || 'medium' : level.value);
}

const autoRouterLeadingSelections = [
  {
    providerId: AGENT_ROUTER_PROVIDER,
    model: AGENT_ROUTER_MODEL,
    label: "Use agent model",
    iconName: "lucide:bot",
  },
];

onMounted(() => {
  if (providerStore.providers.length === 0) {
    providerStore.loadProviders();
  }
});

function onAutoRouterSelection(selection: {
  providerId: string;
  model: string;
}): void {
  emit("update", "autoRouterProviderId", selection.providerId);
  emit("update", "autoRouterModel", selection.model);
}

// ── Max Context Tokens local state ──
const maxCtxEnabled = computed(
  () =>
    typeof props.agent.maxContextTokens === "number" &&
    props.agent.maxContextTokens > 0,
);
const maxCtxInput = ref<number | "">(props.agent.maxContextTokens ?? "");
const maxCtxSliderMax = computed(() => {
  const value =
    typeof maxCtxInput.value === "number" ? maxCtxInput.value : DEFAULT_CONTEXT_TOKENS;
  return Math.max(DEFAULT_MAX_CONTEXT_TOKENS, Math.ceil(value / CONTEXT_TOKEN_STEP) * CONTEXT_TOKEN_STEP);
});

watch(
  () => props.agent.maxContextTokens,
  (v) => {
    maxCtxInput.value = typeof v === "number" && v > 0 ? v : "";
  },
);

function onMaxCtxToggle(enabled: boolean) {
  if (enabled) {
    const val = Number(maxCtxInput.value) || DEFAULT_CONTEXT_TOKENS;
    maxCtxInput.value = val;
    emit("update", "maxContextTokens", val);
  } else {
    maxCtxInput.value = "";
    emit("update", "maxContextTokens", null);
  }
}

function onMaxCtxBlur() {
  const val = Number(maxCtxInput.value);
  if (val >= MIN_CONTEXT_TOKENS) {
    const rounded = Math.round(val / CONTEXT_TOKEN_STEP) * CONTEXT_TOKEN_STEP;
    maxCtxInput.value = rounded;
    emit("update", "maxContextTokens", rounded);
  } else {
    maxCtxInput.value = "";
    emit("update", "maxContextTokens", null);
  }
}

function onMaxCtxSliderInput(event: Event) {
  const val = Number((event.target as HTMLInputElement).value);
  maxCtxInput.value = val;
  emit("update", "maxContextTokens", val);
}
</script>

<template>
  <div class="space-y-4">
    <!-- Auto-approve tools -->
    <div class="bg-theme-800 border border-theme-700 rounded-xl p-5">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <Icon
              icon="lucide:shield-check"
              class="w-4 h-4 text-status-warning"
            />
            <h3 class="text-sm font-medium text-theme-200">
              Auto-Approve All Tools
            </h3>
          </div>
          <p class="text-xs text-ink-muted leading-relaxed">
            When enabled, this agent will execute all tool calls without
            requiring manual approval. This applies to chat, sub-agent
            delegations, and cron jobs. When disabled, tool calls follow
            per-tool approval settings (HITL gate).
          </p>
        </div>
        <ToggleSwitch
          :model-value="agent.autoApproveTools"
          label="Auto-approve all tools"
          color="amber"
          class="mt-0.5"
          @update:model-value="emit('update', 'autoApproveTools', $event)"
        />
      </div>
    </div>

    <!-- Context Routing -->
    <div class="bg-theme-800 border border-theme-700 rounded-xl p-5">
      <div class="flex items-center gap-2 mb-1">
        <Icon
          icon="lucide:sparkles"
          class="w-4 h-4 text-accent-fg"
        />
        <h3 class="text-sm font-medium text-theme-200">
          Context Routing Model
        </h3>
      </div>
      <p class="text-xs text-ink-muted leading-relaxed">
        Override the provider and model used to prepare context for automatic tool discovery
        and memory retrieval. Those features are enabled independently in the Tools and Memory tabs.
        By default, uses the current agent / selected chat model.
      </p>

      <div class="mt-4">
        <label class="block text-xs text-ink-secondary mb-1.5">Provider / Model</label>
        <ProviderModelSelect
          :provider-id="agent.autoRouterProviderId || AGENT_ROUTER_PROVIDER"
          :model-value="agent.autoRouterModel || AGENT_ROUTER_MODEL"
          :providers="providerStore.providers"
          :leading-selections="autoRouterLeadingSelections"
          placeholder="Use agent model"
          @change="onAutoRouterSelection"
        />
      </div>
    </div>

    <!-- Thinking / Reasoning -->
    <div class="bg-theme-800 border border-theme-700 rounded-xl p-5">
      <div class="flex items-center gap-2 mb-1">
        <Icon
          icon="lucide:lightbulb"
          class="w-4 h-4 text-status-indigo"
        />
        <h3 class="text-sm font-medium text-theme-200">
          Thinking / Reasoning
        </h3>
      </div>
      <p class="text-xs text-ink-muted leading-relaxed">
        Set the default reasoning effort for this agent. Higher levels can improve complex answers but use more time and tokens.
      </p>
      <div class="mt-4 max-w-md">
        <label for="agent-reasoning-level" class="block text-xs font-medium text-theme-300 mb-1.5">Reasoning</label>
        <select
          id="agent-reasoning-level"
          :value="selectedReasoning"
          class="w-full bg-theme-900 border border-theme-600 rounded-lg px-3 py-2 text-sm text-theme-200 focus:outline-none focus:border-indigo-500/50"
          @change="onReasoningChange"
        >
          <option v-for="level in REASONING_LEVELS" :key="level.value" :value="level.value">
            {{ level.label }}
          </option>
        </select>
        <p class="mt-3 min-h-4 text-xs text-ink-muted">
          {{ selectedReasoningOption.description }}
        </p>
      </div>
    </div>

    <!-- Max Context Tokens -->
    <div class="bg-theme-800 border border-theme-700 rounded-xl p-5">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <Icon
              icon="lucide:ruler"
              class="w-4 h-4 text-status-warning"
            />
            <h3 class="text-sm font-medium text-theme-200">
              Max Context Tokens
            </h3>
          </div>
          <p class="text-xs text-ink-muted leading-relaxed">
            Set a hard cap on the number of tokens sent to the model. When set,
            the context trimmer will trigger at this limit instead of the
            model's full context window. Useful to reduce costs and mitigate the
            "lost in the middle" effect on long conversations.
          </p>
          <div
            v-if="maxCtxEnabled"
            class="mt-4 space-y-3"
          >
            <div class="flex items-center gap-3">
              <input
                :value="Number(maxCtxInput) || DEFAULT_CONTEXT_TOKENS"
                type="range"
                :min="MIN_CONTEXT_TOKENS"
                :max="maxCtxSliderMax"
                :step="CONTEXT_TOKEN_STEP"
                class="h-2 min-w-0 flex-1 cursor-pointer accent-amber-400"
                @input="onMaxCtxSliderInput"
              >
              <div class="flex shrink-0 items-center gap-2">
                <input
                  v-model.number="maxCtxInput"
                  type="number"
                  :min="MIN_CONTEXT_TOKENS"
                  :step="CONTEXT_TOKEN_STEP"
                  placeholder="e.g. 16384"
                  class="w-28 bg-theme-900 border border-theme-600 rounded-lg px-3 py-1.5 text-sm text-theme-200 placeholder:text-ink-faint focus:outline-none focus:border-amber-500/50"
                  @blur="onMaxCtxBlur"
                >
                <span class="text-xs text-ink-faint">tokens</span>
              </div>
            </div>
            <div class="flex items-center justify-between text-[11px] text-ink-faint">
              <span>{{ MIN_CONTEXT_TOKENS.toLocaleString() }}</span>
              <span>{{ maxCtxSliderMax.toLocaleString() }}</span>
            </div>
          </div>
        </div>
        <ToggleSwitch
          :model-value="maxCtxEnabled"
          label="Limit context window"
          color="amber"
          class="mt-0.5"
          @update:model-value="onMaxCtxToggle"
        />
      </div>
    </div>
  </div>
</template>
