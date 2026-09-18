<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount, onMounted } from 'vue'
import { useChatStore } from '../../stores/chat.store'
import { SK_CHAT_DRAFT_PREFIX } from '../../utils/storage-keys'
import { Icon } from '@iconify/vue'
import InputToolbar from './inputbar/InputToolbar.vue'
import ContextRing from './inputbar/ContextRing.vue'
import HoverTooltip from '../shared/HoverTooltip.vue'
import FileLibraryModal from './modals/FileLibraryModal.vue'
import { api } from '../../api/client'
import type { StagedChatAttachment } from '../../api/types'

const chatStore = useChatStore()

defineProps<{
  floating?: boolean
}>()

function getDraftStorageKey(conversationId: string | null, agentId: string | null): string {
  const scope = conversationId ? `conversation:${conversationId}` : `new:${agentId || 'default'}`
  return `${SK_CHAT_DRAFT_PREFIX}${scope}`
}

function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function persistDraft(key: string, value: string): void {
  try {
    if (value) {
      localStorage.setItem(key, value)
    } else {
      localStorage.removeItem(key)
    }
  } catch {
    // Draft persistence is best-effort (for example, storage may be disabled).
  }
}

const draftStorageKey = computed(() => getDraftStorageKey(
  chatStore.activeConversationId,
  chatStore.activeAgentId
))
const inputText = ref(readDraft(draftStorageKey.value))
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const attachedImages = ref<{ url: string; name: string; sourceId?: string }[]>([])
type DraftFile = { clientId: string; name: string; content?: string; sourceId?: string; stagedId?: string; existingAttachmentId?: string; stagedConversationId?: string; status: 'processing' | 'ready' | 'error'; progressCurrent?: number; progressTotal?: number; controller?: AbortController; error?: string }
const attachedFiles = ref<DraftFile[]>([])
const attachedAudio = ref<{ url: string; name: string; sourceId?: string }[]>([])
const editingQueueId = ref<string | null>(null)
const showFileLibrary = ref(false)
const liveCleanups: Array<() => void> = []
const cancelledStageClientIds = new Set<string>()
let stagedPollTimer: number | null = null
let stagedLoadGeneration = 0

function modelHasInputModality(modality: string): boolean | null {
  const inputModalities = chatStore.modelModalities?.input
  if (!inputModalities?.length) return null
  return inputModalities.some((item) => item.toLowerCase() === modality)
}

const imageInputUnsupported = computed(() => modelHasInputModality('image') === false)
const transcriptionOutputSelected = computed(() =>
  chatStore.modelModalities?.output?.some((item) => item.toLowerCase() === 'transcription') === true
)
const audioInputUnsupported = computed(() =>
  !transcriptionOutputSelected.value && modelHasInputModality('audio') === false
)
const attachmentsProcessing = computed(() => attachedFiles.value.some(file => file.status === 'processing'))
const hasAttachmentError = computed(() => attachedFiles.value.some(file => file.status === 'error'))
const canSend = computed(() => !attachmentsProcessing.value && !hasAttachmentError.value && (!!inputText.value.trim() || attachedAudio.value.length > 0))

async function send(delivery: 'next' | 'steer' = 'next'): Promise<void> {
  const content = inputText.value.trim()
  if (!content && !attachedAudio.value.length) return
  const images = attachedImages.value.map((i) => i.url)
  if (attachmentsProcessing.value || hasAttachmentError.value) return
  const files = attachedFiles.value.filter(f => f.status === 'ready').map((f) => {
    const stagedId = f.stagedConversationId === chatStore.activeConversationId ? f.stagedId : undefined
    return { name: f.name, content: stagedId ? undefined : f.content, stagedId, existingAttachmentId: f.existingAttachmentId }
  })
  const audio = attachedAudio.value.map((a) => a.url)
  inputText.value = ''
  persistDraft(draftStorageKey.value, '')
  attachedImages.value = []
  attachedFiles.value = []
  attachedAudio.value = []
  resetHeight()
  const normalized = content || (audio.length ? 'Transcribe the attached audio.' : content)
  if (editingQueueId.value) {
    await chatStore.updateQueuedMessage(editingQueueId.value, normalized, images.length ? images : undefined, files.length ? files : undefined, audio.length ? audio : undefined)
    editingQueueId.value = null
  } else if (chatStore.isConversationLocked || chatStore.queuedMessages?.length) {
    await chatStore.queueMessage(normalized, delivery, images.length ? images : undefined, files.length ? files : undefined, audio.length ? audio : undefined)
  } else {
    await chatStore.sendMessage(normalized, images.length ? images : undefined, files.length ? files : undefined, audio.length ? audio : undefined)
  }
}

