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
import HoverMenu from "../../shared/HoverMenu.vue";
import ProviderModelSelect from "../../shared/ProviderModelSelect.vue";
import SplitButton from "../../shared/SplitButton.vue";
import ToolsButton from "./ToolsButton.vue";
import SubAgentsButton from "./SubAgentsButton.vue";
import MemorySpacesButton from "./MemorySpacesButton.vue";
import SystemPromptButton from "./SystemPromptButton.vue";
import ThinkingModeButton from "./ThinkingModeButton.vue";
import ModelSelectorModal from "../modals/ModelSelectorModal.vue";
import {
  modelPricingSummary,
} from "../../../utils/model-pricing";
import { shortModelLabel } from "../../../utils/model-label";

defineProps<{
  canSend: boolean;
  isRunning: boolean;
  editingQueue: boolean;
}>();

const emit = defineEmits<{
  attach: [];
  browseLibrary: [];
  send: [];
  steer: [];
  cancelEdit: [];
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
  return model || "Agent defaults";
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

function formatModalityName(modality: string): string {
  return modality
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function formatModalities(modalities?: string[]): string {
  if (!modalities?.length) {
    return chatStore.modelInfoStatus === "loading" ? "Loading…" : "Unavailable";
  }
  return modalities.map(formatModalityName).join(", ");
}

const formattedInputModalities = computed(() =>
  formatModalities(chatStore.modelModalities?.input),
);

const formattedOutputModalities = computed(() =>
  formatModalities(chatStore.modelModalities?.output),
);

const currentModelId = computed(() => chatStore.resolvedModelProvider?.model || "");

const pricingSummary = computed(() =>
  modelPricingSummary({
    id: currentModelId.value,
    pricing: chatStore.modelPricing,
    inputModalities: chatStore.modelModalities?.input,
    outputModalities: chatStore.modelModalities?.output,
  }),
);

const formattedTokenCosts = computed(() => pricingSummary.value.tokenRows);
const formattedMediaCosts = computed(() => pricingSummary.value.mediaRows);
const formattedExtraCosts = computed(() => pricingSummary.value.extraRows);
const formattedSkuCosts = computed(() => pricingSummary.value.skuRows);

const mobileModelLabel = computed(() => {
  const model = chatStore.resolvedModelProvider?.model;
  return model ? shortModelLabel(model) : "Default";
});

const hasPendingHITLForActiveConversation = computed(() => {
  const convId = chatStore.activeConversationId;
  if (!convId) return false;
  return agentStore.awaitingHITLConvIds.has(convId);
});

const showCancelButton = computed(() => chatStore.activeConversationHasRunningInstance);

function queueMessage(): void {
  emit("send");
}

function steerCurrentRun(): void {
  emit("steer");
}

async function onCancelClick(): Promise<void> {
  if (
    chatStore.activeConversationHasRunningInstance ||
    chatStore.activeConversationIsStreaming ||
    agentStore.activeConversationIsExecuting ||
    hasPendingHITLForActiveConversation.value
  ) {
    await chatStore.cancelStream();
    return;
  }
  chatStore.cancelPostActions();
}

function onModelProviderOverride(selection: {
  providerId: string;
  model: string;
}): void {
  chatStore.setSessionModel(selection.model || null, selection.providerId || null);

  if (!chatStore.activeAgentId) {
    if (selection.providerId) {
      providerStore.setLastUsed(selection.providerId);
    }
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
const remoteTranscriptionConfigured = computed(() =>
  !!prefs.remoteTranscriptionProviderId && !!prefs.remoteTranscriptionModel,
);
const voiceInputUnavailableReason = computed(() => {
  if (prefs.voiceTranscriptionMode === "remote" && !remoteTranscriptionConfigured.value) {
    return "Select a remote transcription provider and model in Settings → Voice.";
  }
  if (prefs.voiceTranscriptionMode === "local" && !hasDownloadedModel.value) {
    return "Voice input requires a Whisper model to be downloaded first. Open Settings → Voice to download a model.";
  }
  return "";
});
const voiceInputUnavailable = computed(() => !!voiceInputUnavailableReason.value);

async function toggleMic(): Promise<void> {
  if (voiceInputUnavailable.value) return;
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
      <SystemPromptButton />
      <ThinkingModeButton />
    </div>
  </Transition>

  <!-- Bottom toolbar -->
  <div class="flex items-center gap-1 px-2 pb-2 pt-0.5">
    <!-- Left: action buttons -->
    <HoverMenu
      placement="above"
      :max-width="210"
    >
      <template #trigger="{ open, toggle }">
        <button
          type="button"
          class="p-1.5 rounded-lg transition-colors shrink-0 focus:outline-none"
          :class="open ? 'text-accent-400 bg-theme-700/50' : 'text-theme-500 hover:text-theme-300'"
          title="Add attachment"
          aria-label="Add attachment"
          :aria-expanded="open"
          aria-haspopup="menu"
          @click="!open && toggle()"
        >
          <Icon
            icon="streamline-ultimate:attachment"
            class="h-4 w-4"
          />
        </button>
      </template>
      <template #content="{ close }">
        <div
          class="w-48"
          role="menu"
        >
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-theme-200 hover:bg-theme-800 hover:text-theme-100"
            role="menuitem"
            @click="close(); emit('attach')"
          >
            <Icon
              icon="lucide:upload"
              class="h-4 w-4 text-theme-400"
            />
            <span>Select File</span>
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-theme-200 hover:bg-theme-800 hover:text-theme-100"
            role="menuitem"
            @click="close(); emit('browseLibrary')"
          >
            <Icon
              icon="lucide:library"
              class="h-4 w-4 text-theme-400"
            />
            <span>Select From Library</span>
          </button>
        </div>
      </template>
    </HoverMenu>

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
      <SystemPromptButton />
      <ThinkingModeButton />
    </span>

    
    <div class="flex-1" />

    <!-- Mobile: provider/model selector as a button that opens a modal -->
    <button
      v-if="currentProviderId"
      class="chat-model-select-trigger lg:hidden max-w-44 flex items-center gap-1 px-2 py-1.5 text-theme-300 hover:text-theme-100 transition-colors shrink min-w-0"
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
            :model-types="['llm', 'image', 'video', 'transcription']"
            :provider-id="selectedProviderIdForSelector"
            :model-value="selectedModelForSelector"
            :providers="providerStore.providers"
            :include-default="!!selectedAgent"
            :default-label="agentDefaultLabel"
            default-tag="Default"
            placeholder="Select provider/model"
            max-height="max-h-96"
            dropdown-width="min-w-full"
            :drop-up="true"
            align="center"
            size="sm"
            :bare-trigger="true"
            @change="onModelProviderOverride"
          />
        </div>


        <template #content>
          <div class="space-y-2">
            <p class="max-w-64 break-words border-b border-theme-700 pb-2 text-xs font-semibold text-theme-100">
              {{ currentModelId || "Default model" }}
            </p>

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

            <div v-if="formattedTokenCosts.length">
              <p class="text-xs text-theme-300 whitespace-nowrap">
                Token pricing
              </p>
              <div class="mt-1 grid grid-cols-[auto,1fr] gap-x-2 gap-y-1 text-xs">
                <template
                  v-for="cost in formattedTokenCosts"
                  :key="cost.label"
                >
                  <span class="text-theme-500">{{ cost.label }}</span>
                  <span class="text-theme-200 tabular-nums">{{ cost.value }}</span>
                </template>
              </div>
            </div>

            <div v-if="formattedMediaCosts.length">
              <p class="text-xs text-theme-300 whitespace-nowrap">
                Media pricing
              </p>
              <div class="mt-1 grid grid-cols-[auto,1fr] gap-x-2 gap-y-1 text-xs">
                <template
                  v-for="cost in formattedMediaCosts"
                  :key="cost.label"
                >
                  <span class="text-theme-500">{{ cost.label }}</span>
                  <span class="text-theme-200 tabular-nums">{{ cost.value }}</span>
                </template>
              </div>
            </div>

            <div v-if="formattedSkuCosts.length">
              <p class="text-xs text-theme-300 whitespace-nowrap">
                Model SKU pricing
              </p>
              <div class="mt-1 grid grid-cols-[auto,1fr] gap-x-2 gap-y-1 text-xs">
                <template
                  v-for="sku in formattedSkuCosts"
                  :key="sku.label"
                >
                  <span class="text-theme-500">{{ sku.label }}</span>
                  <span class="text-theme-200 tabular-nums">{{ sku.value }}</span>
                </template>
              </div>
            </div>

            <div v-if="formattedExtraCosts.length">
              <p class="text-xs text-theme-300 whitespace-nowrap">
                Extra pricing
              </p>
              <div class="mt-1 grid grid-cols-[auto,1fr] gap-x-2 gap-y-1 text-xs">
                <template
                  v-for="cost in formattedExtraCosts"
                  :key="cost.label"
                >
                  <span class="text-theme-500">{{ cost.label }}</span>
                  <span class="text-theme-200 tabular-nums">{{ cost.value }}</span>
                </template>
              </div>
            </div>
          </div>
        </template>
      </HoverTooltip>
    </div>

    <!-- Mic / voice input button -->
    <HoverTooltip
      v-if="prefs.whisperEnabled && voiceInputUnavailable"
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
          <span>{{ voiceInputUnavailableReason }}</span>
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

    <button
      v-if="editingQueue"
      class="p-1.5 text-theme-400 hover:text-theme-100 rounded-lg transition-colors"
      title="Cancel edit"
      aria-label="Cancel queued message edit"
      @click="emit('cancelEdit')"
    >
      <Icon
        icon="lucide:x"
        class="h-4 w-4"
      />
    </button>

    <!-- Stop is intentionally separate from message delivery actions. -->
    <button
      v-if="showCancelButton"
      type="button"
      class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-500/60 bg-red-600/15 px-2.5 text-red-300 transition-colors hover:bg-red-600 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/70"
      title="Stop the current response"
      aria-label="Stop current response"
      @click="onCancelClick"
    >
      <Icon
        icon="lucide:square"
        class="h-3.5 w-3.5 fill-current"
      />
      <span class="hidden sm:inline text-xs font-medium">Stop</span>
    </button>

    <!-- While running, Queue is the safe default; Steer is the split-button alternative. -->
    <SplitButton
      v-if="isRunning && !editingQueue"
      class="h-8"
      :disabled="!canSend"
      title="Add this message to the queue"
      primary-label="Queue message for next turn"
      menu-label="Message delivery options"
      placement="above"
      @primary="queueMessage"
    >
      <Icon
        icon="lucide:list-plus"
        class="h-4 w-4"
      />
      <span class="hidden sm:inline text-xs font-medium">Queue</span>
      <template #menu="{ close }">
        <button
          type="button"
          class="flex w-64 items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-theme-800 focus:outline-none focus-visible:bg-theme-800"
          role="menuitem"
          @click="close(); steerCurrentRun()"
        >
          <Icon
            icon="lucide:corner-up-left"
            class="mt-0.5 h-4 w-4 shrink-0 text-accent-400"
          />
          <span>
            <span class="block text-xs font-medium text-theme-100">Steer current run</span>
            <span class="mt-0.5 block text-[11px] leading-4 text-theme-400">Interrupt the current response and redirect it with this message.</span>
          </span>
        </button>
      </template>
    </SplitButton>

    <button
      v-if="!isRunning || editingQueue"
      type="button"
      :disabled="!canSend"
      class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent-600 px-2.5 text-white transition-colors hover:bg-accent-500 disabled:cursor-not-allowed disabled:bg-theme-700 disabled:text-theme-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-300"
      :title="editingQueue ? 'Save queued message' : 'Send message'"
      :aria-label="editingQueue ? 'Save queued message' : 'Send message'"
      @click="queueMessage"
    >
      <Icon
        :icon="editingQueue ? 'lucide:check' : 'mdi:send'"
        class="h-4 w-4"
      />
      <span class="hidden sm:inline text-xs font-medium">{{ editingQueue ? 'Save' : 'Send' }}</span>
    </button>
  </div>

  <ModelSelectorModal v-model="showModelModal" />
</template>

<style scoped>
.chat-model-select-trigger,
.chat-model-select-trigger:hover,
.chat-model-select-trigger:focus,
.chat-model-select-trigger:focus-visible {
  background: transparent !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}

.chat-model-select-trigger:focus-visible {
  text-decoration: underline;
}

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
