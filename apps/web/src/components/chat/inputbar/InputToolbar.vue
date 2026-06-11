<script setup lang="ts">
import { ref, computed } from "vue";
import { useChatStore } from "../../../stores/chat.store";
import { useAgentStore } from "../../../stores/agent-runtime.store";
import { usePreferencesStore } from "../../../stores/preferences.store";
import { useAgentDefinitionsStore } from "../../../stores/agent-definitions.store";
import { useProviderStore } from "../../../stores/provider.store";
import { useWhisper } from "../../../composables/useWhisper";
import { Icon } from "@iconify/vue";
import HoverTooltip from "../../shared/HoverTooltip.vue";
import ProviderModelSelect from "../../shared/ProviderModelSelect.vue";
import ToolsButton from "./ToolsButton.vue";
import SubAgentsButton from "./SubAgentsButton.vue";
import MemorySpacesButton from "./MemorySpacesButton.vue";
import SystemPromptButton from "./SystemPromptButton.vue";
import ThinkingModeButton from "./ThinkingModeButton.vue";
import SkillsButton from "./SkillsButton.vue";
import ModelSelectorModal from "../modals/ModelSelectorModal.vue";

defineProps<{
  canSend: boolean;
}>();

const emit = defineEmits<{
  attach: [];
  send: [];
  transcription: [text: string];
}>();

const chatStore = useChatStore();
const agentStore = useAgentStore();
const prefs = usePreferencesStore();
const agentDefs = useAgentDefinitionsStore();
const providerStore = useProviderStore();

const showMobileDrawer = ref(false);
const showModelModal = ref(false);

const selectedAgent = computed(() =>
  chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null,
);

const agentDefaultLabel = computed(() => {
  const model = selectedAgent.value?.model;
  return model ? `Use agent defaults (${model})` : "Use agent defaults";
});

const currentProviderId = computed(
  () =>
    chatStore.sessionProviderOverride ||
    selectedAgent.value?.providerId ||
    providerStore.lastUsedProviderId,
);

const selectedProviderIdForSelector = computed(() => {
  if (
    selectedAgent.value &&
    !chatStore.sessionProviderOverride &&
    !chatStore.sessionModelOverride
  ) {
    return "";
  }
  return currentProviderId.value;
});

const selectedModelForSelector = computed(() =>
  selectedAgent.value &&
  !chatStore.sessionProviderOverride &&
  !chatStore.sessionModelOverride
    ? ""
    : chatStore.sessionModelOverride || "",
);

const currentProvider = computed(() =>
  providerStore.providers.find((p) => p.id === currentProviderId.value),
);

const formattedModelCost = computed(() => {
  const cost = chatStore.modelCost;
  if (!cost) return null;
  const fmt = (n: number) => {
    if (n < 0.01) return `$${n.toFixed(4)}`;
    if (n < 1) return `$${n.toFixed(2)}`;
    return `$${n.toFixed(2)}`;
  };
  return `${fmt(cost.input)} / ${fmt(cost.output)}`;
});

