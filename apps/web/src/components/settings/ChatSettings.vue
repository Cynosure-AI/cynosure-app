<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Icon } from "@iconify/vue";
import {
  usePreferencesStore,
  type ContextStrategy,
} from "../../stores/preferences.store";
import { useProviderStore } from "../../stores/provider.store";
import { api } from "../../api/client";
import { RUNTIME_LIMITS } from "@shared/runtime-limits";
import ProviderModelSelect from "../shared/ProviderModelSelect.vue";
import ToggleSwitch from "../shared/ToggleSwitch.vue";
import BaseCard from "../shared/BaseCard.vue";
import SettingsSubheading from "./SettingsSubheading.vue";
import SettingsPersistenceStatus from "./SettingsPersistenceStatus.vue";

const prefs = usePreferencesStore();
const providerStore = useProviderStore();
const attachmentConfigStatus = ref<"idle" | "saving" | "saved" | "error">("idle");
const lastSavedAttachmentLimit = ref(RUNTIME_LIMITS.attachments.defaultInlineTextLimit);
/** Discrete slider stops, clipped to the server-enforced bounds so the UI can
 * never offer a value the server would normalize away. */
const attachmentLimitSteps = computed(() =>
  [
    2_000, 4_000, 8_000, 12_000, 16_000, 24_000, 32_000, 48_000,
    64_000, 96_000, 128_000, 192_000, 256_000, 384_000, 500_000,
  ].filter((step) =>
    step >= RUNTIME_LIMITS.attachments.minInlineTextLimit &&
    step <= RUNTIME_LIMITS.attachments.maxInlineTextLimit));
const props = withDefaults(defineProps<{
  visibleSections?: string[]
}>(), {
  visibleSections: () => []
})

function showSection(id: string): boolean {
  return props.visibleSections.length === 0 || props.visibleSections.includes(id)
}

function showAnySection(ids: string[]): boolean {
  return ids.some(showSection)
}

const contextStrategyOptions: {
  value: ContextStrategy;
  label: string;
  description: string;
}[] = [
  {
    value: "sliding-window",
    label: "Sliding Window",
    description: "Keeps the most recent messages, trimming older ones",
  },
  {
    value: "truncate-middle",
    label: "Truncate Middle",
    description: "Keeps the first and last messages, trimming the middle",
  },
  {
    value: "compact",
    label: "Compact (Summarize)",
    description: "Summarizes older messages using the active model, then continues from the summary",
  },
  {
    value: "none",
    label: "No Trimming",
    description: "Sends all messages - may fail if context is exceeded",
  },
];

function onTitleSelection(selection: {
  providerId: string;
  model: string;
}): void {
  prefs.titleProviderId = selection.providerId;
  prefs.titleModel = selection.model;
}

function onCompactSelection(selection: {
  providerId: string;
  model: string;
}): void {
  prefs.compactProviderId = selection.providerId;
  prefs.compactModel = selection.model;
}

function clampInlineAttachmentTextLimit(value: number): number {
  const { minInlineTextLimit, maxInlineTextLimit, defaultInlineTextLimit } = RUNTIME_LIMITS.attachments;
  return Math.max(minInlineTextLimit, Math.min(maxInlineTextLimit, Math.floor(value || defaultInlineTextLimit)));
}

function formatAttachmentTextLimit(value: number): string {
  return `${Math.round(clampInlineAttachmentTextLimit(value) / 1_000)} KB`;
}

function attachmentLimitStepIndex(value: number): number {
  const steps = attachmentLimitSteps.value;
  return steps.reduce((closestIndex, step, index) =>
    Math.abs(step - value) < Math.abs(steps[closestIndex] - value)
      ? index
      : closestIndex, 0);
}

function attachmentLimitFromEvent(event: Event): number {
  const index = Number((event.target as HTMLInputElement).value);
  return attachmentLimitSteps.value[index] ?? RUNTIME_LIMITS.attachments.defaultInlineTextLimit;
}

