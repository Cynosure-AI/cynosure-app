<script setup lang="ts">
/* eslint-disable vue/no-v-html -- both HTML producers below escape or sanitize untrusted content. */
import { computed, ref, nextTick, watch, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { renderMarkdown, handleMarkdownClick } from '../../utils/markdown'
import { Icon } from '@iconify/vue'
import { usePreferencesStore } from '../../stores/preferences.store'
import { useAppBranding } from '../../composables/useAppBranding'
import CollapsibleSection from '../shared/CollapsibleSection.vue'
import ArtifactImageModal from '../shared/ArtifactImageModal.vue'
import FileArtifactLinks from './FileArtifactLinks.vue'
import type { FileArtifactLink } from '../../utils/file-artifacts'
import { latestThoughtLine, type ThoughtLine } from '../../utils/thinking-preview'
import { useVoiceOutputStore } from '../../stores/voice-output.store'
import { useSpeechPlayer } from '../../composables/useSpeechPlayer'


const props = defineProps<{
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  messageId?: string
  createdAt?: number
  thinking?: string
  /** When this reply started and stopped thinking; only known for replies watched live. */
  thinkingStartedAt?: number
  thinkingEndedAt?: number
  imageDataUrls?: string[]
  videoDataUrls?: string[]
  audioDataUrls?: string[]
  fileAttachments?: { name: string; href?: string }[]
  fileArtifacts?: FileArtifactLink[]
  agentId?: string | null
  agentIconUrl?: string | null
  agentName?: string | null
  model?: string
  promptTokens?: number
  completionTokens?: number
  contextTokens?: number
  latencyMs?: number
  isStreaming?: boolean
  isError?: boolean
  /** The user stopped this reply before it finished. */
  stopped?: boolean
  forkDisabled?: boolean
  /** Render a normal message without mutation actions (for derived transcript entries). */
  readonly?: boolean
}>()

const emit = defineEmits<{
  retry: []
  edit: [string]
  fork: []
}>()

const router = useRouter()
const prefs = usePreferencesStore()
const { logoIconUrl } = useAppBranding()

const thinkingExpanded = ref(prefs.autoExpandSteps)
/** Thinking is still streaming until the first response text arrives. */
const isThinking = computed(() => Boolean(props.isStreaming && props.thinking && !props.content))
const thinkingBodyRef = ref<HTMLElement | null>(null)

// A live clock for the thinking header; it only ticks while thinking streams.
const now = ref(Date.now())
let thinkingTimer: ReturnType<typeof setInterval> | undefined
watch(isThinking, (thinking) => {
  clearInterval(thinkingTimer)
  thinkingTimer = undefined
  if (!thinking) return
  now.value = Date.now()
  thinkingTimer = setInterval(() => { now.value = Date.now() }, 1000)
}, { immediate: true })
onBeforeUnmount(() => clearInterval(thinkingTimer))

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const thinkingElapsed = computed(() => {
  if (!isThinking.value || props.thinkingStartedAt === undefined) return ''
  return formatDuration(now.value - props.thinkingStartedAt)
})
const thinkingLabel = computed(() => {
  if (isThinking.value) return 'Thinking'
  if (props.thinkingStartedAt !== undefined && props.thinkingEndedAt !== undefined) {
    return `Thought for ${formatDuration(props.thinkingEndedAt - props.thinkingStartedAt)}`
  }
  return 'Thought process'
})
// The newest line of reasoning, shown in the header while it is collapsed.
// Fast models start many short paragraphs a second, so each one holds for a
// moment before the newest takes over; a paragraph that is still growing
// updates in place.
const THOUGHT_DWELL_MS = 1600 // 1.6s per thought line, so a 3-line thought takes ~5s to fully cycle
const thinkingPreview = ref<ThoughtLine>()
let thoughtShownAt = 0
let thoughtTimer: ReturnType<typeof setTimeout> | undefined

function syncThinkingPreview(): void {
  clearTimeout(thoughtTimer)
  thoughtTimer = undefined
  const next = isThinking.value ? latestThoughtLine(props.thinking!) : undefined
  const current = thinkingPreview.value
  if (!next || !current || next.index === current.index) {
    if (!current && next) thoughtShownAt = Date.now()
    thinkingPreview.value = next
    return
  }
  const wait = thoughtShownAt + THOUGHT_DWELL_MS - Date.now()
  if (wait > 0) {
    thoughtTimer = setTimeout(syncThinkingPreview, wait)
    return
  }
  thinkingPreview.value = next
  thoughtShownAt = Date.now()
}
watch([() => props.thinking, isThinking], syncThinkingPreview, { immediate: true })
onBeforeUnmount(() => clearTimeout(thoughtTimer))

// Keep the newest reasoning in view while it streams, unless the reader has
// scrolled up to look at something earlier.
watch(() => props.thinking, () => {
  const el = thinkingBodyRef.value
  if (!el || !isThinking.value) return
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  if (nearBottom) nextTick(() => { el.scrollTop = el.scrollHeight })
})

// Fresh messages rise in; history and remounts (a streaming reply swapping to
// its persisted ID) appear in place.
const animateIn = props.role === 'user'
  ? props.createdAt !== undefined && Date.now() - props.createdAt < 3000
  : Boolean(props.isStreaming && !props.content && !props.thinking)
const copied = ref(false)
const isEditing = ref(false)
const editContent = ref('')
const lightboxSrc = ref<string | null>(null)
const editTextareaRef = ref<HTMLTextAreaElement | null>(null)

const voiceOutput = useVoiceOutputStore()
const speechPlayer = useSpeechPlayer()
const speechKey = computed(() => `message:${props.messageId ?? props.createdAt ?? props.content.slice(0, 64)}`)
const canSpeak = computed(() => props.role === 'assistant' && voiceOutput.canSpeak)
const speaking = computed(() => speechPlayer.isSpeaking(speechKey.value))
const speechError = computed(() => speechPlayer.state.errorKey === speechKey.value ? speechPlayer.state.error : '')

function toggleSpeech(): void {
  if (speaking.value) speechPlayer.stop()
  else speechPlayer.speak(speechKey.value, props.content)
}

function copyContent(): void {
  navigator.clipboard.writeText(props.content)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

function startEditing(): void {
  editContent.value = props.content
  isEditing.value = true
  nextTick(() => {
    autoResizeEdit()
  })
}

function autoResizeEdit(): void {
  const el = editTextareaRef.value
  if (el) {
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }
}

watch(editContent, () => {
  nextTick(autoResizeEdit)
})

function cancelEdit(): void {
  isEditing.value = false
  editContent.value = ''
}

function submitEdit(): void {
  const trimmed = editContent.value.trim()
  if (!trimmed) return
  emit('edit', trimmed)
  isEditing.value = false
  editContent.value = ''
}

/** Turn bare URLs in plain text into clickable anchor tags (used for user messages). */
function linkifyText(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped.replace(
    /(?:https?:\/\/|www\.)[^\s<>"'`)\]]+/gi,
    (url) => {
      const href = url.startsWith('www.') ? `https://${url}` : url
      return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="underline hover:opacity-80 break-all">${url}</a>`
    }
  )
}

const renderedContent = computed(() => {
  if (props.role === 'user') return linkifyText(props.content)
  return renderMarkdown(props.content)
})

const isUser = computed(() => props.role === 'user')
const showBubble = computed(() => isUser.value || prefs.aiMessageBubbles)
// Turn totals are attached to the final reply; intermediate rounds only carry the model.
const hasTokenUsage = computed(() =>
  props.contextTokens !== undefined || props.promptTokens !== undefined || props.completionTokens !== undefined,
)
const formattedCreatedAt = computed(() => {
  if (props.createdAt === undefined) return ''
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(props.createdAt)
})
const formattedLatency = computed(() => {
  if (props.latencyMs === undefined || props.latencyMs <= 0) return ''
  if (props.latencyMs < 10_000) return `${(props.latencyMs / 1000).toFixed(1)}s`
  return formatDuration(props.latencyMs)
})
const createdAtIso = computed(() => props.createdAt === undefined ? '' : new Date(props.createdAt).toISOString())
const userInitial = computed(() => prefs.userName.trim().charAt(0).toLocaleUpperCase() || 'U')
const isForkable = computed(() =>  props.role === 'assistant') //Could also include user too though it doesn't make as much sense since user messages are editable
const hasAssistantImages = computed(() => !isUser.value && Boolean(props.imageDataUrls?.length))
const hasAssistantVideos = computed(() => !isUser.value && Boolean(props.videoDataUrls?.length))
const hasAssistantAudio = computed(() => !isUser.value && Boolean(props.audioDataUrls?.length))
const hasAssistantFileArtifacts = computed(() => !isUser.value && Boolean(props.fileArtifacts?.length))
/** Anything rendered below the thinking block; without it the block is the whole message. */
const hasOutputAfterThinking = computed(() =>
  Boolean(props.isError || props.content)
  || hasAssistantFileArtifacts.value
  || hasAssistantImages.value
  || hasAssistantVideos.value
  || hasAssistantAudio.value
  || Boolean(props.isStreaming && !isThinking.value)
  || Boolean(!props.isStreaming && (hasTokenUsage.value || props.stopped))
)
const renderedMediaUrls = computed(() => [
  ...(props.imageDataUrls || []),
  ...(props.videoDataUrls || []),
  ...(props.audioDataUrls || []),
])
const imageGridClass = computed(() => {
  const count = props.imageDataUrls?.length || 0
  if (count > 1) return 'grid grid-cols-2 md:grid-cols-3 gap-2 w-full min-w-72 max-w-3xl'
  return 'w-full min-w-64 max-w-xl'
})
</script>

<template>
  <div
    class="relative flex items-end justify-center gap-4 px-3 md:px-4 py-3 group/msg transition-all duration-300"
    :class="[isUser ? 'md:justify-end' : 'md:justify-start', { 'chat-msg-enter': animateIn, 'chat-msg-enter--user': animateIn && isUser }]"
  >
    <!-- Avatar -->
    <div
      v-if="!isUser"
      class="shrink-0 mt-0.5 hidden md:flex flex-col items-center gap-0.5"
    >
      <div
        class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold overflow-hidden shadow-sm ring-1 ring-theme-700/50 transition-opacity"
        :class="[
          agentIconUrl ? 'bg-theme-800' : 'bg-linear-to-br from-theme-700 to-theme-900 text-theme-300',
          agentId ? 'cursor-pointer hover:opacity-80' : ''
        ]"
        @click="agentId ? router.push(`/agents/${agentId}`) : undefined"
      >
        <img
          v-if="agentIconUrl"
          :src="agentIconUrl"
          alt=""
          class="w-full h-full object-cover"
        >
        <img
          v-else
          :src="logoIconUrl"
          alt="Cynosure"
          class="w-full h-full object-contain"
        >
      </div>
      <span
        v-if="agentName"
        class="text-[10px] text-ink-muted max-w-15 truncate leading-tight"
        :title="agentName"
      >{{ agentName }}</span>
    </div>

    <!-- Message bubble -->
    <div
      class="relative md:max-w-[85%] max-w-[90%] px-5 py-3 text-[15px] wrap-break-word leading-relaxed transition-all"
      :class="[
        isUser ? 'chat-user-message bg-user-message text-user-message-text md:rounded-tr-sm' : 'text-theme-200 max-md:w-full max-md:max-w-full',
        showBubble ? 'rounded-3xl shadow-sm' : 'bg-transparent max-md:px-0',
        !isUser && showBubble ? 'bg-theme-800/60 border md:rounded-tl-sm' : '',
        !isUser && showBubble ? (isError ? 'border-red-500/40' : 'border-theme-700/50') : '',
        isEditing ? 'w-[85%] md:w-[80%]' : ''
      ]"
    >
      <!-- Action buttons: copy/fork (all normal messages), retry + edit (user only) -->
      <div
        v-if="content && !isStreaming"
        class="msg-actions absolute -top-3.5 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-theme-700/60 bg-theme-900/90 p-0.5 opacity-0 shadow-md shadow-black/20 backdrop-blur-sm transition-all duration-150 translate-y-0.5 group-hover/msg:translate-y-0 group-hover/msg:opacity-100 focus-within:translate-y-0 focus-within:opacity-100"
        :class="{ 'translate-y-0 opacity-100': speaking }"
      >
        <button
          v-if="isUser && !isEditing && !readonly"
          class="p-1 rounded-md text-ink-muted transition-colors hover:bg-theme-700/60 hover:text-theme-100"
          title="Edit"
          @click="startEditing"
        >
          <Icon
            icon="lucide:pencil"
            class="h-3.5 w-3.5"
          />
        </button>
        <button
          v-if="isUser && !readonly"
          class="p-1 rounded-md text-ink-muted transition-colors hover:bg-theme-700/60 hover:text-theme-100"
          title="Retry"
          @click="$emit('retry')"
        >
          <Icon
            icon="lucide:rotate-ccw"
            class="h-3.5 w-3.5"
          />
        </button>
        <button
          v-if="isForkable"
          class="disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent p-1 rounded-md text-ink-muted transition-colors hover:bg-theme-700/60 hover:text-theme-100"
          :disabled="forkDisabled || !messageId || /^(streaming_|sa_stream_|error_)/.test(messageId)"
          :title="forkDisabled ? 'Wait for the response to finish before forking' : 'Fork'"
          @click="$emit('fork')"
        >
          <Icon
            icon="lucide:git-fork"
            class="h-3.5 w-3.5"
          />
        </button>
        <button
          v-if="canSpeak"
          class="p-1 rounded-md transition-colors hover:bg-theme-700/60 hover:text-theme-100"
          :class="speaking ? 'text-accent-fg' : speechError ? 'text-status-warning' : 'text-ink-muted'"
          :title="speaking ? 'Stop reading' : speechError || 'Read aloud'"
          :aria-label="speaking ? 'Stop reading' : 'Read aloud'"
          data-testid="read-aloud"
          @click="toggleSpeech"
        >
          <Icon
            :icon="speaking ? (speechPlayer.state.phase === 'loading' ? 'lucide:loader-circle' : 'lucide:square') : speechError ? 'lucide:volume-x' : 'lucide:volume-2'"
            class="h-3.5 w-3.5"
            :class="{ 'animate-spin': speaking && speechPlayer.state.phase === 'loading' }"
          />
        </button>
        <button
          class="p-1 rounded-md text-ink-muted transition-colors hover:bg-theme-700/60 hover:text-theme-100"
          :title="copied ? 'Copied!' : 'Copy'"
          @click="copyContent"
        >
          <Icon
            :icon="copied ? 'lucide:check' : 'lucide:copy'"
            class="h-3.5 w-3.5"
            :class="{ 'text-status-success copy-confirm': copied }"
          />
        </button>
      </div>
      <!-- Thinking block -->
      <div
        v-if="!isUser && thinking"
        data-testid="thinking-block"
        class="thinking-block transition-colors duration-500"
        :class="[
          { 'mb-3': hasOutputAfterThinking },
          showBubble ? 'rounded-xl border bg-theme-950/25' : '',
          showBubble ? (isThinking ? 'border-accent-500/25' : 'border-theme-700/50') : '',
        ]"
      >
        <CollapsibleSection
          v-model="thinkingExpanded"
          :keyboard-shortcuts="true"
        >
          <template #trigger="{ expanded, toggle, triggerAttrs, onTriggerKeydown }">
            <button
              v-bind="triggerAttrs"
              class="group/think flex w-full min-w-0 items-center gap-2 py-2 text-left text-[13px] transition-colors"
              :class="showBubble ? 'rounded-xl px-3 hover:bg-theme-700/20' : 'rounded-lg'"
              @click="toggle"
              @keydown="onTriggerKeydown"
            >
              <span
                class="thinking-glyph relative flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors"
                :class="isThinking ? 'thinking-glyph--live text-accent-fg' : 'text-ink-faint group-hover/think:text-ink-secondary'"
              >
                <Icon
                  icon="lucide:brain"
                  class="h-3.5 w-3.5"
                />
              </span>
              <span
                class="shrink-0 font-medium text-ink-secondary"
                :class="{ 'text-shimmer': isThinking }"
              >{{ thinkingLabel }}</span>
              <span
                v-if="isThinking"
                class="thinking-dots -ml-1.5 inline-flex shrink-0 font-medium text-ink-secondary"
                role="status"
                aria-label="Thinking in progress"
              >
                <span
                  v-for="dot in 3"
                  :key="dot"
                  class="thinking-dot"
                  :style="{ animationDelay: `${(dot - 1) * 0.15}s` }"
                  aria-hidden="true"
                >.</span>
              </span>
              <span
                class="grid min-w-0 flex-1 overflow-hidden text-[12px] text-ink-faint"
                :title="!expanded ? thinkingPreview?.text : undefined"
              >
                <!-- Both lines share one grid cell, so the swap is a crossfade. -->
                <Transition
                  enter-active-class="transition duration-500 ease-out"
                  enter-from-class="opacity-0 translate-y-1.5"
                  leave-active-class="transition duration-300 ease-in"
                  leave-to-class="opacity-0 -translate-y-1.5"
                >
                  <span
                    v-if="!expanded && thinkingPreview"
                    :key="thinkingPreview.index"
                    class="col-start-1 row-start-1 block truncate"
                  >{{ thinkingPreview.text }}</span>
                </Transition>
              </span>
              <span
                v-if="thinkingElapsed"
                class="shrink-0 text-[11px] tabular-nums text-ink-faint"
              >{{ thinkingElapsed }}</span>
              <Icon
                icon="lucide:chevron-down"
                class="h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform duration-200"
                :class="{ 'rotate-180': expanded }"
              />
            </button>
          </template>

          <div
            ref="thinkingBodyRef"
            class="thinking-body mb-2.5 mt-0.5 max-h-64 overflow-y-auto whitespace-pre-wrap border-l-2 pl-3 pr-2 text-[13px] leading-relaxed text-ink-muted transition-colors duration-500"
            :class="[
              showBubble ? 'mx-3' : 'ml-2.5',
              isThinking ? 'border-accent-500/40' : 'border-theme-700/70',
            ]"
          >
            {{ thinking }}
          </div>
        </CollapsibleSection>
      </div>

      <!-- User message: edit mode -->
      <div
        v-if="isUser && isEditing"
        class="min-w-48"
      >
        <textarea
          ref="editTextareaRef"
          v-model="editContent"
          autofocus
          class="w-full bg-transparent resize-none outline-none text-white placeholder-white/40 text-[15px] leading-relaxed overflow-hidden"
          @input="autoResizeEdit"
          @keydown.enter.meta.prevent="submitEdit"
          @keydown.enter.ctrl.prevent="submitEdit"
          @keydown.escape="cancelEdit"
        />
        <div
          v-if="imageDataUrls?.length"
          class="flex gap-2 mt-2 flex-wrap"
        >
          <img
            v-for="(url, idx) in imageDataUrls"
            :key="idx"
            :src="url"
            class="h-24 rounded-lg object-cover border border-white/20"
            alt="Attached image"
          >
        </div>
        <div
          v-if="audioDataUrls?.length"
          class="flex flex-col gap-2 mt-2"
        >
          <audio
            v-for="(url, idx) in audioDataUrls"
            :key="idx"
            :src="url"
            controls
            class="max-w-full h-10"
          />
        </div>
        <div
          v-if="fileAttachments?.length"
          class="flex gap-1.5 mt-2 flex-wrap"
        >
          <component
            :is="file.href ? 'a' : 'span'"
            v-for="(file, idx) in fileAttachments"
            :key="idx"
            :href="file.href"
            :target="file.href ? '_blank' : undefined"
            :rel="file.href ? 'noopener noreferrer' : undefined"
            class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-black/25 text-white/90 border border-white/15"
            :class="file.href ? 'cursor-pointer hover:bg-black/35 focus-visible:outline-2 focus-visible:outline-white/70' : ''"
            :title="file.href ? `Open ${file.name}` : file.name"
          >
            <Icon
              icon="lucide:paperclip"
              class="w-3 h-3 shrink-0 opacity-70"
            />
            <span class="truncate max-w-40">{{ file.name }}</span>
          </component>
        </div>
        <div class="flex gap-2 mt-2 justify-end">
          <button
            class="px-2.5 py-1 rounded-lg text-xs text-white/60 hover:text-white/90 transition-colors"
            @click="cancelEdit"
          >
            Cancel
          </button>
          <button
            class="px-2.5 py-1 rounded-lg text-xs bg-white/20 hover:bg-white/30 text-white font-medium transition-colors"
            @click="submitEdit"
          >
            Send
          </button>
        </div>
      </div>

      <!-- User message: linkified text -->
      <div
        v-else-if="isUser"
      >
        <div
          class="whitespace-pre-wrap"
          v-html="renderedContent"
        />
        <div
          v-if="imageDataUrls?.length"
          class="flex gap-2 mt-2 flex-wrap"
        >
          <img
            v-for="(url, idx) in imageDataUrls"
            :key="idx"
            :src="url"
            class="h-32 rounded-lg object-cover border border-white/20 cursor-pointer hover:opacity-80 transition-opacity"
            title="Click to enlarge"
            @click="lightboxSrc = url"
          >
        </div>
        <div
          v-if="audioDataUrls?.length"
          class="flex flex-col gap-2 mt-2"
        >
          <audio
            v-for="(url, idx) in audioDataUrls"
            :key="idx"
            :src="url"
            controls
            class="max-w-full h-10"
          />
        </div>
        <!-- File attachments badge -->
        <div
          v-if="fileAttachments?.length"
          class="flex gap-1.5 mt-2 flex-wrap"
        >
          <component
            :is="file.href ? 'a' : 'span'"
            v-for="(file, idx) in fileAttachments"
            :key="idx"
            :href="file.href"
            :target="file.href ? '_blank' : undefined"
            :rel="file.href ? 'noopener noreferrer' : undefined"
            class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-black/25 text-white/90 backdrop-blur-sm border border-white/15"
            :class="file.href ? 'cursor-pointer hover:bg-black/35 focus-visible:outline-2 focus-visible:outline-white/70' : ''"
            :title="file.href ? `Open ${file.name}` : file.name"
          >
            <Icon
              icon="lucide:paperclip"
              class="w-3 h-3 shrink-0 opacity-70"
            />
            <span class="truncate max-w-40">{{ file.name }}</span>
          </component>
        </div>
      </div>

      <!-- Error message -->
      <div
        v-if="isError && !isUser"
        class="flex items-start gap-2 text-status-danger"
      >
        <Icon
          icon="lucide:alert-circle"
          class="w-4 h-4 mt-0.5 shrink-0"
        />
        <span class="text-sm">{{ content }}</span>
      </div>

      <!-- Assistant message: rendered markdown -->
      <div
        v-else-if="!isUser && content"
        class="msg-markdown prose dark:prose-invert prose-sm max-w-none"
        :class="{ 'msg-markdown--streaming': isStreaming && !isThinking }"
        @click="handleMarkdownClick"
        v-html="renderedContent"
      />

      <!-- File artifacts produced while building this assistant response -->
      <FileArtifactLinks
        v-if="hasAssistantFileArtifacts"
        :artifacts="fileArtifacts"
        :exclude-hrefs="renderedMediaUrls"
      />

      <!-- Model-generated images (assistant) -->
      <div
        v-if="hasAssistantImages"
        class="mt-2"
        :class="imageGridClass"
      >
        <img
          v-for="(url, idx) in imageDataUrls"
          :key="idx"
          :src="url"
          class="w-full max-h-[70vh] rounded-lg border border-theme-600 cursor-pointer hover:opacity-80 transition-opacity object-contain bg-theme-950/50"
          title="Click to enlarge"
          @click="lightboxSrc = url"
        >
      </div>

      <!-- Model-generated videos (assistant) -->
      <div
        v-if="hasAssistantVideos"
        class="mt-3 space-y-3 w-full min-w-64 max-w-3xl"
      >
        <div
          v-for="(url, idx) in videoDataUrls"
          :key="idx"
          class="rounded-lg border border-theme-600 bg-theme-950/50 overflow-hidden"
        >
          <video
            :src="url"
            controls
            playsinline
            class="w-full max-h-[70vh] bg-black"
          />
          <div class="flex items-center justify-end gap-2 px-2 py-2 border-t border-theme-700/60">
            <a
              :href="url"
              :download="`video-${idx + 1}.mp4`"
              class="inline-flex items-center gap-1.5 rounded-md bg-theme-800 hover:bg-theme-700 text-theme-200 px-2 py-1 text-xs transition-colors"
            >
              <Icon
                icon="lucide:download"
                class="w-3.5 h-3.5"
              />
              Download
            </a>
          </div>
        </div>
      </div>

      <!-- Model-generated audio (assistant) -->
      <div
        v-if="hasAssistantAudio"
        class="mt-3 flex flex-col gap-2 w-full min-w-64 max-w-xl"
      >
        <audio
          v-for="(url, idx) in audioDataUrls"
          :key="idx"
          :src="url"
          controls
          class="w-full h-10"
        />
      </div>

      <!-- Streaming caret before the first answer text; after that it rides the text itself. -->
      <span
        v-if="isStreaming && !isThinking && !content && !isError"
        data-testid="streaming-cursor"
        class="stream-caret"
        aria-hidden="true"
      />

      <!-- Message metadata (assistant) -->
      <div
        v-if="!isUser && !isStreaming && (hasTokenUsage || stopped)"
        class="msg-meta mt-2 pt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted"
        :class="showBubble ? 'border-t border-theme-700/50' : ''"
      >
        <span
          v-if="stopped"
          class="inline-flex items-center gap-1 text-status-warning"
          title="You stopped this reply before it finished."
        >
          <Icon
            icon="lucide:circle-stop"
            class="h-3.5 w-3.5"
          />
          Stopped
        </span>
        <span
          v-if="model && hasTokenUsage"
          class="inline-flex min-w-0 items-center gap-1"
        >
          <Icon
            icon="lucide:sparkle"
            class="h-3 w-3 shrink-0 opacity-70"
          />
          <span class="truncate">{{ model }}</span>
        </span>
        <span
          v-if="hasTokenUsage"
          class="inline-flex items-center gap-1 tabular-nums"
          :title="`Context: ${contextTokens?.toLocaleString() ?? '–'} tokens (actual window usage)\nAccumulated: ${((promptTokens ?? 0) + (completionTokens ?? 0)).toLocaleString()} tokens (total API consumption across all rounds)\nPrompt (input): ${promptTokens?.toLocaleString() ?? '–'}\nCompletion (output): ${completionTokens?.toLocaleString() ?? '–'}`"
        >
          <Icon
            icon="lucide:gauge"
            class="h-3 w-3 shrink-0 opacity-70"
          />
          {{ contextTokens?.toLocaleString() ?? '–' }} / {{ ((promptTokens ?? 0) + (completionTokens ?? 0)).toLocaleString() }} tokens
        </span>
        <span
          v-if="formattedLatency"
          class="inline-flex items-center gap-1 tabular-nums"
          title="Time from request to finished reply, including tool calls"
        >
          <Icon
            icon="lucide:timer"
            class="h-3 w-3 shrink-0 opacity-70"
          />
          {{ formattedLatency }}
        </span>
      </div>
    </div>

    <!-- User avatar -->
    <div
      v-if="isUser"
      class="w-8 h-8 hidden rounded-full md:flex items-center justify-center overflow-hidden text-xs font-medium shrink-0 mt-0.5 bg-linear-to-br from-accent-500 to-accent-700 text-white shadow-sm ring-1 ring-white/10"
    >
      <img
        v-if="prefs.userAvatarUrl"
        :src="prefs.userAvatarUrl"
        alt=""
        class="h-full w-full object-cover"
      >
      <template v-else>
        {{ userInitial }}
      </template>
    </div>

    <time
      v-if="formattedCreatedAt"
      data-testid="message-row-time"
      :datetime="createdAtIso"
      class="mb-1 shrink-0 text-[10px] leading-none tabular-nums text-ink-muted opacity-0 transition-opacity group-hover/msg:opacity-100 max-md:absolute max-md:bottom-0.5 max-md:left-1/2 max-md:mb-0 max-md:-translate-x-1/2"
    >
      {{ formattedCreatedAt }}
    </time>
  </div>

  <ArtifactImageModal
    :src="lightboxSrc"
    @close="lightboxSrc = null"
  />
</template>

<style scoped>
@keyframes thinking-dot-jump {
  0%,
  60%,
  100% {
    transform: translateY(0);
  }
  30% {
    transform: translateY(-4px);
  }
}
.thinking-dot {
  display: inline-block;
  animation: thinking-dot-jump 1.2s ease-in-out infinite;
}

/* Long reasoning fades out under the header instead of cutting off hard. */
.thinking-body {
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 1.25rem);
  mask-image: linear-gradient(to bottom, transparent, #000 1.25rem);
  padding-top: 0.5rem;
  scrollbar-width: thin;
}

@media (prefers-reduced-motion: no-preference) {
  .chat-msg-enter {
    animation: chat-msg-rise 340ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .chat-msg-enter--user {
    animation-name: chat-msg-rise-user;
  }

  /* While thinking, the glyph breathes with a soft accent halo. */
  .thinking-glyph--live::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: color-mix(in srgb, var(--color-accent-500) 18%, transparent);
    animation: thinking-breathe 1.8s ease-in-out infinite;
  }

  .copy-confirm {
    animation: copy-pop 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
}

@keyframes chat-msg-rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes chat-msg-rise-user {
  from {
    opacity: 0;
    transform: translate(6px, 8px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes thinking-breathe {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1.1);
  }
}

@keyframes copy-pop {
  from {
    transform: scale(0.6);
  }
  to {
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .thinking-dot {
    animation: none;
  }
}
</style>