function formatModalityName(modality: string): string {
  return modality
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function formatModalities(modalities?: string[]): string {
  if (!modalities?.length) return "Unknown";
  return modalities.map(formatModalityName).join(", ");
}

const formattedInputModalities = computed(() =>
  formatModalities(chatStore.modelModalities?.input),
);

const formattedOutputModalities = computed(() =>
  formatModalities(chatStore.modelModalities?.output),
);

const mobileModelLabel = computed(() => {
  const override = chatStore.sessionModelOverride;
  if (override) {
    return override;
  }
  const agentModel = selectedAgent.value?.model;
  const providerDefault = currentProvider.value?.defaultModel;
  const isProviderOverridden =
    chatStore.sessionProviderOverride &&
    chatStore.sessionProviderOverride !== selectedAgent.value?.providerId;
  const effectiveDefault = isProviderOverridden
    ? providerDefault
    : agentModel || providerDefault;
  return effectiveDefault || "Default";
});

const hasPendingHITLForActiveConversation = computed(() => {
  const convId = chatStore.activeConversationId;
  if (!convId) return false;
  return agentStore.awaitingHITLConvIds.has(convId);
});

const showCancelButton = computed(() => chatStore.isConversationLocked);

function onCancelClick(): void {
  if (
    chatStore.isStreaming ||
    agentStore.isExecuting ||
    hasPendingHITLForActiveConversation.value
  ) {
    chatStore.cancelStream();
    return;
  }
  chatStore.cancelPostActions();
}

function onModelProviderOverride(selection: {
  providerId: string;
  model: string;
}): void {
  chatStore.sessionModelOverride = selection.model || null;

  if (chatStore.activeAgentId) {
    chatStore.sessionProviderOverride =
      selection.providerId &&
      selection.providerId !== selectedAgent.value?.providerId
        ? selection.providerId
        : null;
  } else {
    chatStore.sessionProviderOverride = selection.providerId;
    if (selection.providerId) {
      providerStore.setLastUsed(selection.providerId);
    }
  }

  if (chatStore.activeAgentId) {
    chatStore.markOverridesModified();
  }
}

// ─── Whisper / voice input ──────────────────
const {
  status: whisperStatus,
  progress: whisperProgress,
  startRecording,
  stopRecording,
  downloadedModels,
} = useWhisper();

const hasDownloadedModel = computed(() => downloadedModels.value.length > 0);

async function toggleMic(): Promise<void> {
  if (!hasDownloadedModel.value) return;
  if (whisperStatus.value === "recording") {
    const text = await stopRecording();
    if (text) emit("transcription", text);
  } else {
    await startRecording(prefs.whisperMicDeviceId || undefined);
  }
}
</script>

<template>
  <!-- Mobile settings drawer -->
  <Transition
    enter-active-class="transition-all duration-200 ease-out"
    leave-active-class="transition-all duration-150 ease-in"
    enter-from-class="opacity-0 translate-y-2"
    enter-to-class="opacity-100 translate-y-0"
    leave-from-class="opacity-100 translate-y-0"
    leave-to-class="opacity-0 translate-y-2"
  >
    <div
      v-if="showMobileDrawer"
      class="lg:hidden flex items-center gap-1 px-2 py-1.5 border-b border-theme-700/50"
    >
      <ToolsButton />
      <SubAgentsButton />
      <MemorySpacesButton />
      <SkillsButton />
      <SystemPromptButton />
      <ThinkingModeButton />
    </div>
  </Transition>

  <!-- Bottom toolbar -->
  <div class="flex items-center gap-1 px-2 pb-2 pt-0.5">
    <!-- Left: action buttons -->
    <button
      class="p-1.5 text-theme-500 hover:text-theme-300 rounded-lg transition-colors shrink-0 focus:outline-none"
      title="Attach file"
      :disabled="chatStore.isConversationLocked"
      aria-label="Attach file"
      @click="emit('attach')"
    >
      <Icon
        icon="streamline-ultimate:attachment"
        class="h-4 w-4"
      />
    </button>

    <!--Vertical separator-->
    <div class="hidden md:block w-px h-6 bg-theme-700/80" />

    <!-- Mobile: single tune button to open drawer -->
    <button
      class="lg:hidden p-1.5 rounded-lg transition-colors shrink-0 focus:outline-none"
      :class="
        showMobileDrawer
          ? 'text-accent-400 bg-theme-700/50'
          : 'text-theme-500 hover:text-theme-300'
      "
      title="Chat settings"
      aria-label="Chat settings"
      @click="showMobileDrawer = !showMobileDrawer"
    >
      <Icon
        icon="material-symbols:tune"
        class="h-4 w-4"
      />
    </button>

    <!-- Desktop: inline buttons -->
    <span class="hidden lg:contents">
      <ToolsButton />
      <SubAgentsButton />
      <MemorySpacesButton />
      <SkillsButton />
      <SystemPromptButton />
      <ThinkingModeButton />
    </span>

    
    <div class="flex-1" />

    <!-- Mobile: provider/model selector as a button that opens a modal -->
    <button
      v-if="currentProviderId"
      class="lg:hidden max-w-44 flex items-center gap-1 px-2 py-1.5 rounded-lg text-theme-300 hover:text-theme-100 transition-colors shrink min-w-0"
      aria-label="Select provider and model"
      @click="showModelModal = true"
    >
      <span class="truncate text-xs">{{ mobileModelLabel }}</span>

      <Icon
        icon="lucide:chevron-down"
        class="h-3.5 w-3.5 text-theme-500 shrink-0"
      />
    </button>

    <!-- Provider / Model selector (desktop only, right-aligned) -->
    <div
      v-if="currentProviderId"
      class="hidden lg:flex items-center gap-1 shrink-0"
    >
      <!-- Model cost indicator -->
      <HoverTooltip
        placement="above"
        :max-width="280"
      >
        <div class="w-56">
          <ProviderModelSelect
            :provider-id="selectedProviderIdForSelector"
            :model-value="selectedModelForSelector"
            :providers="providerStore.providers"
            :include-default="!!selectedAgent"
            :default-label="agentDefaultLabel"
            placeholder="Select provider/model"
            max-height="max-h-96"
            dropdown-width="min-w-full"
            :drop-up="true"
            align="center"
            size="sm"
            @change="onModelProviderOverride"
          />
        </div>


        <template #content>
          <div class="space-y-2">
            <div>
              <p class="text-xs font-medium text-theme-300">
                Capabilities
              </p>
              <div class="mt-1 grid grid-cols-[auto,1fr] gap-x-2 gap-y-1 text-xs">
                <span class="text-theme-500">Input</span>
                <span class="text-theme-200">{{ formattedInputModalities }}</span>
                <span class="text-theme-500">Output</span>
                <span class="text-theme-200">{{ formattedOutputModalities }}</span>
              </div>
            </div>

            <div v-if="formattedModelCost">
              <p class="text-xs text-theme-300 whitespace-nowrap">
                Input / Output cost per 1M tokens
              </p>
              <span class="tabular-nums">{{ formattedModelCost }}</span>
            </div>
          </div>
        </template>
      </HoverTooltip>
    </div>

    <!-- Mic / voice input button -->
    <HoverTooltip
      v-if="prefs.whisperEnabled && !hasDownloadedModel"
      placement="above"
    >
      <button
        class="p-1.5 text-theme-600 rounded-lg shrink-0 cursor-not-allowed focus:outline-none"
        title="Voice input"
        disabled
        aria-label="Voice input (requires model download)"
      >
        <Icon
          icon="mdi:microphone-off"
          class="h-4 w-4"
        />
      </button>
      <template #content>
        <div class="flex items-start gap-2">
          <Icon
            icon="mdi:information"
            class="h-4 w-4 text-amber-400 mt-0.5 shrink-0"
          />
          <span>Voice input requires a Whisper model to be downloaded first. Open
            Settings → Voice to download a model.</span>
        </div>
      </template>
    </HoverTooltip>

    <div
      v-else-if="prefs.whisperEnabled"
      class="relative flex items-center shrink-0"
    >
      <button
        class="relative p-1.5 rounded-lg transition-all duration-300 shrink-0 focus:outline-none"
        :class="
          whisperStatus === 'recording'
            ? 'bg-red-600 text-white hover:bg-red-500 animate-pulse shadow-[0_0_12px_rgba(239,68,68,0.5)]'
            : whisperStatus === 'transcribing'
              ? 'bg-amber-500/20 text-amber-400 shadow-[0_0_16px_rgba(245,158,11,0.4)] animate-whisper-glow cursor-wait'
              : whisperStatus === 'loading'
                ? 'text-amber-400 cursor-wait'
                : 'text-theme-500 hover:text-theme-300'
        "
        :title="
          whisperStatus === 'recording'
            ? 'Stop recording'
            : whisperStatus === 'loading'
              ? `Loading model (${whisperProgress}%)`
              : whisperStatus === 'transcribing'
                ? 'Transcribing…'
                : 'Voice input'
        "
        :disabled="whisperStatus === 'transcribing'"
        aria-label="Voice input"
        @click="toggleMic"
      >
        <Icon
          :icon="
            whisperStatus === 'recording'
              ? 'mdi:stop'
              : whisperStatus === 'transcribing'
                ? 'lucide:audio-waveform'
                : 'mdi:microphone'
          "
          class="h-4 w-4"
          :class="whisperStatus === 'transcribing' ? 'animate-pulse' : ''"
        />
        <!-- Loading progress ring -->
        <svg
          v-if="whisperStatus === 'loading'"
          class="absolute inset-0 w-full h-full -rotate-90"
          viewBox="0 0 36 36"
        >
          <circle
            cx="18"
            cy="18"
            r="15"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-dasharray="94.2"
            :stroke-dashoffset="94.2 - (94.2 * whisperProgress) / 100"
            class="text-amber-400 transition-all duration-300"
          />
        </svg>
        <!-- Transcribing badge with animated dots -->
        <span
          v-if="whisperStatus === 'transcribing'"
          class="absolute -top-1.5 -right-1.5 flex h-4 min-w-14 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[9px] font-bold text-black tracking-wide"
        >
          <span class="inline-flex">
            <span class="animate-dot1">.</span>
            <span class="animate-dot2">.</span>
            <span class="animate-dot3">.</span>
          </span>
        </span>
      </button>
    </div>

    <!-- Send / Cancel -->
    <button
      v-if="showCancelButton"
      class="p-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors shrink-0 focus:outline-none"
      title="Cancel"
      aria-label="Cancel"
      @click="onCancelClick"
    >
      <Icon
        icon="mdi:stop-circle"
        class="h-4 w-4"
      />
    </button>
    <button
      v-else
      :disabled="!canSend"
      class="p-1.5 bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white rounded-lg transition-colors shrink-0 focus:outline-none"
      title="Send"
      aria-label="Send message"
      @click="emit('send')"
    >
      <Icon
        icon="mdi:send"
        class="h-4 w-4"
      />
    </button>
  </div>

  <ModelSelectorModal v-model="showModelModal" />
</template>

<style scoped>
@keyframes whisper-glow {
  0%,
  100% {
    box-shadow: 0 0 8px rgba(245, 158, 11, 0.3);
  }
  50% {
    box-shadow: 0 0 20px rgba(245, 158, 11, 0.6);
  }
}
.animate-whisper-glow {
  animation: whisper-glow 1.5s ease-in-out infinite;
}
@keyframes dot-bounce {
  0%,
  80%,
  100% {
    opacity: 0;
  }
  40% {
    opacity: 1;
  }
}
.animate-dot1 {
  animation: dot-bounce 1.4s infinite 0s;
}
.animate-dot2 {
  animation: dot-bounce 1.4s infinite 0.2s;
}
.animate-dot3 {
  animation: dot-bounce 1.4s infinite 0.4s;
}
</style>
