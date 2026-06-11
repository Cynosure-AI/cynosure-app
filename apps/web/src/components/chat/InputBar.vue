<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { useChatStore } from '../../stores/chat.store'
import { Icon } from '@iconify/vue'
import InputToolbar from './inputbar/InputToolbar.vue'
import SaveAgentModal from './inputbar/SaveAgentModal.vue'
import ContextRing from './inputbar/ContextRing.vue'
import HoverTooltip from '../shared/HoverTooltip.vue'

const chatStore = useChatStore()

const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const attachedImages = ref<{ url: string; name: string }[]>([])
const attachedFiles = ref<{ name: string; content: string }[]>([])
const attachedAudio = ref<{ url: string; name: string }[]>([])

function modelHasInputModality(modality: string): boolean | null {
  const inputModalities = chatStore.modelModalities?.input
  if (!inputModalities?.length) return null
  return inputModalities.some((item) => item.toLowerCase() === modality)
}

const imageInputUnsupported = computed(() => modelHasInputModality('image') === false)
const audioInputUnsupported = computed(() => modelHasInputModality('audio') === false)

async function send(): Promise<void> {
  const content = inputText.value.trim()
  if (!content || chatStore.isConversationLocked) return
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
    if (!chatStore.isConversationLocked) send()
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

function onTranscription(text: string): void {
  inputText.value = inputText.value ? `${inputText.value} ${text}` : text
}

defineExpose({ processFiles })
</script>

<template>
  <div class="border-t border-theme-800 bg-theme-900 px-4 py-3 flex items-end gap-3">
    <!--Placeholder to even out the context ring space so the input is centered-->
    <div class="hidden sm:flex w-10 items-center justify-center" />


    <!-- Main input area -->
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
            class="h-16 w-16 rounded-lg object-cover border border-theme-700"
          >
          <HoverTooltip
            v-if="imageInputUnsupported"
            placement="above"
            :max-width="220"
          >
            <span class="absolute -bottom-1.5 -left-1.5 h-5 w-5 rounded-full border border-amber-300/70 bg-amber-500 text-black flex items-center justify-center shadow-lg shadow-black/30">
              <Icon
                icon="mdi:alert"
                class="h-3.5 w-3.5"
              />
            </span>
            <template #content>
              The selected model does not support image input.
            </template>
          </HoverTooltip>
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
          class="relative group flex items-center gap-1.5 rounded-lg border border-theme-700 bg-theme-800 px-2.5 py-1.5"
        >
          <Icon
            icon="mdi:file-document-outline"
            class="h-4 w-4 text-theme-400 shrink-0"
          />
          <span class="text-xs text-theme-300 max-w-32 truncate">{{ file.name }}</span>
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
          class="relative group flex items-center gap-1.5 rounded-lg border border-theme-700 bg-theme-800 px-2.5 py-1.5"
        >
          <Icon
            icon="mdi:music-note"
            class="h-4 w-4 text-theme-400 shrink-0"
          />
          <span class="text-xs text-theme-300 max-w-32 truncate">{{ audio.name }}</span>
          <HoverTooltip
            v-if="audioInputUnsupported"
            placement="above"
            :max-width="220"
          >
            <span class="h-4 w-4 rounded-full border border-amber-300/70 bg-amber-500 text-black flex items-center justify-center shrink-0">
              <Icon
                icon="mdi:alert"
                class="h-3 w-3"
              />
            </span>
            <template #content>
              The selected model does not support audio input.
            </template>
          </HoverTooltip>
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

      <!-- Agent override / save-as-agent bars -->
      <SaveAgentModal />

      <!-- Input area: textarea + bottom bar inside a unified container -->
      <div class="rounded-xl border border-theme-700 bg-theme-800 focus-within:ring-1 focus-within:ring-accent-500">
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
          class="w-full bg-transparent text-theme-100 px-4 pt-3 pb-2 text-sm resize-none focus:outline-none placeholder-theme-500"
          aria-label="Type a message"
          @keydown="onKeydown"
          @input="autoResize"
          @paste="onPaste"
        />

        <InputToolbar
          :can-send="!!inputText.trim()"
          @attach="openFilePicker"
          @send="send"
          @transcription="onTranscription"
        />
      </div>
    </div>

    <!-- Context window usage ring — pinned to the far right of the bar -->
    <div class="hidden sm:flex w-10 items-center justify-center">
      <ContextRing />
    </div>
  </div>
</template>
