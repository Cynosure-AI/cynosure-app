<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount, onMounted } from 'vue'
import { useChatStore } from '../../stores/chat.store'
import { useProviderStore } from '../../stores/provider.store'
import type { MediaGenerationSettings } from '@shared/types'
import { SK_CHAT_DRAFT_PREFIX } from '../../utils/storage-keys'
import { Icon } from '@iconify/vue'
import InputToolbar from './inputbar/InputToolbar.vue'
import ComposerTabs from './inputbar/ComposerTabs.vue'
import ProjectIcon from '../project/ProjectIcon.vue'
import ContextRing from './inputbar/ContextRing.vue'
import HoverTooltip from '../shared/HoverTooltip.vue'
import FileLibraryModal from './modals/FileLibraryModal.vue'
import ProjectFilePickerModal from './modals/ProjectFilePickerModal.vue'
import ModelSelectorModal from './modals/ModelSelectorModal.vue'
import SystemPromptModal from './modals/SystemPromptModal.vue'
import SlashCommandMenu from './inputbar/SlashCommandMenu.vue'
import { useSlashCommands } from '../../composables/useSlashCommands'
import { findSlashCommand, composerCommandAt, slashSuggestions, type SlashOption } from '../../utils/slash-commands'
import { api } from '../../api/client'
import type { ProjectFileContent, StagedChatAttachment } from '../../api/types'
import { useProjectsStore } from '../../stores/projects.store'

const props = defineProps<{ hasSelectionTabs?: boolean }>()

const chatStore = useChatStore()
const providerStore = useProviderStore()
const projectsStore = useProjectsStore()

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
const mediaSettings = computed<MediaGenerationSettings | null>({
  get: () => chatStore.mediaGenerationSettings,
  set: (value) => { chatStore.mediaGenerationSettings = value },
})
const editingQueueId = ref<string | null>(null)
const showFileLibrary = ref(false)
const showProjectFiles = ref(false)
const activeProject = computed(() => projectsStore.get(chatStore.activeProjectId))
const hasBottomBar = computed(() => Boolean(activeProject.value) || props.hasSelectionTabs)
const projectRemovalError = ref('')
const removingProject = ref(false)
watch(() => chatStore.activeProjectId, () => { projectRemovalError.value = '' })
async function removeProject(): Promise<void> {
  projectRemovalError.value = ''
  removingProject.value = true
  try {
    await chatStore.setConversationProject(null)
    void projectsStore.load().catch(() => undefined)
  } catch (cause) {
    projectRemovalError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    removingProject.value = false
  }
}

const projectSourcePrefix = computed(() => `project:${chatStore.activeProjectId}:`)
/** Project-relative paths of project files already in the draft. */
const attachedProjectPaths = computed(() =>
  [...attachedImages.value, ...attachedFiles.value, ...attachedAudio.value].flatMap((item) =>
    item.sourceId?.startsWith(projectSourcePrefix.value) ? [item.sourceId.slice(projectSourcePrefix.value.length)] : []),
)
const liveCleanups: Array<() => void> = []
const cancelledStageClientIds = new Set<string>()
const discardedStageIds = new Set<string>()
let fileReadGeneration = 0
let stagedPollTimer: number | null = null
let stagedLoadGeneration = 0
let attachmentConversation: { draftKey: string; discardRevision: number; promise: Promise<string> } | null = null

function modelHasInputModality(modality: string): boolean | null {
  const inputModalities = chatStore.modelModalities?.input
  if (!inputModalities?.length) return null
  return inputModalities.some((item) => item.toLowerCase() === modality)
}

const imageInputUnsupported = computed(() => modelHasInputModality('image') === false)
const transcriptionOutputSelected = computed(() =>
  chatStore.modelModalities?.output?.some((item) => item.toLowerCase() === 'transcription') === true
)
const openRouterSelected = computed(() => {
  const providerId = chatStore.resolvedModelProvider?.providerId
  return providerStore.providers.find((provider) => provider.id === providerId)?.type === 'openrouter'
})
const videoOutputSelected = computed(() => openRouterSelected.value &&
  chatStore.modelModalities?.output?.some((item) => item.toLowerCase() === 'video') === true
)
const imageOutputSelected = computed(() =>
  openRouterSelected.value && !videoOutputSelected.value &&
  chatStore.modelModalities?.output?.some((item) => item.toLowerCase() === 'image') === true
)
const mediaKind = computed<'image' | 'video' | undefined>(() =>
  videoOutputSelected.value ? 'video' : imageOutputSelected.value ? 'image' : undefined
)
watch(() => `${chatStore.resolvedModelProvider?.providerId || ''}:${chatStore.resolvedModelProvider?.model || ''}:${mediaKind.value}`,
  () => { mediaSettings.value = null })
