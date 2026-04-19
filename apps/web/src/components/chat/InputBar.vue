<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useChatStore } from '../../stores/chat.store'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { usePreferencesStore } from '../../stores/preferences.store'
import { useProviderStore } from '../../stores/provider.store'
import { useWhisper } from '../../composables/useWhisper'
import { Icon } from '@iconify/vue'
import ModalDialog from '../shared/ModalDialog.vue'
import CustomSelect, { type SelectOptionGroup } from '../shared/CustomSelect.vue'
import ToolsButton from './inputbar/ToolsButton.vue'
import SubAgentsButton from './inputbar/SubAgentsButton.vue'
import MemorySpacesButton from './inputbar/MemorySpacesButton.vue'
import SystemPromptButton from './inputbar/SystemPromptButton.vue'
import ThinkingModeButton from './inputbar/ThinkingModeButton.vue'
import ContextRing from './inputbar/ContextRing.vue'

const chatStore = useChatStore()
const agentStore = useAgentStore()
const agentDefs = useAgentDefinitionsStore()
const prefs = usePreferencesStore()
const providerStore = useProviderStore()
const router = useRouter()

// Override detection
const hasOverrides = computed(() => chatStore.hasAgentOverrides)

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
  return effectiveDefault ? `Default (${effectiveDefault})` : 'Provider default'
})

const modelDropdownGroups = computed((): SelectOptionGroup[] => [{
  options: [
    { value: '', label: defaultModelLabel.value },
    ...sidebarModels.value.map((m) => ({ value: m, label: m })),
  ],
}])

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

const { status: whisperStatus, progress: whisperProgress, startRecording, stopRecording } = useWhisper()

const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const showMobileDrawer = ref(false)
const attachedImages = ref<{ url: string; name: string }[]>([])
const attachedFiles = ref<{ name: string; content: string }[]>([])
const attachedAudio = ref<{ url: string; name: string }[]>([])

async function send(): Promise<void> {
  const content = inputText.value.trim()
  if (!content || chatStore.isStreaming) return
  const images = attachedImages.value.map((i) => i.url)
  const files = attachedFiles.value.map((f) => ({ name: f.name, content: f.content }))
  const audio = attachedAudio.value.map((a) => a.url)
  inputText.value = ''
  attachedImages.value = []
  attachedFiles.value = []
  attachedAudio.value = []
  resetHeight()
  await chatStore.sendMessage(
    content,
    images.length ? images : undefined,
    files.length ? files : undefined,
    audio.length ? audio : undefined
  )
}

function openFilePicker(): void {
  fileInputRef.value?.click()
}

function handleFileSelect(e: Event): void {
  const input = e.target as HTMLInputElement
  const files = input.files
  if (!files) return
  processFiles(Array.from(files))
  input.value = ''
}

/** File extensions that should be read as binary (base64) for server-side parsing */
const PARSEABLE_DOC_EXTENSIONS = new Set([
  '.docx', '.pptx', '.xlsx',
  '.odt', '.odp', '.ods',
  '.pdf', '.rtf'
])

function isParseableDoc(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  return PARSEABLE_DOC_EXTENSIONS.has(ext)
}

function processFiles(files: File[]): void {
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) continue // 20MB limit

    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = () => {
        attachedImages.value.push({
          url: reader.result as string,
          name: file.name
        })
      }
      reader.readAsDataURL(file)
    } else if (file.type.startsWith('audio/')) {
      const reader = new FileReader()
      reader.onload = () => {
        attachedAudio.value.push({
          url: reader.result as string,
          name: file.name
        })
      }
      reader.readAsDataURL(file)
    } else if (isParseableDoc(file.name)) {
      // Read document files as base64 for server-side parsing (officeparser)
      const reader = new FileReader()
      reader.onload = () => {
        attachedFiles.value.push({
          name: file.name,
          content: reader.result as string
        })
      }
      reader.readAsDataURL(file)
    } else {
      const reader = new FileReader()
      reader.onload = () => {
        attachedFiles.value.push({
          name: file.name,
          content: reader.result as string
        })
      }
      reader.readAsText(file)
    }
  }
}

