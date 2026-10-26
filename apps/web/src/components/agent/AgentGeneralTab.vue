<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from "vue";
import { Icon } from "@iconify/vue";
import { useProviderStore } from "../../stores/provider.store";
import type { AgentDefinition } from "../../api/types";
import IconUpload from "../shared/IconUpload.vue";
import AgentAvatar from "../shared/AgentAvatar.vue";
import CollapsibleSection from "../shared/CollapsibleSection.vue";
import AgentAvatarEditor from "./AgentAvatarEditor.vue";
import ProviderModelSelect from "../shared/ProviderModelSelect.vue";
import BaseCard from "../shared/BaseCard.vue";
import ToggleSwitch from "../shared/ToggleSwitch.vue";
import PromptSmartTagPicker from "../shared/PromptSmartTagPicker.vue";
import ReasoningSlider from "../shared/ReasoningSlider.vue";

/** `cyno` edits the default assistant: identity fields that only agents have are hidden. */
const props = defineProps<{ agent: AgentDefinition; cyno?: boolean }>();
const emit = defineEmits<{
  update: [field: string, value: unknown];
  updateReasoning: [enabled: boolean, effort: AgentDefinition['reasoningEffort']];
}>();

const providerStore = useProviderStore();
const systemPromptRef = ref<HTMLTextAreaElement | null>(null);

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

function onReasoningChange(value: AgentDefinition['reasoningEffort'] | 'off'): void {
  const level = REASONING_LEVELS.find(item => item.value === value);
  if (!level) return;
  emit('updateReasoning', level.value !== 'off', level.value === 'off' ? props.agent.reasoningEffort || 'medium' : level.value);
}