function currentMediaSettings(): MediaGenerationSettings | undefined {
  const settings = mediaSettings.value
  return settings && settings.kind === mediaKind.value ? { ...settings } : undefined
}
const audioInputUnsupported = computed(() =>
  !transcriptionOutputSelected.value && modelHasInputModality('audio') === false
)
const attachmentsProcessing = computed(() => attachedFiles.value.some(file => file.status === 'processing'))
const hasAttachmentError = computed(() => attachedFiles.value.some(file => file.status === 'error'))
/** Something is being composed, even if it can't be sent yet. */
const hasInput = computed(() => Boolean(inputText.value.trim())
  || attachedImages.value.length > 0 || attachedFiles.value.length > 0 || attachedAudio.value.length > 0)
const canSend = computed(() => !attachmentsProcessing.value && !hasAttachmentError.value && (!!inputText.value.trim() || attachedAudio.value.length > 0))

// ─── Slash commands ──────────────────
const showModelSelector = ref(false)
const showSystemPrompt = ref(false)
const { commands: slashCommands, prepare: prepareSlashCommands } = useSlashCommands({
  attachFiles: () => openFilePicker(),
  browseLibrary: () => { showFileLibrary.value = true },
  chooseModel: () => { showModelSelector.value = true },
  editSystemPrompt: () => { showSystemPrompt.value = true },
})
const slashMenuId = 'chat-slash-commands'
const slashMenuRef = ref<InstanceType<typeof SlashCommandMenu> | null>(null)
/** Composer text the user dismissed the menu for with Escape; it may then be sent as a message. */
const slashDismissedFor = ref<string | null>(null)
const slashIndex = ref(0)
const composerCaret = ref(inputText.value.length)
const activeCommand = computed(() => composerCommandAt(inputText.value, composerCaret.value))
function updateComposerCaret(): void {
  const el = textareaRef.value
  if (el) composerCaret.value = el.selectionStart === el.selectionEnd ? el.selectionStart : -1
}
const slashOptions = computed(() =>
  slashDismissedFor.value === inputText.value || !activeCommand.value ? [] : slashSuggestions(slashCommands.value, activeCommand.value.text)
)
const slashOpen = computed(() => slashOptions.value.length > 0)
const activeSlashIndex = computed(() => Math.min(slashIndex.value, slashOptions.value.length - 1))
const slashNotice = ref<{ text: string; error: boolean } | null>(null)
let slashNoticeTimer: number | null = null

watch(inputText, () => { slashIndex.value = 0; composerCaret.value = inputText.value.length }, { flush: 'sync' })
watch(() => Boolean(activeCommand.value), (typing) => {
  if (typing) prepareSlashCommands()
}, { immediate: true })

function showSlashNotice(text: string, error = false): void {
  slashNotice.value = { text, error }
  if (slashNoticeTimer !== null) window.clearTimeout(slashNoticeTimer)
  slashNoticeTimer = window.setTimeout(() => { slashNotice.value = null }, error ? 4_000 : 2_500)
}

function moveSlashSelection(step: number): void {
  const count = slashOptions.value.length
  slashIndex.value = (activeSlashIndex.value + step + count) % count
}

/** Only consume the command at the cursor, preserving the rest of the draft. */
function replaceActiveCommand(replacement: string): void {
  const command = activeCommand.value
  if (!command) return
  const caret = command.start + replacement.length
  inputText.value = inputText.value.slice(0, command.start) + replacement + inputText.value.slice(command.end)
  composerCaret.value = caret
  persistDraft(draftStorageKey.value, inputText.value)
  nextTick(() => {
    textareaRef.value?.focus()
    textareaRef.value?.setSelectionRange(caret, caret)
  })
}

function completeSlashOption(option: SlashOption): void {
  if (option.complete) replaceActiveCommand(option.complete)
}

