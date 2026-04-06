<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'
import { Icon } from '@iconify/vue'
import { usePreferencesStore } from '../../stores/preferences.store'

const props = defineProps<{
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  messageId?: string
  thinking?: string
  imageDataUrls?: string[]
  audioDataUrls?: string[]
  memorySources?: { text: string; source: string; score: number }[]
  agentId?: string | null
  agentIconUrl?: string | null
  agentName?: string | null
  model?: string
  promptTokens?: number
  completionTokens?: number
  latencyMs?: number
  isStreaming?: boolean
  isError?: boolean
}>()

const emit = defineEmits<{
  retry: []
  edit: [string]
}>()

const router = useRouter()
const prefs = usePreferencesStore()

const thinkingExpanded = ref(prefs.autoExpandSteps)
const sourcesExpanded = ref(false)
const copied = ref(false)
const isEditing = ref(false)
const editContent = ref('')

function copyContent(): void {
  navigator.clipboard.writeText(props.content)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

function startEditing(): void {
  editContent.value = props.content
  isEditing.value = true
}

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

// Configure marked with highlight.js
marked.use(
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code: string, lang: string) {
      // Strip any pre-existing hljs spans the LLM may have injected into code blocks
      let clean = code
        .replace(/<span\s+class="hljs-[^"]*">/g, '')
        .replace(/<\/span>/g, '')
      // Decode HTML entities that some LLMs emit inside code fences
      if (!/^(html|xml|svg|xhtml|htm)$/i.test(lang || '')) {
        clean = clean
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&nbsp;/g, ' ')
      }
      clean = clean
        .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([a-fA-F0-9]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(clean, { language: lang }).value
      }
      return hljs.highlightAuto(clean).value
    }
  })
)