function autoResize(e: Event) {
  const el = e.target as HTMLTextAreaElement;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

function insertSystemPromptTag(tag: string): void {
  const el = systemPromptRef.value;
  if (!el) {
    emit("update", "systemPrompt", `${props.agent.systemPrompt}${tag}`);
    return;
  }

  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = `${el.value.slice(0, start)}${tag}${el.value.slice(end)}`;
  emit("update", "systemPrompt", next);

  nextTick(() => {
    el.focus();
    const cursor = start + tag.length;
    el.setSelectionRange(cursor, cursor);
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  });
}

onMounted(() =>
  nextTick(() => {
    if (systemPromptRef.value) {
      systemPromptRef.value.style.height = "auto";
      systemPromptRef.value.style.height =
        systemPromptRef.value.scrollHeight + "px";
    }
  }),
);
</script>

<template>
  <div class="space-y-4 mb-6">
    <!-- ── Identity ──────────────────────────────────────────── -->
    <BaseCard class="p-5 space-y-4">
      <IconUpload
        :icon-url="agent.iconUrl"
        @update="emit('update', 'iconUrl', $event)"
      >
        <template #description>
          An uploaded image is used everywhere {{ agent.name || 'this agent' }} appears. Without one,
          {{ cyno ? 'Cyno' : 'the agent' }} gets a generated avatar that reacts while it works.
        </template>
        <template #fallback>
          <AgentAvatar
            :name="agent.name"
            :avatar="agent.avatar"
          />
        </template>
      </IconUpload>

      <CollapsibleSection
        v-if="!agent.iconUrl"
        header-label="Customize generated avatar"
        header-icon="lucide:sparkles"
      >
        <AgentAvatarEditor
          class="px-1 pt-4"
          :name="agent.name"
          :avatar="agent.avatar"
          @update="emit('update', 'avatar', $event)"
        />
      </CollapsibleSection>

      <div>
        <label class="block text-sm text-ink-secondary mb-1.5">Name</label>
        <input
          :value="agent.name"
          type="text"
          class="w-full px-3 py-2 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
          @input="
            emit('update', 'name', ($event.target as HTMLInputElement).value)
          "
        >
      </div>

      <div v-if="!cyno">
        <label class="block text-sm text-ink-secondary mb-1.5">Internal Name</label>
        <p class="text-xs text-ink-faint mb-2">
          Machine identifier used by the orchestrator to invoke this agent as a sub-agent (e.g. <code class="text-ink-secondary">web_researcher</code>). Auto-generated from the name if left empty.
        </p>
        <input
          :value="agent.internalName"
          type="text"
          placeholder="auto-generated from name"
          class="w-full px-3 py-2 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 font-mono placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent-500"
          @input="
            emit('update', 'internalName', ($event.target as HTMLInputElement).value)
          "
        >
      </div>

      <div v-if="!cyno">
        <label class="block text-sm text-ink-secondary mb-1.5">Description</label>
        <textarea
          :value="agent.description"
          class="w-full px-3 py-2 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500 resize-none h-20"
          @input="
            emit(
              'update',
              'description',
              ($event.target as HTMLTextAreaElement).value,
            )
          "
        />
      </div>

      <div
        v-if="!cyno"
        class="flex items-center justify-between gap-4 rounded-lg border border-theme-800 bg-theme-900/50 px-3 py-2"
      >
        <span class="text-sm text-theme-300">
          Favorite this agent
        </span>
        <ToggleSwitch
          :model-value="agent.favorite"
          label="Favorite this agent"
          color="amber"
          size="md"
          @update:model-value="emit('update', 'favorite', $event)"
        />
      </div>
      <dl
        v-if="!cyno"
        class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted"
      >
        <div class="flex items-center gap-1">
          <dt>Created</dt>
          <dd class="text-ink-secondary">
            {{ formatTimestamp(agent.createdAt) }}
          </dd>
        </div>
        <div class="flex items-center gap-1">
          <dt>Last changed</dt>
          <dd class="text-ink-secondary">
            {{ formatTimestamp(agent.updatedAt) }}
          </dd>
        </div>
      </dl>
    </BaseCard>

    <!-- ── Model ─────────────────────────────────────────────── -->
    <BaseCard class="p-5 space-y-4">
      <div>
        <label class="block text-sm text-ink-secondary mb-1.5">Provider / Model</label>
        <p class="text-xs text-ink-faint mb-2">
          Overrides the provider's default model for this agent. Leave empty to
          use the provider default.
        </p>
        <div class="flex gap-2">
          <div class="flex-1">
            <ProviderModelSelect
              :provider-id="agent.providerId"
              :model-value="agent.model || ''"
              :providers="providerStore.providers"
              :model-types="['llm', 'image', 'video', 'transcription']"
              placeholder="Use provider default"
              @change="
                (selection) => {
                  emit('update', 'providerId', selection.providerId);
                  emit('update', 'model', selection.model);
                }
              "
            />
          </div>
        </div>
      </div>
    </BaseCard>

    <!-- Thinking / Reasoning -->
    <BaseCard class="p-5">
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
        <ReasoningSlider
          id="agent-reasoning-level"
          :model-value="selectedReasoning"
          :levels="REASONING_LEVELS"
          @update:model-value="onReasoningChange"
        />
        <p class="mt-3 min-h-4 text-xs text-ink-muted">
          {{ selectedReasoningOption.description }}
        </p>
      </div>
    </BaseCard>

    <!-- ── System Prompt ──────────────────────────────────────── -->
    <BaseCard class="p-5">
      <div class="flex items-center justify-between gap-3 mb-1.5">
        <label class="block text-sm text-ink-secondary">System Prompt</label>
        <PromptSmartTagPicker @insert="insertSystemPromptTag" />
      </div>
      <p class="text-xs text-ink-faint mb-2">
        Prepended as a system message alongside the built-in agentic
        instructions — does not replace them.
      </p>
      <textarea
        ref="systemPromptRef"
        :value="agent.systemPrompt"
        placeholder="Optional system instructions..."
        class="w-full px-3 py-2 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent-500 resize-none font-mono min-h-64"
        style="field-sizing: content"
        @input="
          emit(
            'update',
            'systemPrompt',
            ($event.target as HTMLTextAreaElement).value,
          ); autoResize($event)
        "
      />
    </BaseCard>
  </div>
</template>
