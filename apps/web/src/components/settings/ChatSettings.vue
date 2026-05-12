<script setup lang="ts">
import { Icon } from "@iconify/vue";
import {
  usePreferencesStore,
  type ContextStrategy,
} from "../../stores/preferences.store";
import { useProviderStore } from "../../stores/provider.store";
import ProviderModelSelect from "../shared/ProviderModelSelect.vue";
import ToggleSwitch from "../shared/ToggleSwitch.vue";
import BaseCard from "../shared/BaseCard.vue";

const prefs = usePreferencesStore();
const providerStore = useProviderStore();

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

function onToolRouterSelection(selection: {
  providerId: string;
  model: string;
}): void {
  prefs.toolRouterProviderId = selection.providerId;
  prefs.toolRouterModel = selection.model;
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
</script>

<template>
  <div class="space-y-4">
    <!-- Tool Router -->
    <BaseCard class="p-5 space-y-4">
      <div class="flex items-center gap-3">
        <div
          class="w-9 h-9 rounded-lg bg-theme-900 flex items-center justify-center"
        >
          <Icon
            icon="lucide:route"
            class="w-5 h-5 text-theme-400"
          />
        </div>
        <div>
          <h3 class="text-sm font-medium text-theme-200">
            Tool Router
          </h3>
          <p class="text-xs text-theme-500 mt-0.5">
            Provider and model used to detect which tools a request needs
          </p>
        </div>
      </div>

      <div class="pt-1 border-t border-theme-700">
        <label class="block text-xs text-theme-400 mb-1.5">Provider / Model</label>
        <ProviderModelSelect
          :provider-id="prefs.toolRouterProviderId"
          :model-value="prefs.toolRouterModel"
          :providers="providerStore.providers"
          include-default
          default-label="Use chat provider"
          placeholder="Use chat provider"
          @change="onToolRouterSelection"
        />
      </div>
    </BaseCard>

    <!-- Generate Chat Titles -->
    <BaseCard class="p-5 space-y-4">
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
              Generate Chat Titles
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

    <!-- Context Strategy -->
    <BaseCard class="p-5 space-y-3">
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
        @change="
          prefs.contextStrategy = ($event.target as HTMLSelectElement)
            .value as ContextStrategy
        "
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
