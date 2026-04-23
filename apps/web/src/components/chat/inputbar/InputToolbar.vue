<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useChatStore } from '../../../stores/chat.store'
import { useAgentDefinitionsStore } from '../../../stores/agent-definitions.store'
import { usePreferencesStore } from '../../../stores/preferences.store'
import { useProviderStore } from '../../../stores/provider.store'
import { useWhisper } from '../../../composables/useWhisper'
import { Icon } from '@iconify/vue'
import ModelSelect from '../../shared/ModelSelect.vue'
import ToolsButton from './ToolsButton.vue'
import SubAgentsButton from './SubAgentsButton.vue'
import MemorySpacesButton from './MemorySpacesButton.vue'
import SystemPromptButton from './SystemPromptButton.vue'
import ThinkingModeButton from './ThinkingModeButton.vue'

const props = defineProps<{
  canSend: boolean
}>()

const emit = defineEmits<{
  attach: []
  send: []
  transcription: [text: string]
}>()

const chatStore = useChatStore()
const agentDefs = useAgentDefinitionsStore()
const prefs = usePreferencesStore()
const providerStore = useProviderStore()

const showMobileDrawer = ref(false)

// ─── Model selector ──────────────────
const selectedAgent = computed(() =>
  chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null
)

const currentProviderId = computed(() =>
  chatStore.sessionProviderOverride || selectedAgent.value?.providerId || providerStore.lastUsedProviderId
)

const sidebarModels = ref<string[]>([])
const loadingModels = ref(false)

const defaultModelLabel = computed(() => {
  const agentModel = selectedAgent.value?.model
  const provider = providerStore.providers.find(p => p.id === currentProviderId.value)
  const providerDefault = provider?.defaultModel
  const isProviderOverridden = chatStore.sessionProviderOverride &&
    chatStore.sessionProviderOverride !== selectedAgent.value?.providerId
  const effectiveDefault = isProviderOverridden ? providerDefault : (agentModel || providerDefault)
  return effectiveDefault ? `${effectiveDefault} (Default)` : 'Provider default'
})

async function fetchSidebarModels(): Promise<void> {
  const providerId = currentProviderId.value
  if (!providerId) return
  loadingModels.value = true
  try {
    sidebarModels.value = await providerStore.listModels(providerId, 'llm')
  } catch {
    sidebarModels.value = []
  } finally {
    loadingModels.value = false
  }
}

function onModelChange(value: string): void {
  chatStore.sessionModelOverride = value || null
}

watch(currentProviderId, (newId, oldId) => {
  if (newId !== oldId) sidebarModels.value = []
  if (newId) fetchSidebarModels()
}, { immediate: true })

// ─── Whisper / voice input ──────────────────
const { status: whisperStatus, progress: whisperProgress, startRecording, stopRecording } = useWhisper()

