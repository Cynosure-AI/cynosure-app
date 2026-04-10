<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { useChatStore } from '../../stores/chat.store'
import { useAgentStore } from '../../stores/agent.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { usePreferencesStore } from '../../stores/preferences.store'
import { useWhisper } from '../../composables/useWhisper'
import { Icon } from '@iconify/vue'
import ToolSelectorModal from './ToolSelectorModal.vue'
import SubAgentSelectorModal from './SubAgentSelectorModal.vue'
import MemorySpaceSelectorModal from './MemorySpaceSelectorModal.vue'

const chatStore = useChatStore()
const agentStore = useAgentStore()
const agentDefs = useAgentDefinitionsStore()
const prefs = usePreferencesStore()

// Override detection
const hasOverrides = computed(() => chatStore.hasAgentOverrides)

// Sub-agent / memory space counts
const subAgentCount = computed(() =>
  chatStore.freeChatSubAgentIds.length
)
const memorySpaceCount = computed(() =>
  chatStore.freeChatMemorySpaceIds.length
)

const { status: whisperStatus, progress: whisperProgress, startRecording, stopRecording } = useWhisper()

const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const attachedImages = ref<{ url: string; name: string }[]>([])
const attachedFiles = ref<{ name: string; content: string }[]>([])
const attachedAudio = ref<{ url: string; name: string }[]>([])
const showToolModal = ref(false)
const showSubAgentModal = ref(false)
const showMemorySpaceModal = ref(false)

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

defineExpose({ processFiles })
</script>

<template>
  <div class="border-t border-zinc-800 bg-zinc-900 px-4 py-3">
    <div class="max-w-4xl mx-auto">
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
      </div>

      <div class="flex items-end gap-2">
        <!-- File attach button -->
        <button
          class="p-2.5 text-zinc-500 hover:text-zinc-300 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-blue-500"
          title="Attach file"
          :disabled="chatStore.isStreaming"
          aria-label="Attach file"
          :aria-disabled="chatStore.isStreaming"
          @click="openFilePicker"
        >
          <Icon
            icon="streamline-ultimate:attachment"
            class="h-5 w-5"
          />
        </button>

        <!-- Tools button -->
        <button
          v-if="agentStore.availableTools.length"
          class="relative p-2.5 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-blue-500 text-zinc-500 hover:text-zinc-300"
          title="Tool access"
          aria-label="Tool access"
          @click="showToolModal = true"
        >
          <Icon
            icon="mdi:tools"
            class="h-5 w-5"
          />
          <span
            class="absolute -top-0.5 -right-0.5 min-w-4 h-4 flex items-center justify-center rounded-full text-[9px] font-bold text-white arasaka:text-black px-1 leading-none bg-blue-600"
          >
            {{ agentStore.selectedToolNames.length }}
          </span>
        </button>

        <!-- Sub-agents button -->
        <button
          v-if="agentDefs.agents.length"
          class="relative p-2.5 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-blue-500 text-zinc-500 hover:text-zinc-300"
          title="Sub-agents"
          aria-label="Sub-agents"
          @click="showSubAgentModal = true"
        >
          <Icon
            icon="lucide:bot"
            class="h-5 w-5"
          />
          <span
            v-if="subAgentCount > 0"
            class="absolute -top-0.5 -right-0.5 min-w-4 h-4 flex items-center justify-center rounded-full text-[9px] font-bold text-white arasaka:text-black px-1 leading-none bg-blue-600"
          >
            {{ subAgentCount }}
          </span>
        </button>

        <!-- Memory spaces button -->
        <button
          class="relative p-2.5 rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-blue-500 text-zinc-500 hover:text-zinc-300"
          title="Memory spaces"
          aria-label="Memory spaces"
          @click="showMemorySpaceModal = true"
        >
          <Icon
            icon="lucide:brain"
            class="h-5 w-5"
          />
          <span
            v-if="memorySpaceCount > 0"
            class="absolute -top-0.5 -right-0.5 min-w-4 h-4 flex items-center justify-center rounded-full text-[9px] font-bold text-white arasaka:text-black px-1 leading-none bg-blue-600"
          >
            {{ memorySpaceCount }}
          </span>
        </button>

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
          class="flex-1 bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-xl px-4 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-500"
          aria-label="Type a message"
          @keydown="onKeydown"
          @input="autoResize"
          @paste="onPaste"
        />

        <!-- Mic / voice input button -->
        <button
          v-if="prefs.whisperEnabled"
          class="relative p-2.5 rounded-xl transition-all duration-300 shrink-0 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
            class="h-5 w-5"
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

        <button
          v-if="chatStore.isStreaming || chatStore.activePostActions.size > 0"
          class="p-2.5 bg-red-600 hover:bg-red-500 text-white rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-red-500"
          title="Cancel"
          aria-label="Cancel"
          @click="chatStore.isStreaming ? chatStore.cancelStream() : chatStore.cancelPostActions()"
        >
          <Icon
            icon="mdi:stop-circle"
            class="h-5 w-5"
          />
        </button>
        <button
          v-else
          :disabled="!inputText.trim()"
          class="p-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-xl transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-blue-500"
          title="Send"
          aria-label="Send message"
          :aria-disabled="!inputText.trim()"
          @click="send"
        >
          <Icon
            icon="mdi:send"
            class="h-5 w-5"
          />
        </button>
      </div>
    </div>
  </div>

  <ToolSelectorModal v-model="showToolModal" />
  <SubAgentSelectorModal v-model="showSubAgentModal" />
  <MemorySpaceSelectorModal v-model="showMemorySpaceModal" />
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