async function selectSlashOption(option: SlashOption): Promise<void> {
  if (option.unavailable) {
    replaceActiveCommand('')
    showSlashNotice(option.unavailable, true)
    return
  }
  if (!option.run) {
    completeSlashOption(option)
    return
  }
  replaceActiveCommand('')
  try {
    const message = await option.run()
    if (message) showSlashNotice(message)
  } catch (err) {
    showSlashNotice((err as Error).message || 'Command failed', true)
  }
  textareaRef.value?.focus()
}

/** Run the highlighted command, or explain why a typed command was not sent. Returns true when handled. */
function handleSlashSubmit(): boolean {
  if (slashOpen.value) {
    void selectSlashOption(slashOptions.value[activeSlashIndex.value])
    return true
  }
  if (slashDismissedFor.value === inputText.value) return false
  const input = activeCommand.value
  const command = input ? findSlashCommand(slashCommands.value, input.name) : undefined
  if (!input || !command) return false
  if (command.unavailable) {
    showSlashNotice(command.unavailable, true)
    return true
  }
  if (command.sendsMessage && input.args.trim()) return false
  // A known command must never reach the model by accident; Escape first to send it as text.
  showSlashNotice(input.args.trim()
    ? `No match for “${input.args.trim()}” in /${command.name}`
    : `/${command.name} needs ${command.hint ? `${/^[aeiou]/i.test(command.hint) ? 'an' : 'a'} ${command.hint}` : 'an argument'}`, true)
  return true
}

async function send(delivery: 'next' | 'steer' = 'next'): Promise<void> {
  if (handleSlashSubmit()) return
  const content = inputText.value.trim()
  if (!content && !attachedAudio.value.length) return
  const images = attachedImages.value.map((i) => i.url)
  if (attachmentsProcessing.value || hasAttachmentError.value) return
  const files = attachedFiles.value.filter(f => f.status === 'ready').map((f) => {
    const stagedId = f.stagedConversationId === chatStore.activeConversationId ? f.stagedId : undefined
    return { name: f.name, content: stagedId ? undefined : f.content, stagedId, existingAttachmentId: f.existingAttachmentId }
  })
  const audio = attachedAudio.value.map((a) => a.url)
  const selectedMediaSettings = currentMediaSettings()
  inputText.value = ''
  persistDraft(draftStorageKey.value, '')
  attachedImages.value = []
  attachedFiles.value = []
  attachedAudio.value = []
  resetHeight()
  const normalized = content || (audio.length ? 'Transcribe the attached audio.' : content)
  if (editingQueueId.value) {
    await chatStore.updateQueuedMessage(editingQueueId.value, normalized, images.length ? images : undefined, files.length ? files : undefined, audio.length ? audio : undefined, selectedMediaSettings)
    editingQueueId.value = null
  } else if (chatStore.isConversationLocked || chatStore.queuedMessages?.length) {
    await chatStore.queueMessage(normalized, delivery, images.length ? images : undefined, files.length ? files : undefined, audio.length ? audio : undefined, selectedMediaSettings)
  } else {
    await chatStore.sendMessage(normalized, images.length ? images : undefined, files.length ? files : undefined, audio.length ? audio : undefined, selectedMediaSettings)
  }
}

