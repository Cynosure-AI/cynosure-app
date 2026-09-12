<script setup lang="ts">
/* eslint-disable vue/no-v-html -- both HTML producers below escape or sanitize untrusted content. */
import { computed, ref, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { renderMarkdown, handleMarkdownClick } from '../../utils/markdown'
import { Icon } from '@iconify/vue'
import { usePreferencesStore } from '../../stores/preferences.store'
import { useAppBranding } from '../../composables/useAppBranding'
import CollapsibleSection from '../shared/CollapsibleSection.vue'
import ArtifactImageModal from '../shared/ArtifactImageModal.vue'
import FileArtifactLinks from './FileArtifactLinks.vue'
import type { FileArtifactLink } from '../../utils/file-artifacts'

const markdownRef = ref<HTMLElement | null>(null)

const props = defineProps<{
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  messageId?: string
  createdAt?: number
  thinking?: string
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
  forkDisabled?: boolean
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
const copied = ref(false)
const isEditing = ref(false)
const editContent = ref('')
const lightboxSrc = ref<string | null>(null)
const editTextareaRef = ref<HTMLTextAreaElement | null>(null)

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
const formattedCreatedAt = computed(() => {
  if (props.createdAt === undefined) return ''
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(props.createdAt)
})
const createdAtIso = computed(() => props.createdAt === undefined ? '' : new Date(props.createdAt).toISOString())
const userInitial = computed(() => prefs.userName.trim().charAt(0).toLocaleUpperCase() || 'U')
const isForkable = computed(() =>  props.role === 'assistant') //Could also include user too though it doesn't make as much sense since user messages are editable
const hasAssistantImages = computed(() => !isUser.value && Boolean(props.imageDataUrls?.length))
const hasAssistantVideos = computed(() => !isUser.value && Boolean(props.videoDataUrls?.length))
const hasAssistantAudio = computed(() => !isUser.value && Boolean(props.audioDataUrls?.length))
const hasAssistantFileArtifacts = computed(() => !isUser.value && Boolean(props.fileArtifacts?.length))
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
    class="flex items-end gap-4 px-3 md:px-4 py-3 group/msg transition-all duration-300"
    :class="isUser ? 'justify-end' : 'justify-start'"
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
        class="text-[10px] text-theme-500 max-w-15 truncate leading-tight"
        :title="agentName"
      >{{ agentName }}</span>
    </div>

    <!-- Message bubble -->
    <div
      class="relative md:max-w-[85%] max-w-[90%] rounded-3xl px-5 py-3 text-[15px] wrap-break-word leading-relaxed shadow-sm transition-all"
      :class="[
        isUser ? 'chat-user-message bg-accent-600 text-white rounded-tr-sm' : 'bg-theme-800/60 border text-theme-200 rounded-tl-sm',
        isError && !isUser ? 'border-red-500/40' : !isUser ? 'border-theme-700/50' : '',
        isEditing ? 'w-[85%] md:w-[80%]' : ''
      ]"
    >
      <!-- Action buttons: copy/fork (all normal messages), retry + edit (user only) -->
      <div
        v-if="content && !isStreaming"
        class="absolute -top-2 right-1 flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity"
      >
        <button
          v-if="isUser && !isEditing"
          class="p-1 rounded-md bg-theme-700/80 text-theme-400 hover:text-theme-100 text-[10px]"
          title="Edit"
          @click="startEditing"
        >
          <Icon
            icon="mdi:pencil"
            class="h-3.5 w-3.5"
          />
        </button>
        <button
          v-if="isUser"
          class="p-1 rounded-md bg-theme-700/80 text-theme-400 hover:text-theme-100 text-[10px]"
          title="Retry"
          @click="$emit('retry')"
        >
          <Icon
            icon="mdi:refresh"
            class="h-3.5 w-3.5"
          />
        </button>
        <button
          v-if="isForkable"
          class="disabled:opacity-40 disabled:cursor-not-allowed p-1 rounded-md bg-theme-700/80 text-theme-400 hover:text-theme-100 text-[10px]"
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
          class="p-1 rounded-md bg-theme-700/80 text-theme-400 hover:text-theme-100 text-[10px]"
          :title="copied ? 'Copied!' : 'Copy'"
          @click="copyContent"
        >
          <Icon
            :icon="copied ? 'mdi:check' : 'mdi:content-copy'"
            class="h-3.5 w-3.5"
          />
        </button>
      </div>
      <!-- Thinking block (detailed mode only) -->
      <div
        v-if="!isUser && thinking"
        class="mb-3 rounded-xl border border-indigo-500/20 bg-indigo-500/5 backdrop-blur-sm shadow-sm"
      >
        <CollapsibleSection
          v-model="thinkingExpanded"
          header-label="Thinking"
          header-icon="lucide:brain"
          header-class="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] rounded-xl transition-colors hover:bg-indigo-500/10"
          header-text-class="font-medium text-indigo-400"
          chevron-class="h-3.5 w-3.5 text-indigo-300/70"
          :keyboard-shortcuts="true"
        >
          <template #header-extra>
            <span
              v-if="isStreaming"
              class="animate-pulse text-indigo-300"
            >…</span>
          </template>

          <div
            class="border-t border-indigo-500/20 px-3 py-2.5 text-[13px] leading-relaxed text-theme-400 whitespace-pre-wrap max-h-64 overflow-y-auto font-mono"
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
        class="flex items-start gap-2 text-red-400"
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
        ref="markdownRef"
        class="msg-markdown prose dark:prose-invert prose-sm max-w-none"
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

      <!-- Streaming cursor -->
      <span
        v-if="isStreaming"
        class="inline-block w-2 h-4 bg-theme-400 animate-pulse ml-0.5"
      />

      <!-- Message metadata (assistant) -->
      <div
        v-if="!isUser && !isStreaming && (model || promptTokens)"
        class="mt-2 pt-1.5 border-t border-theme-700/50 flex items-center gap-3 text-xs text-theme-500"
      >
        <span v-if="model">{{ model }}</span>
        <span
          v-if="contextTokens || promptTokens || completionTokens"
          :title="`Context: ${contextTokens?.toLocaleString() ?? '–'} tokens (actual window usage)\nAccumulated: ${((promptTokens ?? 0) + (completionTokens ?? 0)).toLocaleString()} tokens (total API consumption across all rounds)\nPrompt (input): ${promptTokens?.toLocaleString() ?? '–'}\nCompletion (output): ${completionTokens?.toLocaleString() ?? '–'}`"
        >
          {{ contextTokens?.toLocaleString() ?? '–' }} / {{ ((promptTokens ?? 0) + (completionTokens ?? 0)).toLocaleString() }} tokens
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
      class="mb-1 shrink-0 text-[10px] leading-none tabular-nums text-theme-500 opacity-0 transition-opacity group-hover/msg:opacity-100"
    >
      {{ formattedCreatedAt }}
    </time>
  </div>

  <ArtifactImageModal
    :src="lightboxSrc"
    @close="lightboxSrc = null"
  />
</template>

<style>
/* ── Heading hierarchy ── */
.msg-markdown h1 {
  font-size: 1.5rem;
  line-height: 2rem;
  font-weight: 700;
  margin-top: 1.5rem;
  margin-bottom: 0.75rem;
  letter-spacing: 0;
}
.msg-markdown h2 {
  font-size: 1.25rem;
  line-height: 1.75rem;
  font-weight: 700;
  margin-top: 1.25rem;
  margin-bottom: 0.5rem;
  letter-spacing: 0;
}
.msg-markdown h3 {
  font-size: 1.125rem;
  line-height: 1.75rem;
  font-weight: 600;
  margin-top: 1rem;
  margin-bottom: 0.5rem;
}
.msg-markdown h4 {
  font-size: 1rem;
  line-height: 1.5rem;
  font-weight: 600;
  margin-top: 0.75rem;
  margin-bottom: 0.375rem;
}
.msg-markdown h5 {
  font-size: 0.875rem;
  line-height: 1.25rem;
  font-weight: 500;
  margin-top: 0.75rem;
  margin-bottom: 0.25rem;
}
.msg-markdown h6 {
  font-size: 0.75rem;
  line-height: 1rem;
  font-weight: 500;
  margin-top: 0.625rem;
  margin-bottom: 0.25rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

/* ── Code blocks ── */
.msg-markdown pre {
  background: rgb(24 24 27);
  border: 1px solid rgba(63, 63, 70, 0.5);
  border-radius: 0.5rem;
  overflow-x: auto;
  margin: 0.75rem 0;
}

.msg-markdown pre code {
  color: inherit;
  background: transparent;
  padding: 0.75rem 1rem;
  font-size: inherit;
  border-radius: 0;
}

/* ── Inline code ── */
.msg-markdown :not(pre) > code {
  padding: 0.125rem 0.375rem;
  border-radius: 0.25rem;
  font-size: 0.85em;
  background: rgba(63, 63, 70, 0.5);
  color: #93c5fd;
}
.msg-markdown :not(pre) > code::before,
.msg-markdown :not(pre) > code::after {
  content: none;
}

/* ── Links ── */
.msg-markdown a {
  color: #93c5fd;
  text-decoration: underline;
  text-decoration-color: rgba(147, 197, 253, 0.3);
  transition: text-decoration-color 0.15s;
  word-break: break-all;
}
.msg-markdown a:hover {
  text-decoration-color: rgba(147, 197, 253, 0.8);
}

/* ── Spacing ── */
.msg-markdown p { margin: 0.5rem 0; }
.msg-markdown ul, .msg-markdown ol {
  margin: 0.5rem 0 0.5rem 1.25rem;
  padding-left: 1rem;
}
.msg-markdown ul { list-style-type: disc; }
.msg-markdown ol { list-style-type: decimal; }
.msg-markdown ul ul, .msg-markdown ol ul { list-style-type: circle; }
.msg-markdown ul ul ul, .msg-markdown ol ul ul { list-style-type: square; }
.msg-markdown li {
  margin: 0.125rem 0;
  padding-left: 0.125rem;
}
.msg-markdown li > p { margin: 0.125rem 0; }
.msg-markdown strong { color: rgba(244, 244, 245, 1); }

/* ── Blockquotes ── */
.msg-markdown blockquote {
  margin: 0.5rem 0;
  padding: 0.375rem 0.75rem;
  border-left: 3px solid var(--color-theme-600);
  background: rgba(39, 39, 42, 0.3);
  border-radius: 0 0.375rem 0.375rem 0;
  color: var(--color-theme-300);
}
.msg-markdown blockquote p { margin: 0.25rem 0; }
.msg-markdown blockquote blockquote { margin-top: 0.25rem; }

/* ── Tables ── */
.msg-markdown table {
  width: 100%;
  border-collapse: collapse;
  margin: 0.75rem 0;
  font-size: 0.85rem;
  border: 1px solid var(--color-theme-700);
  border-radius: 0.5rem;
  overflow: hidden;
}
.msg-markdown thead {
  background: var(--color-theme-700);
}
.msg-markdown th {
  padding: 0.5rem 0.75rem;
  text-align: left;
  font-weight: 600;
  color: var(--color-theme-100);
  border-bottom: 2px solid var(--color-theme-600);
  border-right: 1px solid var(--color-theme-600);
  white-space: nowrap;
}
.msg-markdown th:last-child {
  border-right: none;
}
.msg-markdown td {
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--color-theme-700);
  border-right: 1px solid var(--color-theme-700);
  color: var(--color-theme-300);
}
.msg-markdown td:last-child {
  border-right: none;
}
.msg-markdown tr:last-child td {
  border-bottom: none;
}
.msg-markdown tbody tr:nth-child(even) {
  background: var(--color-theme-800);
}
.msg-markdown tbody tr:nth-child(odd) {
  background: color-mix(in srgb, var(--color-theme-800) 40%, var(--color-theme-900));
}
.msg-markdown tbody tr:hover {
  background: var(--color-theme-700);
}

/* ── Code block wrapper ── */
.code-block-wrapper {
  position: relative;
  margin: 0.75rem 0;
}

.code-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.375rem 1rem;
  font-size: 0.75rem;
  color: rgba(161, 161, 170, 0.8);
  background: rgba(24, 24, 27, 0.9);
  border: 1px solid rgba(63, 63, 70, 0.5);
  border-bottom: none;
  border-radius: 0.5rem 0.5rem 0 0;
  user-select: none;
}

.code-copy-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.25rem;
  border-radius: 0.25rem;
  color: rgba(161, 161, 170, 0.6);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.code-copy-btn:hover {
  color: rgba(244, 244, 245, 0.9);
  background: rgba(63, 63, 70, 0.5);
}
.code-copy-btn.copied {
  color: #34d399;
}

.code-header + pre {
  margin-top: 0 !important;
  border-top-left-radius: 0 !important;
  border-top-right-radius: 0 !important;
}
</style>