async function toggleMic(): Promise<void> {
  if (whisperStatus.value === 'recording') {
    const text = await stopRecording()
    if (text) emit('transcription', text)
  } else {
    await startRecording()
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
      class="sm:hidden flex items-center gap-1 px-2 py-1.5 border-b border-zinc-700/50"
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
    <button
      class="p-1.5 text-zinc-500 hover:text-zinc-300 rounded-lg transition-colors shrink-0 focus:outline-none"
      title="Attach file"
      :disabled="chatStore.isStreaming"
      aria-label="Attach file"
      @click="emit('attach')"
    >
      <Icon
        icon="streamline-ultimate:attachment"
        class="h-4 w-4"
      />
    </button>

    <!--Vertical separator-->
    <div class="hidden md:block w-px h-6 bg-zinc-700/80" />

    <!-- Mobile: single tune button to open drawer -->
    <button
      class="md:hidden p-1.5 rounded-lg transition-colors shrink-0 focus:outline-none"
      :class="showMobileDrawer ? 'text-blue-400 bg-zinc-700/50' : 'text-zinc-500 hover:text-zinc-300'"
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
    <span class="hidden md:contents">
      <ToolsButton />
      <SubAgentsButton />
      <MemorySpacesButton />
      <SystemPromptButton />
      <ThinkingModeButton />
    </span>

    <div class="flex-1" />

    <!-- Model selector (right-aligned) -->
    <div
      v-if="currentProviderId"
      class="flex items-center gap-1 shrink-0"
    >
      <div class="w-44">
        <ModelSelect
          :model-value="chatStore.sessionModelOverride || ''"
          :models="sidebarModels"
          include-default
          :default-label="defaultModelLabel"
          max-height="max-h-96"
          dropdown-width="min-w-full"
          :filterable="true"
          :drop-up="true"
          align="center"
          size="sm"
          @change="onModelChange"
        />
      </div>
      <button
        :disabled="loadingModels"
        class="p-1 text-zinc-500 hover:text-zinc-300 disabled:opacity-40 rounded-lg transition-colors shrink-0"
        title="Refresh models"
        @click="fetchSidebarModels"
      >
        <Icon
          :icon="loadingModels ? 'lucide:loader-2' : 'lucide:refresh-cw'"
          class="w-3 h-3"
          :class="{ 'animate-spin': loadingModels }"
        />
      </button>
    </div>

    <!-- Mic / voice input button -->
    <button
      v-if="prefs.whisperEnabled"
      class="relative p-1.5 rounded-lg transition-all duration-300 shrink-0 focus:outline-none"
      :class="whisperStatus === 'recording'
        ? 'bg-red-600 text-white hover:bg-red-500 animate-pulse shadow-[0_0_12px_rgba(239,68,68,0.5)]'
        : whisperStatus === 'transcribing'
          ? 'bg-amber-500/20 text-amber-400 shadow-[0_0_16px_rgba(245,158,11,0.4)] animate-whisper-glow cursor-wait'
          : whisperStatus === 'loading'
            ? 'text-amber-400 cursor-wait'
            : 'text-zinc-500 hover:text-zinc-300'"
      :title="whisperStatus === 'recording'
        ? 'Stop recording'
        : whisperStatus === 'loading'
          ? `Loading model (${whisperProgress}%)`
          : whisperStatus === 'transcribing'
            ? 'Transcribing…'
            : 'Voice input'"
      :disabled="whisperStatus === 'transcribing'"
      aria-label="Voice input"
      @click="toggleMic"
    >
      <Icon
        :icon="whisperStatus === 'recording'
          ? 'mdi:stop'
          : whisperStatus === 'transcribing'
            ? 'lucide:audio-waveform'
            : 'mdi:microphone'"
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

    <!-- Send / Cancel -->
    <button
      v-if="chatStore.isStreaming || chatStore.activePostActions.size > 0"
      class="p-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors shrink-0 focus:outline-none"
      title="Cancel"
      aria-label="Cancel"
      @click="chatStore.isStreaming ? chatStore.cancelStream() : chatStore.cancelPostActions()"
    >
      <Icon
        icon="mdi:stop-circle"
        class="h-4 w-4"
      />
    </button>
    <button
      v-else
      :disabled="!canSend"
      class="p-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg transition-colors shrink-0 focus:outline-none"
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
</template>

<style scoped>
@keyframes whisper-glow {
  0%, 100% { box-shadow: 0 0 8px rgba(245, 158, 11, 0.3); }
  50% { box-shadow: 0 0 20px rgba(245, 158, 11, 0.6); }
}
.animate-whisper-glow {
  animation: whisper-glow 1.5s ease-in-out infinite;
}
@keyframes dot-bounce {
  0%, 80%, 100% { opacity: 0; }
  40% { opacity: 1; }
}
.animate-dot1 { animation: dot-bounce 1.4s infinite 0s; }
.animate-dot2 { animation: dot-bounce 1.4s infinite 0.2s; }
.animate-dot3 { animation: dot-bounce 1.4s infinite 0.4s; }
</style>