function editQueued(id: string, content: string): void {
  editingQueueId.value = id
  inputText.value = content
  const queuedSettings = chatStore.queuedMessages.find((item) => item.id === id)?.run.mediaGeneration
  mediaSettings.value = queuedSettings && queuedSettings.kind === mediaKind.value ? { ...queuedSettings } : null
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

function addProjectFiles(files: ProjectFileContent[]): void {
  for (const file of files) {
    const sourceId = `${projectSourcePrefix.value}${file.name}`
    if (attachedProjectPaths.value.includes(file.name)) continue
    if (file.kind === 'image') attachedImages.value.push({ url: file.content, name: file.name, sourceId })
    else if (file.kind === 'audio') attachedAudio.value.push({ url: file.content, name: file.name, sourceId })
    else void stageFile(file.name, file.content, sourceId)
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
    let conversationId = chatStore.activeConversationId
    if (!conversationId) {
      // Several files can finish reading together. Create one conversation for
      // the whole draft and let the draft watcher recognize this transition.
      const creation = attachmentConversation ??= {
        draftKey: draftStorageKey.value,
        discardRevision: chatStore.draftDiscardRevision,
        promise: chatStore.createConversation(),
      }
      try {
        conversationId = await creation.promise
      } finally {
        if (attachmentConversation === creation) attachmentConversation = null
      }
    }
    if (cancelledStageClientIds.has(draft.clientId)) return
    const staged = await api.chat.stageAttachment(conversationId, { name, content, clientId: draft.clientId }, controller.signal)
    const current = attachedFiles.value.find(file => file.clientId === draft.clientId)
    if (cancelledStageClientIds.has(draft.clientId)) {
      discardedStageIds.add(staged.id)
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
  if (discardedStageIds.has(staged.id) || (staged.clientId && cancelledStageClientIds.has(staged.clientId))) return
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
  const generation = fileReadGeneration
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) continue // 20MB limit

    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = () => {
        if (generation !== fileReadGeneration) return
        attachedImages.value.push({
          url: reader.result as string,
          name: file.name
        })
      }
      reader.readAsDataURL(file)
    } else if (file.type.startsWith('audio/')) {
      const reader = new FileReader()
      reader.onload = () => {
        if (generation !== fileReadGeneration) return
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
        if (generation !== fileReadGeneration) return
        void stageFile(file.name, reader.result as string)
      }
      reader.readAsDataURL(file)
    } else {
      const reader = new FileReader()
      reader.onload = () => {
        if (generation !== fileReadGeneration) return
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
    discardedStageIds.add(file.stagedId)
    void api.chat.removeStagedAttachment(file.stagedConversationId, file.stagedId)
  }
}

function removeAudio(idx: number): void {
  attachedAudio.value.splice(idx, 1)
}

function onKeydown(e: KeyboardEvent): void {
  if (slashOpen.value && !e.isComposing) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      moveSlashSelection(e.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      completeSlashOption(slashOptions.value[activeSlashIndex.value])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      slashDismissedFor.value = inputText.value
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
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

watch(() => chatStore.draftDiscardRevision, () => {
  fileReadGeneration++
  stagedLoadGeneration++
  if (stagedPollTimer !== null) window.clearTimeout(stagedPollTimer)
  for (const file of attachedFiles.value) {
    cancelledStageClientIds.add(file.clientId)
    if (file.stagedId) discardedStageIds.add(file.stagedId)
  }
  attachedFiles.value = []
  attachedImages.value = []
  attachedAudio.value = []
}, { flush: 'sync' })

watch(draftStorageKey, async (newKey, oldKey) => {
  persistDraft(oldKey, inputText.value)
  const creation = attachmentConversation
  if (creation?.draftKey === oldKey && creation.discardRevision === chatStore.draftDiscardRevision) {
    const conversationId = await creation.promise.catch(() => null)
    if (draftStorageKey.value !== newKey || creation.discardRevision !== chatStore.draftDiscardRevision) return
    if (conversationId && newKey === getDraftStorageKey(conversationId, chatStore.activeAgentId)) {
      // Staging persisted the current new-chat draft; it did not switch chats.
      persistDraft(newKey, inputText.value)
      persistDraft(oldKey, '')
      void refreshStagedAttachments()
      return
    }
  }
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
  if (slashNoticeTimer !== null) window.clearTimeout(slashNoticeTimer)
})

function onTranscription(text: string): void {
  inputText.value = inputText.value ? `${inputText.value} ${text}` : text
}

function focus(): void {
  textareaRef.value?.focus()
}

async function sendSuggestion(suggestion: string): Promise<void> {
  const content = suggestion.trim()
  if (!content) return
  if (chatStore.isConversationLocked || chatStore.queuedMessages?.length) {
    await chatStore.queueMessage(content, 'next', undefined, undefined, undefined, currentMediaSettings())
  } else {
    await chatStore.sendMessage(content, undefined, undefined, undefined, currentMediaSettings())
  }
}

defineExpose({ processFiles, focus, sendSuggestion })
</script>

<template>
  <!-- Same chrome whether centered or docked, so the empty→chat transition is
       only the composer sliding down (driven by ChatView's spacer). -->
  <div class="chat-input-bar relative px-4 py-3 flex items-end gap-3">
    <!--Placeholder to even out the context ring space so the input is centered-->
    <div class="hidden sm:flex w-10 items-center justify-center" />

    <!-- Main input area -->
    <div class="relative max-w-5xl mx-auto flex-1 min-w-0">
      <div
        v-if="chatStore.queuedMessages?.length"
        class="mb-2 space-y-1.5 rounded-xl border border-theme-700 bg-theme-900/90 p-2"
        aria-label="Queued messages"
      >
        <div class="flex items-center justify-between px-1 text-[11px] text-ink-muted">
          <span>{{ chatStore.queuedMessages?.length }} queued</span>
          <button
            v-if="!chatStore.isConversationLocked"
            type="button"
            class="text-accent-fg hover:text-accent-fg"
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
          <Icon
            icon="lucide:list-end"
            class="h-3.5 w-3.5 shrink-0 text-ink-muted"
          />
          <span class="min-w-0 flex-1 truncate text-theme-200">{{ item.content }}</span>
          <span
            v-if="item.attachments.length"
            class="flex shrink-0 items-center gap-1 text-ink-muted"
          >
            <span
              v-for="attachment in item.attachments"
              :key="attachment.id"
              class="inline-flex max-w-28 items-center gap-0.5 rounded bg-theme-700 px-1.5 py-0.5"
            >
              <span class="truncate">{{ attachment.name }}</span>
              <button
                type="button"
                class="hover:text-status-danger"
                :aria-label="`Remove ${attachment.name}`"
                @click.stop="chatStore.removeQueuedAttachment(item.id, attachment.id)"
              >×</button>
            </span>
          </span>
          <button
            type="button"
            class="text-ink-muted hover:text-theme-200"
            title="Edit queued message"
            @click="editQueued(item.id, item.content)"
          >
            <Icon
              icon="lucide:pencil"
              class="h-3.5 w-3.5"
            />
          </button>
          <button
            type="button"
            class="text-accent-fg hover:text-accent-fg"
            :title="chatStore.isConversationLocked ? 'Steer now' : 'Run now'"
            @click="chatStore.steerQueuedMessage(item.id)"
          >
            <Icon
              icon="lucide:corner-up-left"
              class="h-3.5 w-3.5"
            />
          </button>
          <button
            type="button"
            class="text-ink-muted hover:text-status-danger"
            title="Remove queued message"
            @click="chatStore.removeQueuedMessage(item.id)"
          >
            <Icon
              icon="lucide:x"
              class="h-3.5 w-3.5"
            />
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
            :class="file.status === 'processing' ? 'animate-spin text-accent-fg' : file.status === 'error' ? 'text-status-danger' : 'text-ink-secondary'"
          />
          <span class="text-xs text-theme-300 max-w-32 truncate">{{ file.name }}</span>
          <span
            v-if="file.status === 'processing'"
            class="text-[10px] text-ink-muted group-hover:hidden"
          >{{ file.progressCurrent || 0 }} / {{ file.progressTotal || '?' }} chunks</span>
          <span
            v-if="file.status === 'processing'"
            class="hidden text-[10px] text-red-300 group-hover:inline"
          >Cancel</span>
          <span
            v-else-if="file.status === 'error'"
            class="text-[10px] text-status-danger"
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
            class="h-4 w-4 text-ink-secondary shrink-0"
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

      <!-- Input area: textarea + bottom bar inside a unified container.
           Incognito dashes the border: this chat is only temporary. -->
      <div
        class="chat-composer relative rounded-xl border bg-theme-800 transition-colors duration-300 focus-within:ring-1 focus-within:ring-accent-500 shadow-xl shadow-theme-600/20 dark:shadow-2xl dark:shadow-black/40"
        :class="chatStore.activeIsTemporary ? 'chat-composer--temporary border-dashed border-theme-500' : 'border-theme-700'"
      >
        <input
          ref="fileInputRef"
          type="file"
          accept="*/*"
          multiple
          class="hidden"
          @change="handleFileSelect"
        >

        <SlashCommandMenu
          v-if="slashOpen"
          :id="slashMenuId"
          ref="slashMenuRef"
          :options="slashOptions"
          :active-index="activeSlashIndex"
          :grouped="activeCommand?.text === '/'"
          @select="selectSlashOption"
          @hover="slashIndex = $event"
        />
        <div
          v-else-if="slashNotice"
          role="status"
          class="absolute bottom-full left-0 z-30 mb-2 flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-lg"
          :class="slashNotice.error ? 'border-red-500/40 bg-theme-900 text-status-danger' : 'border-theme-700 bg-theme-900 text-theme-200'"
        >
          <Icon
            :icon="slashNotice.error ? 'lucide:circle-alert' : 'lucide:check'"
            class="h-3.5 w-3.5 shrink-0"
            :class="slashNotice.error ? '' : 'text-accent-fg'"
          />
          <span class="truncate">{{ slashNotice.text }}</span>
        </div>

        <textarea
          id="chat-textarea"
          ref="textareaRef"
          v-model="inputText"
          :placeholder="editingQueueId ? 'Edit queued message…' : chatStore.isConversationLocked ? 'Queue a message…' : 'Type a message, or / for commands'"
          rows="1"
          class="w-full bg-transparent text-theme-100 px-4 pt-3 pb-2 text-sm resize-none focus:outline-none placeholder:text-ink-muted"
          aria-label="Type a message"
          aria-autocomplete="list"
          :aria-controls="slashOpen ? slashMenuId : undefined"
          :aria-activedescendant="slashOpen ? slashMenuRef?.optionId(activeSlashIndex) : undefined"
          @keydown="onKeydown"
          @input="updateComposerCaret(); autoResize()"
          @click="updateComposerCaret"
          @keyup="updateComposerCaret"
          @select="updateComposerCaret"
          @paste="onPaste"
        />
        <InputToolbar
          :can-send="canSend"
          :has-input="hasInput"
          :is-running="chatStore.isConversationLocked"
          :editing-queue="Boolean(editingQueueId)"
          :media-kind="mediaKind"
          :media-provider-id="chatStore.resolvedModelProvider?.providerId"
          :media-model="chatStore.resolvedModelProvider?.model"
          :media-settings="mediaSettings"
          @attach="openFilePicker"
          @browse-library="showFileLibrary = true"
          @browse-project="showProjectFiles = true"
          @send="send('next')"
          @steer="send('steer')"
          @cancel-edit="cancelQueueEdit"
          @transcription="onTranscription"
          @media-settings="mediaSettings = $event"
        />
      </div>
      <ComposerTabs
        v-if="hasBottomBar"
        :has-project="Boolean(activeProject)"
        :has-tools="hasSelectionTabs"
      >
        <template #project>
          <span
            v-if="activeProject"
            class="inline-flex h-full min-w-0 max-w-48 items-center gap-1.5 text-xs text-theme-200"
            data-testid="project-chip"
            :title="`Project: ${activeProject.name}`"
          >
            <ProjectIcon
              :project="activeProject"
              class="h-3.5 w-3.5 shrink-0"
            />
            <span class="truncate">{{ activeProject.name }}</span>
            <button
              type="button"
              class="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-theme-700 hover:text-theme-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:opacity-50"
              :aria-label="`Remove project ${activeProject.name} from this chat`"
              :disabled="removingProject"
              @click="removeProject"
            >
              <Icon
                icon="lucide:x"
                class="h-3 w-3"
              />
            </button>
          </span>
        </template>
        <slot name="selection-tabs" />
      </ComposerTabs>
      <p
        v-if="projectRemovalError"
        role="alert"
        class="mt-1 px-4 text-xs text-status-danger"
      >
        {{ projectRemovalError }}
      </p>
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
    <ProjectFilePickerModal
      :show="showProjectFiles"
      :project-id="activeProject?.rootPath ? activeProject.id : null"
      :project-name="activeProject?.name"
      :already-selected-paths="attachedProjectPaths"
      @close="showProjectFiles = false"
      @add="addProjectFiles"
    />
    <ModelSelectorModal v-model="showModelSelector" />
    <SystemPromptModal
      v-model="showSystemPrompt"
      :system-prompt="chatStore.sessionSystemPrompt"
      @update:system-prompt="(value: string) => { chatStore.sessionSystemPrompt = value; chatStore.markOverridesModified() }"
    />

    <!-- Context window usage ring — pinned to the far right of the bar. The
         slot keeps its width so the input stays centered; ChatView anchors the
         ring itself to the column's bottom-right while the composer is centered. -->
    <div
      class="context-ring-slot hidden sm:flex w-10 items-center justify-center"
      :class="{ 'mb-6': hasBottomBar }"
    >
      <div class="context-ring-anchor flex w-10 justify-center">
        <ContextRing />
      </div>
    </div>
  </div>
</template>

<style scoped>
#chat-textarea:focus {
  box-shadow:none !important;
}
</style>