function previewInlineAttachmentTextLimit(event: Event): void {
  prefs.inlineAttachmentTextLimit = attachmentLimitFromEvent(event);
}

async function updateInlineAttachmentTextLimit(event: Event): Promise<void> {
  const limit = attachmentLimitFromEvent(event);
  prefs.inlineAttachmentTextLimit = limit;
  attachmentConfigStatus.value = "saving";
  try {
    const result = await api.chat.updateAttachmentConfig(limit);
    prefs.inlineAttachmentTextLimit = result.inlineAttachmentTextLimit;
    lastSavedAttachmentLimit.value = result.inlineAttachmentTextLimit;
    attachmentConfigStatus.value = "saved";
  } catch {
    prefs.inlineAttachmentTextLimit = lastSavedAttachmentLimit.value;
    attachmentConfigStatus.value = "error";
  }
}

onMounted(async () => {
  try {
    const config = await api.chat.getAttachmentConfig();
    prefs.inlineAttachmentTextLimit = config.inlineAttachmentTextLimit;
    lastSavedAttachmentLimit.value = config.inlineAttachmentTextLimit;
  } catch {
    attachmentConfigStatus.value = "error";
  }
});

</script>

<template>
  <div class="space-y-4">
    <SettingsSubheading
      v-if="showAnySection(['generated-titles', 'quick-responses'])"
      label="Automation"
    />

    <!-- Generate Chat Titles -->
    <BaseCard
      v-if="showSection('generated-titles')"
      class="p-5 space-y-4"
    >
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div
            class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center"
          >
            <Icon
              icon="lucide:heading"
              class="w-5 h-5 text-theme-400"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              Generate Chat Titles <span class="ml-1 text-xs text-theme-500">• Pre-response action</span>
            </h3>
            <p class="text-xs text-theme-500 mt-0.5">
              Generate a descriptive title when the first message is sent, before the agent response
            </p>
          </div>
        </div>
        <ToggleSwitch
          v-model="prefs.generateTitle"
          label="Generate conversation titles"
        />
      </div>

      <div
        v-if="prefs.generateTitle"
        class="pt-1 border-t border-theme-700"
      >
        <label class="block text-xs text-theme-400 mb-1.5">Provider / Model</label>
        <ProviderModelSelect
          :provider-id="prefs.titleProviderId"
          :model-value="prefs.titleModel"
          :providers="providerStore.providers"
          include-default
          default-label="Use chat provider"
          placeholder="Use chat provider"
          @change="onTitleSelection"
        />
      </div>
    </BaseCard>

    <!-- Experimental Quick Responses -->
    <BaseCard
      v-if="showSection('quick-responses')"
      class="p-5 space-y-4"
    >
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
            <Icon
              icon="lucide:message-circle-more"
              class="w-5 h-5 text-theme-400"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              Quick Responses
            </h3>
            <p class="text-xs text-theme-500 mt-0.5">
              Generate up to three relevant follow-up suggestions after each assistant turn
            </p>
          </div>
        </div>
        <ToggleSwitch
          v-model="prefs.quickResponses"
          label="Enable quick responses"
        />
      </div>
      <p class="pt-3 border-t border-theme-700 text-[11px] leading-relaxed text-theme-500">
        Selecting a suggestion fills the chat input so you can review or edit it before sending. Uses the same provider and model as the chat.
      </p>
    </BaseCard>

    <SettingsSubheading
      v-if="showAnySection(['attachment-context', 'context-strategy'])"
      label="Context"
    />

    <!-- Attachment Context -->
    <BaseCard
      v-if="showSection('attachment-context')"
      class="p-5 space-y-4"
    >
      <div class="flex items-center gap-3">
        <div
          class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center"
        >
          <Icon
            icon="lucide:paperclip"
            class="w-5 h-5 text-theme-400"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Attachment Context
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            Switch large document attachments from inline context to retrieval
          </p>
        </div>
      </div>

      <div class="pt-1 border-t border-theme-700">
        <label class="block">
          <span class="flex items-center justify-between gap-3 text-xs text-theme-400 mb-2">
            <span>Inline text limit</span>
            <output class="font-medium tabular-nums text-theme-200">
              {{ formatAttachmentTextLimit(prefs.inlineAttachmentTextLimit) }}
            </output>
          </span>
          <div class="flex items-center gap-3">
            <span class="w-10 text-right text-[11px] tabular-nums text-theme-500">2 KB</span>
            <input
              :value="attachmentLimitStepIndex(prefs.inlineAttachmentTextLimit)"
              type="range"
              min="0"
              :max="attachmentLimitSteps.length - 1"
              step="1"
              aria-label="Inline attachment text limit"
              :aria-valuetext="formatAttachmentTextLimit(prefs.inlineAttachmentTextLimit)"
              :disabled="attachmentConfigStatus === 'saving'"
              class="min-w-0 flex-1 accent-accent-500 disabled:cursor-wait disabled:opacity-60"
              @input="previewInlineAttachmentTextLimit"
              @change="updateInlineAttachmentTextLimit"
            >
            <span class="w-12 text-[11px] tabular-nums text-theme-500">500 KB</span>
          </div>
        </label>
        <p class="mt-2 text-[11px] leading-relaxed text-theme-500">
          Larger extracted document text is indexed and retrieved as relevant excerpts instead of being fully resent each turn.
        </p>
      </div>
      <div
        v-if="attachmentConfigStatus === 'saving' || attachmentConfigStatus === 'error'"
        class="flex justify-end"
      >
        <SettingsPersistenceStatus
          mode="auto"
          :state="attachmentConfigStatus"
        />
      </div>
    </BaseCard>

    <!-- Context Strategy -->
    <BaseCard
      v-if="showSection('context-strategy')"
      class="p-5 space-y-3"
    >
      <div class="flex items-center gap-3">
        <div
          class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center"
        >
          <Icon
            icon="lucide:scissors"
            class="w-5 h-5 text-theme-400"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Context Strategy
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            How to manage conversation history when it exceeds the model's
            context window
          </p>
        </div>
      </div>
      <select
        :value="prefs.contextStrategy"
        class="w-full bg-theme-900 border border-theme-600 rounded-lg px-3 py-2 text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
        @change="prefs.contextStrategy = ($event.target as HTMLSelectElement).value as ContextStrategy"
      >
        <option
          v-for="opt in contextStrategyOptions"
          :key="opt.value"
          :value="opt.value"
        >
          {{ opt.label }} - {{ opt.description }}
        </option>
      </select>

      <div
        v-if="prefs.contextStrategy === 'compact'"
        class="pt-1 border-t border-theme-700"
      >
        <label class="block text-xs text-theme-400 mb-1.5">Summarization Provider / Model</label>
        <ProviderModelSelect
          :provider-id="prefs.compactProviderId"
          :model-value="prefs.compactModel"
          :providers="providerStore.providers"
          include-default
          default-label="Use chat provider"
          placeholder="Use chat provider"
          @change="onCompactSelection"
        />
      </div>
    </BaseCard>

    <SettingsSubheading
      v-if="showSection('debug-mode')"
      label="Developer"
    />

    <BaseCard
      v-if="showSection('debug-mode')"
      class="p-5 space-y-4"
    >
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center">
            <Icon
              icon="lucide:bug"
              class="w-5 h-5 text-amber-400"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              Debug Mode
            </h3>
            <p class="text-xs text-theme-500 mt-0.5">
              Capture complete model requests and expose the context inspector in chat
            </p>
          </div>
        </div>
        <ToggleSwitch
          v-model="prefs.debugMode"
          label="Enable debug mode"
        />
      </div>

      <p class="pt-3 border-t border-theme-700 text-[11px] leading-relaxed text-theme-500">
        Debug captures can contain system prompts, retrieved memories, message history, tool schemas and results,
        attachments, and provider-exposed reasoning. Treat exports as sensitive. Provider-private chain-of-thought
        and platform instructions that are never returned to Cynosure cannot be displayed.
      </p>
    </BaseCard>
  </div>
</template>