function removeImage(idx: number): void {
  attachedImages.value.splice(idx, 1)
}

function removeFile(idx: number): void {
  attachedFiles.value.splice(idx, 1)
}

function removeAudio(idx: number): void {
  attachedAudio.value.splice(idx, 1)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (!chatStore.isStreaming) send()
  }
}

function onPaste(e: ClipboardEvent): void {
  const files = e.clipboardData?.files
  if (files && files.length > 0) {
    processFiles(Array.from(files))
  }
}

function autoResize(): void {
  const el = textareaRef.value
  if (el) {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }
}

function resetHeight(): void {
  const el = textareaRef.value
  if (el) {
    el.style.height = 'auto'
  }
}

watch(inputText, () => {
  nextTick(autoResize)
})

async function toggleMic(): Promise<void> {
  if (whisperStatus.value === 'recording') {
    const text = await stopRecording()
    if (text) {
      inputText.value = inputText.value ? `${inputText.value} ${text}` : text
    }
  } else {
    await startRecording()
  }
}

// --- Save as New Agent ---
const showSaveAgentModal = ref(false)
const newAgentName = ref('')
const newAgentDescription = ref('')
const savingAgent = ref(false)

/** Check if there is a meaningful config to save (tools, sub-agents, memory, or system prompt). */
const canSaveAsAgent = computed(() => {
  return (
    agentStore.selectedToolNames.length > 0 ||
    chatStore.freeChatSubAgentIds.length > 0 ||
    chatStore.freeChatMemorySpaceIds.length > 0 ||
    chatStore.sessionSystemPrompt.trim().length > 0
  )
})

function openSaveAgentModal() {
  // Pre-fill name from current agent if overriding
  const currentAgent = chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null
  newAgentName.value = currentAgent ? `${currentAgent.name} (copy)` : ''
  newAgentDescription.value = currentAgent?.description || ''
  showSaveAgentModal.value = true
}

async function saveAsNewAgent() {
  if (!newAgentName.value.trim() || savingAgent.value) return
  savingAgent.value = true
  try {
    // Resolve provider/model
    const lastUsedProvider = providerStore.lastUsedProvider
    const currentAgent = chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null
    const providerId = chatStore.sessionProviderOverride || currentAgent?.providerId || lastUsedProvider?.id || ''
    const model = chatStore.sessionModelOverride || currentAgent?.model || lastUsedProvider?.defaultModel || ''

    const subAgents = chatStore.freeChatSubAgentIds.map(id => {
      const def = agentDefs.get(id)
      const codename = def
        ? def.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_agent'
        : id
      return { agentId: id, codename, role: def?.description || '' }
    })

    const agent = await agentDefs.create({
      name: newAgentName.value.trim(),
      description: newAgentDescription.value.trim(),
      providerId,
      model,
      systemPrompt: chatStore.sessionSystemPrompt,
      tools: [...agentStore.selectedToolNames],
      subAgents,
      memorySpaces: [...chatStore.freeChatMemorySpaceIds],
    })
    showSaveAgentModal.value = false
    newAgentName.value = ''
    newAgentDescription.value = ''
    // Navigate to the new agent
    router.push(`/agents/${agent.id}`)
  } catch { /* error */ }
  savingAgent.value = false
}

defineExpose({ processFiles })
</script>