function editQueued(id: string, content: string): void {
  editingQueueId.value = id
  inputText.value = content
  nextTick(() => textareaRef.value?.focus())
}

function cancelQueueEdit(): void {
  editingQueueId.value = null
  inputText.value = ''
}

function openFilePicker(): void {
  fileInputRef.value?.click()
}

function addLibrarySelection(selection: {
  images: { id: string; name: string; url: string }[]
  files: { id: string; name: string; content?: string; existingAttachmentId?: string }[]
  audio: { id: string; name: string; url: string }[]
}): void {
  const existing = new Set([
    ...attachedImages.value.flatMap((item) => item.sourceId ? [item.sourceId] : []),
    ...attachedFiles.value.flatMap((item) => item.sourceId ? [item.sourceId] : []),
    ...attachedAudio.value.flatMap((item) => item.sourceId ? [item.sourceId] : []),
  ])
  for (const image of selection.images) {
    if (!existing.has(image.id)) attachedImages.value.push({ url: image.url, name: image.name, sourceId: image.id })
  }
  for (const file of selection.files) {
    // Library files already belong to a persisted message and are re-materialized
    // by the normal resend path; only new local uploads need draft staging.
    if (!existing.has(file.id)) attachedFiles.value.push({ clientId: crypto.randomUUID(), name: file.name, content: file.content, existingAttachmentId: file.existingAttachmentId, sourceId: file.id, status: 'ready' })
  }
  for (const audio of selection.audio) {
    if (!existing.has(audio.id)) attachedAudio.value.push({ url: audio.url, name: audio.name, sourceId: audio.id })
  }
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

async function stageFile(name: string, content: string, sourceId?: string): Promise<void> {
  const controller = new AbortController()
  const draft: DraftFile = { clientId: crypto.randomUUID(), name, content, sourceId, status: 'processing', progressCurrent: 0, progressTotal: 0, controller }
  attachedFiles.value.push(draft)
  try {
    const conversationId = chatStore.activeConversationId || await chatStore.createConversation()
    const staged = await api.chat.stageAttachment(conversationId, { name, content, clientId: draft.clientId }, controller.signal)
    const current = attachedFiles.value.find(file => file.clientId === draft.clientId)
    if (cancelledStageClientIds.delete(draft.clientId)) {
      await api.chat.removeStagedAttachment(conversationId, staged.id)
      return
    }
    // A route or conversation change can replace the local composer state
    // while this request is returning. Keep the durable server job so it can
    // be restored when that conversation is revisited.
    if (!current) return
    current.stagedId = staged.id
    current.stagedConversationId = conversationId
    current.status = staged.status === 'failed' ? 'error' : staged.status
    current.progressCurrent = staged.progressCurrent
    current.progressTotal = staged.progressTotal
    current.error = staged.error
    if (staged.status === 'processing') scheduleStagedRefresh(1_000)
  } catch (err) {
    if (cancelledStageClientIds.delete(draft.clientId) || controller.signal.aborted) return
    const current = attachedFiles.value.find(file => file.clientId === draft.clientId)
    if (!current) return
    current.status = 'error'
    current.error = (err as Error).message || 'Attachment processing failed'
  }
}

function applyStagedState(staged: StagedChatAttachment): void {
  let file = attachedFiles.value.find(item => item.stagedId === staged.id)
    || attachedFiles.value.find(item => item.clientId === staged.clientId)
  if (!file) {
    file = {
      clientId: staged.clientId || staged.id,
      name: staged.name,
      stagedId: staged.id,
      stagedConversationId: staged.conversationId,
      status: staged.status === 'failed' ? 'error' : staged.status,
    }
    attachedFiles.value.push(file)
  }
  file.stagedId = staged.id
  file.stagedConversationId = staged.conversationId
  file.status = staged.status === 'failed' ? 'error' : staged.status
  file.progressCurrent = staged.progressCurrent
  file.progressTotal = staged.progressTotal
  file.error = staged.error
}

async function refreshStagedAttachments(): Promise<void> {
  const conversationId = chatStore.activeConversationId
  const generation = ++stagedLoadGeneration
  if (!conversationId) return
  try {
    const staged = await api.chat.listStagedAttachments(conversationId)
    if (generation !== stagedLoadGeneration || conversationId !== chatStore.activeConversationId) return
    const serverIds = new Set(staged.map(item => item.id))
    attachedFiles.value = attachedFiles.value.filter(file =>
      !file.stagedId || file.stagedConversationId !== conversationId || serverIds.has(file.stagedId),
    )
    for (const item of staged) applyStagedState(item)
    if (staged.some(item => item.status === 'processing')) scheduleStagedRefresh(1_000)
  } catch {
    if (attachedFiles.value.some(file => file.status === 'processing')) scheduleStagedRefresh(5_000)
  }
}

function scheduleStagedRefresh(delay: number): void {
  if (stagedPollTimer !== null) window.clearTimeout(stagedPollTimer)
  stagedPollTimer = window.setTimeout(() => void refreshStagedAttachments(), delay)
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
        void stageFile(file.name, reader.result as string)
      }
      reader.readAsDataURL(file)
    } else {
      const reader = new FileReader()
      reader.onload = () => {
        void stageFile(file.name, reader.result as string)
      }
      reader.readAsText(file)
    }
  }
}