// Custom code block renderer with language label
marked.use({
  renderer: {
    code({ text, lang, escaped }: { text: string; lang?: string; escaped?: boolean }) {
      const langLabel = (lang || '').split(/\s/)[0].replace(/[<>&"']/g, '')
      const codeContent = escaped ? text : text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const langClass = langLabel ? `hljs language-${langLabel}` : 'hljs'
      const headerHtml = langLabel
        ? `<div class="code-header"><span>${langLabel}</span></div>`
        : ''
      return `<div class="code-block-wrapper">${headerHtml}<pre><code class="${langClass}">${codeContent}</code></pre></div>`
    }
  }
})

marked.setOptions({
  breaks: true
})

/** Rewrite <img> src attributes that reference local filesystem paths to use the file-serving API. */
function rewriteLocalImagePaths(html: string): string {
  return html.replace(
    /(<img\s[^>]*\bsrc=["'])((?:file:\/\/)?\/[^"']+)(["'])/gi,
    (_match, before, src, after) => {
      // Strip file:// prefix if present
      const cleanPath = src.replace(/^file:\/\//, '')
      // Skip paths that are already API URLs
      if (cleanPath.startsWith('/api/') || cleanPath.startsWith('/ws')) return _match
      return `${before}/api/files?path=${encodeURIComponent(cleanPath)}${after}`
    }
  )
}

const renderedContent = computed(() => {
  if (props.role === 'user') return props.content
  try {
    const html = marked.parse(props.content) as string
    return rewriteLocalImagePaths(html)
  } catch {
    return props.content
  }
})

const isUser = computed(() => props.role === 'user')
</script>

<template>
  <div
    class="flex gap-4 px-1 md:px-4 py-3 group/msg transition-all duration-300"
    :class="isUser ? 'justify-end' : 'justify-start'"
  >
    <!-- Avatar -->
    <div
      v-if="!isUser"
      class="shrink-0 mt-0.5 flex flex-col items-center gap-0.5"
    >
      <div
        class="w-8 h-8 rounded-full hidden md:flex items-center justify-center text-xs font-semibold overflow-hidden shadow-sm ring-1 ring-zinc-700/50 transition-opacity"
        :class="[
          agentIconUrl ? 'bg-zinc-800' : 'bg-linear-to-br from-zinc-700 to-zinc-900 text-zinc-300',
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
        <span v-else>AI</span>
      </div>
      <span
        v-if="agentName"
        class="text-[10px] text-zinc-500 max-w-15 truncate leading-tight"
        :title="agentName"
      >{{ agentName }}</span>
    </div>

    <!-- Message bubble -->
    <div
      class="relative md:max-w-[85%] max-w-[90%] rounded-3xl px-5 py-3 text-[15px] leading-relaxed shadow-sm transition-all"
      :class="[
        isUser ? 'bg-blue-600 text-white rounded-tr-sm' : 'bg-zinc-800/60 border text-zinc-200 rounded-tl-sm',
        isError && !isUser ? 'border-red-500/40' : !isUser ? 'border-zinc-700/50' : ''
      ]"
    >
      <!-- Action buttons: copy (all), retry + edit (user only) -->
      <div
        v-if="content && !isStreaming"
        class="absolute -top-2 right-1 flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity"
      >
        <button
          v-if="isUser && !isEditing"
          class="p-1 rounded-md bg-zinc-700/80 text-zinc-400 hover:text-zinc-100 text-[10px]"
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
          class="p-1 rounded-md bg-zinc-700/80 text-zinc-400 hover:text-zinc-100 text-[10px]"
          title="Retry"
          @click="$emit('retry')"
        >
          <Icon
            icon="mdi:refresh"
            class="h-3.5 w-3.5"
          />
        </button>
        <button
          class="p-1 rounded-md bg-zinc-700/80 text-zinc-400 hover:text-zinc-100 text-[10px]"
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
        <button
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-medium text-indigo-400 hover:text-indigo-300 hover:bg-indigo-500/10 transition-colors rounded-xl"
          @click="thinkingExpanded = !thinkingExpanded"
        >
          <Icon
            icon="lucide:brain"
            class="w-3.5 h-3.5"
          />
          <span>Thinking</span>
          <span
            v-if="isStreaming"
            class="animate-pulse"
          >…</span>
          <svg
            class="ml-auto h-3.5 w-3.5 transition-transform opacity-70"
            :class="{ 'rotate-180': thinkingExpanded }"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </button>
        <div
          v-if="thinkingExpanded"
          class="border-t border-indigo-500/20 px-3 py-2.5 text-[13px] leading-relaxed text-zinc-400 whitespace-pre-wrap max-h-64 overflow-y-auto font-mono"
        >
          {{ thinking }}
        </div>
      </div>

      <!-- User message: edit mode -->
      <div
        v-if="isUser && isEditing"
        class="min-w-48"
      >
        <textarea
          v-model="editContent"
          rows="3"
          autofocus
          class="w-full bg-transparent resize-none outline-none text-white placeholder-white/40 text-[15px] leading-relaxed"
          @keydown.enter.meta.prevent="submitEdit"
          @keydown.enter.ctrl.prevent="submitEdit"
          @keydown.escape="cancelEdit"
        />
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

      <!-- User message: plain text -->
      <div
        v-else-if="isUser"
        class="whitespace-pre-wrap"
      >
        {{ content }}
        <div
          v-if="imageDataUrls?.length"
          class="flex gap-2 mt-2 flex-wrap"
        >
          <img
            v-for="(url, idx) in imageDataUrls"
            :key="idx"
            :src="url"
            class="h-32 rounded-lg object-cover border border-white/20"
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
        v-else-if="!isUser"
        class="msg-markdown prose dark:prose-invert prose-sm max-w-none"
        v-html="renderedContent"
      />

      <!-- Model-generated images (assistant) -->
      <div
        v-if="!isUser && imageDataUrls?.length"
        class="flex gap-2 mt-2 flex-wrap"
      >
        <img
          v-for="(url, idx) in imageDataUrls"
          :key="idx"
          :src="url"
          class="max-w-full rounded-lg border border-zinc-600"
        >
      </div>

      <!-- Streaming cursor -->
      <span
        v-if="isStreaming"
        class="inline-block w-2 h-4 bg-zinc-400 animate-pulse ml-0.5"
      />

      <!-- Message metadata -->
      <div
        v-if="!isUser && !isStreaming && (model || promptTokens)"
        class="mt-2 pt-1.5 border-t border-zinc-700/50 flex items-center gap-3 text-xs text-zinc-500"
      >
        <span v-if="model">{{ model }}</span>
        <span v-if="promptTokens || completionTokens">
          {{ promptTokens }}/{{ completionTokens }} tokens
        </span>
      </div>

      <!-- Memory sources -->
      <div
        v-if="!isUser && memorySources?.length"
        class="mt-2"
      >
        <button
          class="flex items-center gap-1.5 text-xs text-blue-400/70 hover:text-blue-400 transition-colors"
          @click="sourcesExpanded = !sourcesExpanded"
        >
          <Icon
            icon="lucide:book-open"
            class="w-3 h-3"
          />
          <span>{{ memorySources.length }} memory source{{ memorySources.length !== 1 ? 's' : '' }} used</span>
          <Icon
            icon="lucide:chevron-down"
            class="w-3 h-3 transition-transform"
            :class="{ 'rotate-180': sourcesExpanded }"
          />
        </button>
        <div
          v-if="sourcesExpanded"
          class="mt-1.5 space-y-1.5"
        >
          <div
            v-for="(src, idx) in memorySources"
            :key="idx"
            class="rounded-md bg-zinc-900/80 border border-zinc-700/50 px-2.5 py-1.5"
          >
            <div class="flex items-center justify-between gap-2 mb-0.5">
              <span class="text-[11px] text-zinc-500 truncate">
                {{ src.source || 'memory' }}
              </span>
              <span
                class="text-[11px] font-mono shrink-0 px-1.5 py-0.5 rounded"
                :class="src.score >= 0.7 ? 'text-green-400 bg-green-500/10' : src.score >= 0.4 ? 'text-yellow-400 bg-yellow-500/10' : 'text-zinc-400 bg-zinc-700/50'"
              >
                {{ Math.round(src.score * 100) }}%
              </span>
            </div>
            <p class="text-[11px] text-zinc-400 line-clamp-2">
              {{ src.text }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- User avatar -->
    <div
      v-if="isUser"
      class="w-8 h-8 hidden rounded-full md:flex items-center justify-center text-xs font-medium shrink-0 mt-0.5 bg-linear-to-br from-blue-500 to-blue-700 text-white shadow-sm ring-1 ring-white/10"
    >
      U
    </div>
  </div>
</template>

<style>
/* ── Heading hierarchy ── */
.msg-markdown h1 {
  font-size: 1.5rem;
  line-height: 2rem;
  font-weight: 700;
  margin-top: 1.5rem;
  margin-bottom: 0.75rem;
  letter-spacing: -0.025em;
}
.msg-markdown h2 {
  font-size: 1.25rem;
  line-height: 1.75rem;
  font-weight: 700;
  margin-top: 1.25rem;
  margin-bottom: 0.5rem;
  letter-spacing: -0.025em;
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
  padding: 0;
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

[data-theme="light"] .msg-markdown :not(pre) > code {
  background: rgba(229, 231, 235, 0.6);
  color: #2563eb;
}

/* ── Spacing ── */
.msg-markdown p { margin: 0.5rem 0; }
.msg-markdown ul, .msg-markdown ol { margin: 0.5rem 0; }
.msg-markdown li { margin: 0.125rem 0; }
.msg-markdown strong { color: rgba(244, 244, 245, 1); }

[data-theme="light"] .msg-markdown strong { color: rgba(24, 24, 27, 1); }

/* ── Code block wrapper ── */
.code-block-wrapper {
  position: relative;
  margin: 0.75rem 0;
}

.code-header {
  display: flex;
  align-items: center;
  padding: 0.375rem 1rem;
  font-size: 0.75rem;
  color: rgba(161, 161, 170, 0.8);
  background: rgba(24, 24, 27, 0.9);
  border: 1px solid rgba(63, 63, 70, 0.5);
  border-bottom: none;
  border-radius: 0.5rem 0.5rem 0 0;
  user-select: none;
}

.code-header + pre {
  margin-top: 0 !important;
  border-top-left-radius: 0 !important;
  border-top-right-radius: 0 !important;
}

[data-theme="light"] .code-header {
  background: rgba(246, 248, 250, 0.95);
  border-color: rgba(209, 213, 219, 0.5);
  color: rgba(107, 114, 128, 0.9);
}
</style>