<template>
  <div class="border-t border-zinc-800 bg-zinc-900 px-4 py-3 flex items-end gap-3">
    <div class="max-w-5xl mx-auto flex-1 min-w-0">
      <!-- Attached images preview -->
      <div
        v-if="attachedImages.length"
        class="flex gap-2 mb-2 flex-wrap"
      >
        <div
          v-for="(img, idx) in attachedImages"
          :key="idx"
          class="relative group"
        >
          <img
            :src="img.url"
            :alt="img.name"
            class="h-16 w-16 rounded-lg object-cover border border-zinc-700"
          >
          <button
            class="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-red-600 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label="Remove image"
            @click="removeImage(idx)"
          >
            <Icon
              icon="mdi:close"
              class="h-3 w-3"
            />
          </button>
        </div>
      </div>

      <!-- Attached files preview -->
      <div
        v-if="attachedFiles.length"
        class="flex gap-2 mb-2 flex-wrap"
      >
        <div
          v-for="(file, idx) in attachedFiles"
          :key="idx"
          class="relative group flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5"
        >
          <Icon
            icon="mdi:file-document-outline"
            class="h-4 w-4 text-zinc-400 shrink-0"
          />
          <span class="text-xs text-zinc-300 max-w-32 truncate">{{ file.name }}</span>
          <button
            class="ml-1 h-4 w-4 rounded-full bg-red-600 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            aria-label="Remove file"
            @click="removeFile(idx)"
          >
            <Icon
              icon="mdi:close"
              class="h-2.5 w-2.5"
            />
          </button>
        </div>
      </div>

      <!-- Attached audio preview -->
      <div
        v-if="attachedAudio.length"
        class="flex gap-2 mb-2 flex-wrap"
      >
        <div
          v-for="(audio, idx) in attachedAudio"
          :key="idx"
          class="relative group flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5"
        >
          <Icon
            icon="mdi:music-note"
            class="h-4 w-4 text-zinc-400 shrink-0"
          />
          <span class="text-xs text-zinc-300 max-w-32 truncate">{{ audio.name }}</span>
          <button
            class="ml-1 h-4 w-4 rounded-full bg-red-600 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            aria-label="Remove audio"
            @click="removeAudio(idx)"
          >
            <Icon
              icon="mdi:close"
              class="h-2.5 w-2.5"
            />
          </button>
        </div>
      </div>

      <!-- Agent override bar: apply / reset -->
      <div
        v-if="hasOverrides"
        class="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5"
      >
        <Icon
          icon="lucide:info"
          class="w-3.5 h-3.5 text-amber-400 shrink-0"
        />
        <span class="text-[11px] text-amber-300 flex-1">Agent config overridden for this session</span>
        <button
          class="text-[11px] px-2 py-0.5 rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
          title="Discard overrides and reset to agent defaults"
          @click="chatStore.resetAgentOverrides()"
        >
          Reset
        </button>
        <button
          class="text-[11px] px-2 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-500 transition-colors"
          title="Save these changes to the agent definition permanently"
          @click="chatStore.applyOverridesToAgent()"
        >
          Apply to Agent
        </button>
        <button
          class="text-[11px] px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors"
          title="Create a new agent from the current session configuration"
          @click="openSaveAgentModal"
        >
          Save as New Agent
        </button>
      </div>

      <!-- Free chat: save as agent hint -->
      <div
        v-else-if="!chatStore.activeAgentId && canSaveAsAgent"
        class="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-lg border border-zinc-700/50 bg-zinc-800/40"
      >
        <Icon
          icon="lucide:bot"
          class="w-3.5 h-3.5 text-zinc-400 shrink-0"
        />
        <span class="text-[11px] text-zinc-400 flex-1">Session has custom configuration</span>
        <button
          class="text-[11px] px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors flex items-center gap-1"
          title="Create a new agent from the current session configuration"
          @click="openSaveAgentModal"
        >
          <Icon
            icon="lucide:save"
            class="w-3 h-3"
          />
          Save as Agent
        </button>
      </div>

      <!-- Input area: textarea + bottom bar inside a unified container -->
      <div class="rounded-xl border border-zinc-700 bg-zinc-800 focus-within:ring-1 focus-within:ring-blue-500">
        <input
          ref="fileInputRef"
          type="file"
          accept="*/*"
          multiple
          class="hidden"
          @change="handleFileSelect"
        >

        <textarea
          ref="textareaRef"
          v-model="inputText"
          placeholder="Type a message..."
          rows="1"
          class="w-full bg-transparent text-zinc-100 px-4 pt-3 pb-2 text-sm resize-none focus:outline-none placeholder-zinc-500"
          aria-label="Type a message"
          @keydown="onKeydown"
          @input="autoResize"
          @paste="onPaste"
        />

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
            @click="openFilePicker"
          >
            <Icon
              icon="streamline-ultimate:attachment"
              class="h-4 w-4"
            />
          </button>

          <!-- Mobile: single tune button to open drawer -->
          <button
            class="sm:hidden p-1.5 rounded-lg transition-colors shrink-0 focus:outline-none"
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
          <span class="hidden sm:contents">
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
            <div class="w-28 sm:w-44">
              <CustomSelect
                :model-value="chatStore.sessionModelOverride || ''"
                :groups="modelDropdownGroups"
                max-height="max-h-96"
                dropdown-width="min-w-full"
                :filterable="true"
                :drop-up="true"
                align="center"
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
            :disabled="!inputText.trim()"
            class="p-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg transition-colors shrink-0 focus:outline-none"
            title="Send"
            aria-label="Send message"
            @click="send"
          >
            <Icon
              icon="mdi:send"
              class="h-4 w-4"
            />
          </button>
        </div>
      </div>
    </div>

    <!-- Context window usage ring — pinned to the far right of the bar -->
    <div class="hidden sm:block">
      <ContextRing />
    </div>
  </div>

  <!-- Save as Agent modal -->
  <ModalDialog
    :show="showSaveAgentModal"
    title="Save as New Agent"
    icon="lucide:bot"
    icon-color="blue"
    @close="showSaveAgentModal = false"
  >
    <p class="text-sm text-zinc-400 mb-4">
      Create a new agent from the current session configuration, including tools, sub-agents, memory spaces, and system prompt.
    </p>
    <div class="space-y-3">
      <div>
        <label class="block text-xs text-zinc-400 mb-1">Agent Name</label>
        <input
          v-model="newAgentName"
          type="text"
          class="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500 transition-colors"
          placeholder="e.g. Research Assistant"
          @keydown.enter="saveAsNewAgent"
        >
      </div>
      <div>
        <label class="block text-xs text-zinc-400 mb-1">Description (optional)</label>
        <input
          v-model="newAgentDescription"
          type="text"
          class="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500 transition-colors"
          placeholder="What does this agent do?"
        >
      </div>
      <!-- Config summary -->
      <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-1.5">
        <p class="text-[11px] text-zinc-500 font-medium uppercase tracking-wider mb-1">
          Configuration
        </p>
        <div
          v-if="agentStore.selectedToolNames.length"
          class="flex items-center gap-1.5 text-xs text-zinc-400"
        >
          <Icon
            icon="mdi:tools"
            class="w-3 h-3 text-blue-400"
          />
          {{ agentStore.selectedToolNames.length }} tool{{ agentStore.selectedToolNames.length !== 1 ? 's' : '' }}
        </div>
        <div
          v-if="chatStore.freeChatSubAgentIds.length"
          class="flex items-center gap-1.5 text-xs text-zinc-400"
        >
          <Icon
            icon="lucide:bot"
            class="w-3 h-3 text-blue-400"
          />
          {{ chatStore.freeChatSubAgentIds.length }} sub-agent{{ chatStore.freeChatSubAgentIds.length !== 1 ? 's' : '' }}
        </div>
        <div
          v-if="chatStore.freeChatMemorySpaceIds.length"
          class="flex items-center gap-1.5 text-xs text-zinc-400"
        >
          <Icon
            icon="lucide:brain"
            class="w-3 h-3 text-purple-400"
          />
          {{ chatStore.freeChatMemorySpaceIds.length }} memory space{{ chatStore.freeChatMemorySpaceIds.length !== 1 ? 's' : '' }}
        </div>
        <div
          v-if="chatStore.sessionSystemPrompt.trim()"
          class="flex items-center gap-1.5 text-xs text-zinc-400"
        >
          <Icon
            icon="lucide:scroll-text"
            class="w-3 h-3 text-amber-400"
          />
          Custom system prompt
        </div>
      </div>
    </div>
    <template #actions>
      <div class="flex justify-end gap-2">
        <button
          class="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          @click="showSaveAgentModal = false"
        >
          Cancel
        </button>
        <button
          :disabled="!newAgentName.trim() || savingAgent"
          class="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg disabled:opacity-50 transition-colors flex items-center gap-1.5"
          @click="saveAsNewAgent"
        >
          <Icon
            v-if="savingAgent"
            icon="lucide:loader-2"
            class="w-3.5 h-3.5 animate-spin"
          />
          Create Agent
        </button>
      </div>
    </template>
  </ModalDialog>
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
