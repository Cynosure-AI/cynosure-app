<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Icon } from "@iconify/vue";
import type { ContextStrategy } from "../../stores/preferences.store";
import { useProviderStore } from "../../stores/provider.store";
import { api } from "../../api/client";
import type { ChatRunSettings } from "@shared/types";
import ProviderModelSelect from "../shared/ProviderModelSelect.vue";
import ToggleSwitch from "../shared/ToggleSwitch.vue";
import BaseCard from "../shared/BaseCard.vue";
import SettingsSubheading from "./SettingsSubheading.vue";
import SettingsPersistenceStatus from "./SettingsPersistenceStatus.vue";

const providerStore = useProviderStore();
/** Server-wide settings, so channels and scheduled runs follow the same choices. */
const runSettings = ref<ChatRunSettings>({
  contextStrategy: "compact",
  generateTitle: true,
  generateQuickResponses: false,
  titleProviderId: "",
  titleModel: "",
  compactProviderId: "",
  compactModel: "",
});
const runSettingsStatus = ref<"idle" | "saving" | "saved" | "error">("idle");
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
    value: "compact",
    label: "Compact (Summarize)",
    description: "Summarizes older messages using the active model, then continues from the summary",
  },
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
    value: "none",
    label: "No Trimming",
    description: "Sends all messages - may fail if context is exceeded",
  },
];

function onTitleSelection(selection: {
  providerId: string;
  model: string;
}): void {
  void updateRunSettings({ titleProviderId: selection.providerId, titleModel: selection.model });
}

function onCompactSelection(selection: {
  providerId: string;
  model: string;
}): void {
  void updateRunSettings({ compactProviderId: selection.providerId, compactModel: selection.model });
}

async function updateRunSettings(changes: Partial<ChatRunSettings>): Promise<void> {
  const previous = runSettings.value;
  runSettings.value = { ...previous, ...changes };
  runSettingsStatus.value = "saving";
  try {
    runSettings.value = (await api.chat.updateRunSettings(changes)).settings;
    runSettingsStatus.value = "saved";
  } catch {
    runSettings.value = previous;
    runSettingsStatus.value = "error";
  }
}

onMounted(async () => {
  try {
    runSettings.value = (await api.chat.getRunSettings()).settings;
  } catch {
    runSettingsStatus.value = "error";
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
              class="w-5 h-5 text-ink-secondary"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              Generate Chat Titles <span class="ml-1 text-xs text-ink-muted">• Pre-response action</span>
            </h3>
            <p class="text-xs text-ink-muted mt-0.5">
              Generate a descriptive title when the first message is sent, before the agent response
            </p>
          </div>
        </div>
        <ToggleSwitch
          :model-value="runSettings.generateTitle"
          label="Generate conversation titles"
          @update:model-value="updateRunSettings({ generateTitle: $event })"
        />
      </div>

      <div
        v-if="runSettings.generateTitle"
        class="pt-1 border-t border-theme-700"
      >
        <label class="block text-xs text-ink-secondary mb-1.5">Provider / Model</label>
        <ProviderModelSelect
          :provider-id="runSettings.titleProviderId"
          :model-value="runSettings.titleModel"
          :providers="providerStore.providers"
          include-default
          default-label="Use chat provider"
          placeholder="Use chat provider"
          @change="onTitleSelection"
        />
      </div>
      <div
        v-if="runSettingsStatus === 'saving' || runSettingsStatus === 'error'"
        class="flex justify-end"
      >
        <SettingsPersistenceStatus
          mode="auto"
          :state="runSettingsStatus"
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
              class="w-5 h-5 text-ink-secondary"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              Quick Responses <span class="ml-1 text-xs text-ink-muted">• Post-response action</span>
            </h3>
            <p class="text-xs text-ink-muted mt-0.5">
              Generate up to three relevant follow-up suggestions after each assistant turn
            </p>
          </div>
        </div>
        <ToggleSwitch
          :model-value="runSettings.generateQuickResponses"
          label="Enable quick responses"
          @update:model-value="updateRunSettings({ generateQuickResponses: $event })"
        />
      </div>
      <p class="pt-3 border-t border-theme-700 text-[11px] leading-relaxed text-ink-muted">
        Selecting a suggestion fills the chat input so you can review or edit it before sending. Uses the same provider and model as the chat.
      </p>
    </BaseCard>

    <SettingsSubheading
      v-if="showSection('context-strategy')"
      label="Context"
    />

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
            class="w-5 h-5 text-ink-secondary"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Context Strategy
          </h3>
          <p class="text-xs text-ink-muted mt-0.5">
            How to manage conversation history when it exceeds the model's
            context window
          </p>
        </div>
      </div>
      <select
        :value="runSettings.contextStrategy"
        class="w-full bg-theme-900 border border-theme-600 rounded-lg px-3 py-2 text-sm text-theme-200 focus:outline-none focus:ring-1 focus:ring-accent-500"
        @change="updateRunSettings({ contextStrategy: ($event.target as HTMLSelectElement).value as ContextStrategy })"
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
        v-if="runSettings.contextStrategy === 'compact'"
        class="pt-1 border-t border-theme-700"
      >
        <label class="block text-xs text-ink-secondary mb-1.5">Summarization Provider / Model</label>
        <ProviderModelSelect
          :provider-id="runSettings.compactProviderId"
          :model-value="runSettings.compactModel"
          :providers="providerStore.providers"
          include-default
          default-label="Use chat provider"
          placeholder="Use chat provider"
          @change="onCompactSelection"
        />
      </div>
      <div
        v-if="runSettingsStatus === 'saving' || runSettingsStatus === 'error'"
        class="flex justify-end"
      >
        <SettingsPersistenceStatus
          mode="auto"
          :state="runSettingsStatus"
        />
      </div>
    </BaseCard>
  </div>
</template>
