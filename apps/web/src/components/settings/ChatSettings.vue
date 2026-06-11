<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Icon } from "@iconify/vue";
import {
  usePreferencesStore,
  type ContextStrategy,
} from "../../stores/preferences.store";
import { useProviderStore } from "../../stores/provider.store";
import { api } from "../../api/client";
import ProviderModelSelect from "../shared/ProviderModelSelect.vue";
import ToggleSwitch from "../shared/ToggleSwitch.vue";
import BaseCard from "../shared/BaseCard.vue";
import SettingsSubheading from "./SettingsSubheading.vue";

const prefs = usePreferencesStore();
const providerStore = useProviderStore();
const attachmentConfigStatus = ref<"idle" | "saving" | "saved" | "error">("idle");
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

function onAutoRouterSelection(selection: {
  providerId: string;
  model: string;
}): void {
  prefs.skillRouterProviderId = selection.providerId;
  prefs.skillRouterModel = selection.model;
}

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
  return Math.max(2_000, Math.min(500_000, Math.floor(value || 24_000)));
}

async function updateInlineAttachmentTextLimit(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const limit = clampInlineAttachmentTextLimit(Number(input.value));
  prefs.inlineAttachmentTextLimit = limit;
  attachmentConfigStatus.value = "saving";
  try {
    const result = await api.chat.updateAttachmentConfig(limit);
    prefs.inlineAttachmentTextLimit = result.inlineAttachmentTextLimit;
    attachmentConfigStatus.value = "saved";
  } catch {
    attachmentConfigStatus.value = "error";
  }
}

onMounted(async () => {
  try {
    const config = await api.chat.getAttachmentConfig();
    prefs.inlineAttachmentTextLimit = config.inlineAttachmentTextLimit;
  } catch {
    attachmentConfigStatus.value = "error";
  }
});

</script>

<template>
  <div class="space-y-4">
    <SettingsSubheading
      v-if="showAnySection(['skill-router', 'generated-titles'])"
      label="Automation"
    />

    <!-- Auto Router -->
    <BaseCard
      v-if="showSection('skill-router')"
      class="p-5 space-y-4"
    >
      <div class="flex items-center gap-3">
        <div
          class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center"
        >
          <Icon
            icon="lucide:book-open-check"
            class="w-5 h-5 text-theme-400"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Auto Router
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            Provider and model used to prepare task context for automatic tools, skills, and memories
          </p>
        </div>
      </div>

      <div class="pt-1 border-t border-theme-700">
        <label class="block text-xs text-theme-400 mb-1.5">Provider / Model</label>
        <ProviderModelSelect
          :provider-id="prefs.skillRouterProviderId"
          :model-value="prefs.skillRouterModel"
          :providers="providerStore.providers"
          include-default
          default-label="Use chat provider"
          placeholder="Use chat provider"
          @change="onAutoRouterSelection"
        />
        <p class="mt-2 text-[11px] leading-relaxed text-theme-500">
          Builds the task context used by auto routing before the main execution starts.
          Defaults to the current chat model when not set.
        </p>
      </div>
    </BaseCard>

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
              Generate Chat Titles <span class="ml-1 text-xs text-theme-500">• Post-turn action</span>
            </h3>
            <p class="text-xs text-theme-500 mt-0.5">
              Use AI to generate descriptive titles for chat conversations
            </p>
          </div>
        </div>
        <ToggleSwitch v-model="prefs.generateTitle" />
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
        <div class="flex items-end gap-3">
          <label class="flex-1">
            <span class="block text-xs text-theme-400 mb-1.5">Inline text limit</span>
            <input
              :value="prefs.inlineAttachmentTextLimit"
              type="number"
              min="2000"
              max="500000"
              step="1000"
              class="w-full bg-theme-900 border border-theme-600 rounded-lg px-3 py-2 text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
              @change="updateInlineAttachmentTextLimit"
            >
          </label>
          <span class="pb-2 text-xs text-theme-500">bytes</span>
        </div>
        <p class="mt-2 text-[11px] leading-relaxed text-theme-500">
          Larger extracted document text is indexed and retrieved as relevant excerpts instead of being fully resent each turn.
          <span
            v-if="attachmentConfigStatus === 'saving'"
            class="text-theme-400"
          > Saving...</span>
          <span
            v-else-if="attachmentConfigStatus === 'saved'"
            class="text-green-400"
          > Saved.</span>
          <span
            v-else-if="attachmentConfigStatus === 'error'"
            class="text-red-400"
          > Could not save.</span>
        </p>
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
  </div>
</template>