function removeImage(idx: number): void {
  attachedImages.value.splice(idx, 1)
}

function removeFile(idx: number): void {
  const file = attachedFiles.value[idx]
  if (!file) return
  attachedFiles.value.splice(idx, 1)
  cancelledStageClientIds.add(file.clientId)
  if (file.stagedId && file.stagedConversationId) {
    cancelledStageClientIds.delete(file.clientId)
    void api.chat.removeStagedAttachment(file.stagedConversationId, file.stagedId)
  }
}

function removeAudio(idx: number): void {
  attachedAudio.value.splice(idx, 1)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send('next')
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

watch(draftStorageKey, (newKey, oldKey) => {
  persistDraft(oldKey, inputText.value)
  inputText.value = readDraft(newKey)
  attachedFiles.value = []
  void refreshStagedAttachments()
})

onMounted(() => {
  // The initial draft is read before the textarea exists, so its watcher does
  // not run on mount. Size the now-mounted composer to the restored content.
  autoResize()
  const unsubscribe = api.chat.onAttachmentStageProgress((progress) => {
    if (progress.conversationId !== chatStore.activeConversationId) return
    applyStagedState(progress)
    if (progress.status === 'processing') scheduleStagedRefresh(1_000)
  })
  liveCleanups.push(unsubscribe)
  void refreshStagedAttachments()
})

onBeforeUnmount(() => {
  persistDraft(draftStorageKey.value, inputText.value)
  for (const cleanup of liveCleanups) cleanup()
  if (stagedPollTimer !== null) window.clearTimeout(stagedPollTimer)
})

function onTranscription(text: string): void {
  inputText.value = inputText.value ? `${inputText.value} ${text}` : text
}

function focus(): void {
  textareaRef.value?.focus()
}

function fillSuggestion(suggestion: string): void {
  inputText.value = suggestion
  persistDraft(draftStorageKey.value, suggestion)
  nextTick(() => {
    autoResize()
    textareaRef.value?.focus()
    textareaRef.value?.setSelectionRange(suggestion.length, suggestion.length)
  })
}

defineExpose({ processFiles, focus, fillSuggestion })
</script>

<template>
  <div
    class="chat-input-bar relative px-4 py-3 flex items-end gap-3 transition-[background-color,border-color] duration-300"
    :class="floating
      ? 'border border-transparent bg-transparent'
      : 'border-t border-x-0 border-b-0 border-theme-800 bg-theme-900'"
  >
    <!--Placeholder to even out the context ring space so the input is centered-->
    <div
      v-if="!floating"
      class="hidden sm:flex w-10 items-center justify-center"
    />


    <!-- Main input area -->
    <div class="relative max-w-5xl mx-auto flex-1 min-w-0">
      <div
        v-if="chatStore.queuedMessages?.length"
        class="mb-2 space-y-1.5 rounded-xl border border-theme-700 bg-theme-900/90 p-2"
        aria-label="Queued messages"
      >
        <div class="flex items-center justify-between px-1 text-[11px] text-theme-500">
          <span>{{ chatStore.queuedMessages?.length }} queued</span>
          <button
            v-if="!chatStore.isConversationLocked"
            type="button"
            class="text-accent-400 hover:text-accent-300"
            @click="chatStore.runNextQueuedMessage()"
          >
            Run next
          </button>
        </div>
        <div
          v-for="item in chatStore.queuedMessages"
          :key="item.id"
          class="flex items-center gap-2 rounded-lg bg-theme-800 px-2.5 py-2 text-xs"
        >
          <Icon icon="lucide:list-end" class="h-3.5 w-3.5 shrink-0 text-theme-500" />
          <span class="min-w-0 flex-1 truncate text-theme-200">{{ item.content }}</span>
          <span v-if="item.attachments.length" class="flex shrink-0 items-center gap-1 text-theme-500">
            <span
              v-for="attachment in item.attachments"
              :key="attachment.id"
              class="inline-flex max-w-28 items-center gap-0.5 rounded bg-theme-700 px-1.5 py-0.5"
            >
              <span class="truncate">{{ attachment.name }}</span>
              <button
                type="button"
                class="hover:text-red-400"
                :aria-label="`Remove ${attachment.name}`"
                @click.stop="chatStore.removeQueuedAttachment(item.id, attachment.id)"
              >×</button>
            </span>
          </span>
          <button type="button" class="text-theme-500 hover:text-theme-200" title="Edit queued message" @click="editQueued(item.id, item.content)">
            <Icon icon="lucide:pencil" class="h-3.5 w-3.5" />
          </button>
          <button type="button" class="text-accent-500 hover:text-accent-300" :title="chatStore.isConversationLocked ? 'Steer now' : 'Run now'" @click="chatStore.steerQueuedMessage(item.id)">
            <Icon icon="lucide:corner-up-left" class="h-3.5 w-3.5" />
          </button>
          <button type="button" class="text-theme-500 hover:text-red-400" title="Remove queued message" @click="chatStore.removeQueuedMessage(item.id)">
            <Icon icon="lucide:x" class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
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
            :icon="file.status === 'processing' ? 'lucide:loader-2' : file.status === 'error' ? 'lucide:circle-alert' : 'mdi:file-document-outline'"
            class="h-4 w-4 shrink-0"
            :class="file.status === 'processing' ? 'animate-spin text-accent-400' : file.status === 'error' ? 'text-red-400' : 'text-theme-400'"
          />
          <span class="text-xs text-theme-300 max-w-32 truncate">{{ file.name }}</span>
          <span
            v-if="file.status === 'processing'"
            class="text-[10px] text-theme-500 group-hover:hidden"
          >{{ file.progressCurrent || 0 }} / {{ file.progressTotal || '?' }} chunks</span>
          <span
            v-if="file.status === 'processing'"
            class="hidden text-[10px] text-red-300 group-hover:inline"
          >Cancel</span>
          <span
            v-else-if="file.status === 'error'"
            class="text-[10px] text-red-400"
            :title="file.error"
          >Failed</span>
          <button
            class="ml-1 h-4 w-4 rounded-full bg-red-600 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            :aria-label="file.status === 'processing' ? `Cancel upload of ${file.name}` : `Remove ${file.name}`"
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

      <!-- Input area: textarea + bottom bar inside a unified container -->
      <div
        class="rounded-xl border border-theme-700 bg-theme-800 focus-within:ring-1 focus-within:ring-accent-500 transition-shadow duration-300"
        :class="{ 'shadow-2xl shadow-black/40': floating }"
      >
        <input
          ref="fileInputRef"
          type="file"
          accept="*/*"
          multiple
          class="hidden"
          @change="handleFileSelect"
        >

        <textarea
          id="chat-textarea"
          ref="textareaRef"
          v-model="inputText"
          :placeholder="editingQueueId ? 'Edit queued message…' : chatStore.isConversationLocked ? 'Queue a message…' : 'Type a message...'"
          rows="1"
          class="w-full bg-transparent text-theme-100 px-4 pt-3 pb-2 text-sm resize-none focus:outline-none placeholder-theme-500"
          aria-label="Type a message"
          @keydown="onKeydown"
          @input="autoResize"
          @paste="onPaste"
        />

        <InputToolbar
          :can-send="canSend"
          :is-running="chatStore.isConversationLocked"
          :editing-queue="Boolean(editingQueueId)"
          @attach="openFilePicker"
          @browse-library="showFileLibrary = true"
          @send="send('next')"
          @steer="send('steer')"
          @cancel-edit="cancelQueueEdit"
          @transcription="onTranscription"
        />
      </div>

      <div
        v-if="floating"
        class="hidden sm:flex absolute -right-12 bottom-2 w-10 items-center justify-center"
      >
        <ContextRing />
      </div>
    </div>

    <FileLibraryModal
      :show="showFileLibrary"
      :already-selected-ids="[
        ...attachedImages.flatMap((item) => item.sourceId ? [item.sourceId] : []),
        ...attachedFiles.flatMap((item) => item.sourceId ? [item.sourceId] : []),
        ...attachedAudio.flatMap((item) => item.sourceId ? [item.sourceId] : []),
      ]"
      @close="showFileLibrary = false"
      @add="addLibrarySelection"
    />

    <!-- Context window usage ring — pinned to the far right of the bar -->
    <div
      v-if="!floating"
      class="hidden sm:flex w-10 items-center justify-center"
    >
      <ContextRing />
    </div>
  </div>
</template>

<style scoped>
#chat-textarea:focus {
  box-shadow:none !important;
}
</style>
