<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import ProviderSettings from '../../components/settings/ProviderSettings.vue'
import MemorySettings from '../../components/settings/MemorySettings.vue'
import ChatSettings from '../../components/settings/ChatSettings.vue'
import SpeechToTextSettings from '../../components/settings/SpeechToTextSettings.vue'
import GeneralSettings from '../../components/settings/AppearanceSettings.vue'
import DesktopSettings from '../../components/settings/DesktopSettings.vue'
import BackupSettings from '../../components/settings/BackupSettings.vue'
import ResetDataSettings from '../../components/settings/ResetDataSettings.vue'
import AboutSettings from '../../components/settings/AboutSettings.vue'
import ResponsiveSectionLayout from '../../components/shared/ResponsiveSectionLayout.vue'
import ModalDialog from '../../components/shared/ModalDialog.vue'
import ChannelsView from '../triggers/ChannelsView.vue'

type SettingsCategoryId = 'providers' | 'memory' | 'chat' | 'speech-to-text' | 'channels' | 'general' | 'desktop-application' | 'backup' | 'reset-data' | 'about'

interface SettingsCategory {
  id: SettingsCategoryId
  label: string
  description: string
  icon: string
  component: unknown
  componentProps?: Record<string, unknown>
}

interface SettingsSection {
  id: string
  categoryId: SettingsCategoryId
  label: string
  description: string
  terms: string[]
}

const route = useRoute()
const router = useRouter()

const searchInputRef = ref<HTMLInputElement | null>(null)
const settingsPanelRef = ref<HTMLElement | null>(null)
const mobileDetailOpen = ref(false)
const dirtySources = ref<Record<string, boolean>>({})
const showDiscardConfirm = ref(false)
let pendingDiscardAction: (() => unknown | Promise<unknown>) | null = null
let allowRouteLeave = false

const hasUnsavedChanges = computed(() => Object.values(dirtySources.value).some(Boolean))
const isElectronBuild = Boolean((window as unknown as { electron?: unknown }).electron)

const categories: SettingsCategory[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Manage your profile, appearance, chat display preferences, and setup guide access.',
    icon: 'lucide:sliders-horizontal',
    component: GeneralSettings
  },
  {
    id: 'chat',
    label: 'Chat',
    description: 'Control generated titles, quick responses, and context handling for conversations.',
    icon: 'lucide:message-square',
    component: ChatSettings
  },
  {
    id: 'memory',
    label: 'Memory',
    description: 'Tune embeddings, Deep Research, reranking, chunking, and vector storage.',
    icon: 'lucide:brain',
    component: MemorySettings
  },
  {
    id: 'speech-to-text',
    label: 'Voice',
    description: 'Manage voice input, Whisper model downloads, language, quantization, and microphone selection.',
    icon: 'lucide:mic',
    component: SpeechToTextSettings
  },
  {
    id: 'providers',
    label: 'Providers',
    description: 'Configure AI providers, API keys, base URLs, default models, and connection tests.',
    icon: 'lucide:cpu',
    component: ProviderSettings
  },
  {
    id: 'channels',
    label: 'Channels',
    description: 'Connect Telegram, Discord, and Slack so agents can respond from messaging platforms.',
    icon: 'lucide:radio',
    component: ChannelsView,
    componentProps: { embedded: true }
  },
  {
    id: 'backup',
    label: 'Backup & Restore',
    description: 'Export your configuration as a zip file or restore from a previous backup.',
    icon: 'lucide:archive',
    component: BackupSettings
  },
  {
    id: 'reset-data',
    label: 'Reset Data',
    description: 'Clear selected data areas, derived indexes, or the whole local workspace.',
    icon: 'lucide:trash-2',
    component: ResetDataSettings
  },
  {
    id: 'about',
    label: 'About',
    description: 'View the installed Cynosure version and manage desktop app updates.',
    icon: 'lucide:info',
    component: AboutSettings
  },
  ...(isElectronBuild ? [{
    id: 'desktop-application' as const,
    label: 'Desktop Application',
    description: 'Configure Electron desktop integration, shortcuts, and background behavior.',
    icon: 'lucide:monitor-cog',
    component: DesktopSettings
  }] : [])
]

const sections: SettingsSection[] = [
  {
    id: 'user-profile',
    categoryId: 'general',
    label: 'User Profile',
    description: 'Set your name and profile image.',
    terms: ['name', 'user name', 'profile', 'identity', 'smart tag', 'username', 'avatar', 'profile image', 'user image']
  },
  ...(isElectronBuild ? [{
    id: 'global-hotkey',
    categoryId: 'desktop-application' as const,
    label: 'New Chat Shortcut',
    description: 'Choose the global keyboard shortcut that opens a fresh empty chat in a compact window near the mouse cursor.',
    terms: ['desktop', 'electron', 'global hotkey', 'keyboard shortcut', 'new chat', 'main window', 'ctrl space', 'compact window']
  }] : []),
  {
    id: 'provider-actions',
    categoryId: 'providers',
    label: 'Provider management',
    description: 'Add, edit, test, remove, and configure LLM providers.',
    terms: ['ai', 'llm', 'provider', 'providers', 'add provider', 'edit provider', 'remove provider', 'test connection', 'api key', 'base url', 'default model', 'models', 'openai', 'anthropic', 'google', 'gemini', 'grok', 'lm studio', 'ollama', 'openrouter', 'requesty', 'groq', 'mistral']
  },
  {
    id: 'embedding-model',
    categoryId: 'memory',
    label: 'Embedding Model',
    description: 'Select the provider, model, and dimensions used for vector embeddings.',
    terms: ['embedding', 'embeddings', 'embedding model', 'embedding provider', 'dimensions', 'detect dimensions', 'vector', 'mxbai', 're embed', 'drop vectors']
  },
  {
    id: 'reranker',
    categoryId: 'memory',
    label: 'Retrieval Reranker',
    description: 'Configure OpenRouter reranking for memory retrieval candidates.',
    terms: ['reranker', 'reranking', 'retrieval', 'candidate pool', 'cohere', 'openrouter', 'rank', 'relevance']
  },
  {
    id: 'chunking',
    categoryId: 'memory',
    label: 'Chunking',
    description: 'Control document chunk size and overlap before embedding.',
    terms: ['chunking', 'chunk size', 'chunk overlap', 'tokens', 'documents', 'split documents']
  },
  {
    id: 'generated-titles',
    categoryId: 'chat',
    label: 'Generate Chat Titles',
    description: 'Generate a descriptive title as a pre-response action on the first turn.',
    terms: ['generate chat titles', 'titles', 'chat titles', 'conversation titles', 'title model', 'pre-response action']
  },
  {
    id: 'quick-responses',
    categoryId: 'chat',
    label: 'Quick Responses',
    description: 'Suggest relevant follow-up messages after each assistant turn.',
    terms: ['quick responses', 'suggestions', 'follow-up', 'follow up', 'post-turn action', 'experimental']
  },
  {
    id: 'dream-mode',
    categoryId: 'memory',
    label: 'Dream Mode',
    description: 'Review Free Chat and opted-in agent conversations to learn and update memory in the background.',
    terms: ['dream', 'dreaming', 'background', 'learn', 'remember', 'conversations']
  },
  {
    id: 'deep-research',
    categoryId: 'memory',
    label: 'Deep Research Model',
    description: 'Provider and model used when Deep Research creates grounded knowledge and relationships.',
    terms: ['knowledge graph', 'Deep Research', 'Deep Research', 'relationships', 'relation extraction', 'knowledge graph', 'document indexing']
  },
  {
    id: 'context-strategy',
    categoryId: 'chat',
    label: 'Context Strategy',
    description: 'Manage conversation history when it exceeds the context window.',
    terms: ['context strategy', 'context window', 'sliding window', 'truncate middle', 'compact', 'summarize', 'summarization', 'no trimming', 'conversation history']
  },
  {
    id: 'attachment-context',
    categoryId: 'chat',
    label: 'Attachment Context',
    description: 'Choose when document attachments switch from inline context to retrieval.',
    terms: ['attachment context', 'attachments', 'attached files', 'documents', 'inline attachment', 'rag', 'retrieval', 'file context', 'screenshots']
  },
  {
    id: 'debug-mode',
    categoryId: 'chat',
    label: 'Debug Mode',
    description: 'Capture the complete model-visible context for inspection in chat.',
    terms: ['debug mode', 'context inspector', 'full context', 'system prompt', 'memories', 'tools', 'thinking', 'llm request', 'developer tools']
  },
  {
    id: 'enable-voice',
    categoryId: 'speech-to-text',
    label: 'Enable Voice Input',
    description: 'Show the microphone button in the chat input bar.',
    terms: ['enable voice', 'voice input', 'microphone button', 'mic button', 'speech input', 'enable microphone']
  },
  {
    id: 'transcription-engine',
    categoryId: 'speech-to-text',
    label: 'Transcription Engine',
    description: 'Choose local Whisper or a remote transcription model for voice input.',
    terms: ['transcription engine', 'remote transcription', 'local whisper', 'speech to text provider', 'voice provider', 'stt model']
  },
  {
    id: 'voice-model',
    categoryId: 'speech-to-text',
    label: 'Model & Quantization',
    description: 'Choose the Whisper model and quantization used for transcription.',
    terms: ['whisper', 'model', 'quantization', 'q4', 'q8', 'fp16', 'fp32', 'tiny', 'base', 'small', 'large', 'transcription']
  },
  {
    id: 'voice-language',
    categoryId: 'speech-to-text',
    label: 'Language',
    description: 'Language used for speech recognition.',
    terms: ['language', 'speech recognition language', 'english', 'german', 'french', 'spanish', 'automatic language']
  },
  {
    id: 'microphone',
    categoryId: 'speech-to-text',
    label: 'Microphone',
    description: 'Select which microphone to use for voice input.',
    terms: ['microphone', 'mic', 'input device', 'audio input', 'device']
  },
  {
    id: 'download-cache',
    categoryId: 'speech-to-text',
    label: 'Download & Cache',
    description: 'Download the Whisper model and manage cached models.',
    terms: ['download', 'cache', 'clear cache', 'cached models', 'hugging face', 'transformers', 'model ready']
  },
  {
    id: 'voice-help',
    categoryId: 'speech-to-text',
    label: 'How it works',
    description: 'Learn how local Whisper transcription works.',
    terms: ['how it works', 'local', 'browser', 'web worker', 'webassembly', 'privacy', 'audio data']
  },
  {
    id: 'channel-management',
    categoryId: 'channels',
    label: 'Channel Management',
    description: 'Add, edit, test, enable, disable, and remove messaging channels.',
    terms: ['channels', 'channel', 'messaging', 'telegram', 'discord', 'slack', 'bot token', 'app token', 'socket mode', 'message content intent', 'allowed agents', 'remote agents']
  },
  {
    id: 'theme',
    categoryId: 'general',
    label: 'Theme',
    description: 'Choose your visual style.',
    terms: ['theme', 'themes', 'visual style', 'dark', 'light', 'virtualboy', 'scanlines', 'crimson', 'red', 'glyphs', 'gold', 'green', 'cyberpunk', 'emerald', 'industrial', 'amber', 'monochrome', 'palette', 'appearance']
  },
  {
    id: 'auto-expand-thinking',
    categoryId: 'general',
    label: 'Auto-expand Thinking',
    description: 'Automatically expand thinking and reasoning blocks.',
    terms: ['auto expand thinking', 'thinking', 'reasoning', 'reasoning blocks', 'expand steps']
  },
  {
    id: 'auto-expand-tool-calls',
    categoryId: 'general',
    label: 'Auto-expand Tool Calls',
    description: 'Automatically expand tool call details in chat.',
    terms: ['auto expand tool calls', 'tool calls', 'tool details', 'expand tools']
  },
  {
    id: 'setup-guide',
    categoryId: 'general',
    label: 'Setup Guide',
    description: 'Re-run onboarding to configure providers, memory, and MCPs.',
    terms: ['setup guide', 'onboarding', 'redo setup', 'configure providers', 'memory', 'mcps']
  },
  {
    id: 'backup-export',
    categoryId: 'backup',
    label: 'Export Backup',
    description: 'Download your configuration as a zip file.',
    terms: ['backup', 'export', 'download', 'zip', 'agents', 'providers', 'settings', 'conversations', 'memory folders']
  },
  {
    id: 'backup-import',
    categoryId: 'backup',
    label: 'Import & Restore',
    description: 'Restore from a previous backup zip file.',
    terms: ['backup', 'import', 'restore', 'upload', 'zip']
  },
  {
    id: 'reset-data',
    categoryId: 'reset-data',
    label: 'Reset Data',
    description: 'Permanently delete selected data areas or return Cynosure to a clean state.',
    terms: ['reset', 'factory reset', 'wipe', 'delete all', 'clean state', 'start over', 'clear data', 'partial reset', 'memory reset', 'knowledge', 'clear knowledge', 'relationships', 'entities', 'clear vector database', 'vector indexes', 'vectors', 'delete embeddings', 'drop vectors']
  },
  {
    id: 'about',
    categoryId: 'about',
    label: 'About Cynosure',
    description: 'View the current version and check, download, or install desktop updates.',
    terms: ['about', 'version', 'update', 'updates', 'upgrade', 'download update', 'install update', 'up to date']
  }
]

const categoryIds = new Set(categories.map((category) => category.id))
const sectionsByCategory = computed(() => {
  const result = new Map<SettingsCategoryId, SettingsSection[]>()
  for (const category of categories) result.set(category.id, [])
  for (const section of sections) result.get(section.categoryId)?.push(section)
  return result
})

const searchQuery = computed({
  get: () => String(route.query.search || ''),
  set: (value: string) => {
    const updateSearch = () => router.replace({
      query: { ...route.query, search: value.trim() ? value : undefined }
    })
    if (hasUnsavedChanges.value && !isSearching.value && value.trim()) {
      requestDiscard(updateSearch)
      return
    }
    updateSearch()
  }
})

const activeCategoryId = computed<SettingsCategoryId>(() => {
  const category = route.query.category
  return typeof category === 'string' && categoryIds.has(category as SettingsCategoryId)
    ? category as SettingsCategoryId
    : 'general'
})

const normalizedSearch = computed(() => normalize(searchQuery.value))
const isSearching = computed(() => normalizedSearch.value.length > 0)

const matchingSections = computed(() => {
  if (!isSearching.value) return sections

  return sections
    .map((section) => ({
      section,
      score: scoreSection(section, normalizedSearch.value)
    }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.section.label.localeCompare(b.section.label))
    .map((result) => result.section)
})

const visibleCategoryGroups = computed(() => {
  const visibleCategories = isSearching.value
    ? categories
    : categories.filter((category) => category.id === activeCategoryId.value)

  return visibleCategories
    .map((category) => {
      const visibleSections = isSearching.value
        ? matchingSections.value.filter((section) => section.categoryId === category.id)
        : sectionsByCategory.value.get(category.id) || []

      return {
        category,
        visibleSections,
        visibleSectionIds: isSearching.value ? visibleSections.map((section) => section.id) : []
      }
    })
    .filter((group) => group.visibleSections.length > 0)
})

const resultCountLabel = computed(() => {
  const count = matchingSections.value.length
  if (!isSearching.value) return ''
  return `${count} matching setting${count === 1 ? '' : 's'}`
})

const matchCountByCategory = computed(() => {
  const counts = new Map<SettingsCategoryId, number>()
  if (!isSearching.value) return counts
  for (const section of matchingSections.value) {
    counts.set(section.categoryId, (counts.get(section.categoryId) ?? 0) + 1)
  }
  return counts
})

watch(activeCategoryId, (category) => {
  if (route.query.category === category) return
  router.replace({ query: { ...route.query, category } })
}, { immediate: true })

onMounted(() => {
  document.addEventListener('keydown', onGlobalKeydown)
  window.addEventListener('beforeunload', onBeforeUnload)
  if (typeof route.query.category === 'string') {
    scrollToCategory(activeCategoryId.value)
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeydown)
  window.removeEventListener('beforeunload', onBeforeUnload)
})

function selectCategory(category: SettingsCategoryId): void {
  if (category === activeCategoryId.value && !isSearching.value) return
  requestDiscard(async () => {
    mobileDetailOpen.value = true
    await router.replace({
      query: {
        ...route.query,
        category,
        channel: category === 'channels' ? route.query.channel : undefined,
        search: undefined
      }
    })
    scrollToCategory(category)
  })
}

async function scrollToCategory(category: SettingsCategoryId): Promise<void> {
  await nextTick()
  document.getElementById(`settings-${category}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function clearSearch(): void {
  requestDiscard(() => { searchQuery.value = '' })
}

function categoryButtonClass(id: SettingsCategoryId): string {
  if (!isSearching.value) {
    return activeCategoryId.value === id
      ? 'bg-theme-800 text-theme-100 shadow-[inset_3px_0_0_var(--color-accent-500,#3b82f6)]'
      : 'text-theme-400 hover:bg-theme-800/70 hover:text-theme-200'
  }
  return matchCountByCategory.value.get(id)
    ? 'text-theme-300 hover:bg-theme-800/70 hover:text-theme-200'
    : 'opacity-40 text-theme-600 pointer-events-none'
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes((event.target as Element).tagName)) {
    event.preventDefault()
    searchInputRef.value?.focus()
  }
  if (event.key === 'Escape') {
    const owningDialog = (event.target as Element | null)?.closest?.('[role="dialog"]')
    if (owningDialog && owningDialog !== settingsPanelRef.value) return
    if (isSearching.value) {
      clearSearch()
      searchInputRef.value?.blur()
    } else {
      closeSettings()
    }
  }
}

function closeSettings(): void {
  requestDiscard(() => {
    allowRouteLeave = true
    const previousPath = window.history.state?.back
    const canReturn = typeof previousPath === 'string'
      && previousPath.startsWith('/')
      && !previousPath.startsWith('/settings')
    return router.push(canReturn ? previousPath : '/chat')
  })
}

function setDirtySource(category: SettingsCategoryId, dirty: boolean): void {
  dirtySources.value = { ...dirtySources.value, [category]: dirty }
}

function requestDiscard(action: () => unknown | Promise<unknown>): void {
  if (!hasUnsavedChanges.value) {
    void action()
    return
  }
  pendingDiscardAction = action
  showDiscardConfirm.value = true
}

function keepEditing(): void {
  pendingDiscardAction = null
  showDiscardConfirm.value = false
}

function discardChanges(): void {
  const action = pendingDiscardAction
  pendingDiscardAction = null
  showDiscardConfirm.value = false
  dirtySources.value = {}
  if (action) void action()
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!hasUnsavedChanges.value) return
  event.preventDefault()
  event.returnValue = ''
}

onBeforeRouteLeave((to) => {
  if (allowRouteLeave || !hasUnsavedChanges.value) return true
  requestDiscard(() => {
    allowRouteLeave = true
    return router.push(to.fullPath)
  })
  return false
})

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function acronym(value: string): string {
  return normalize(value)
    .split(' ')
    .filter(Boolean)
    .map((word) => word[0])
    .join('')
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true
  let index = 0
  for (const char of haystack) {
    if (char === needle[index]) index += 1
    if (index === needle.length) return true
  }
  return false
}

function scoreText(query: string, text: string, allowSubsequence = true): number {
  const normalizedText = normalize(text)
  if (!normalizedText) return 0
  if (normalizedText === query) return 160
  if (normalizedText.startsWith(query)) return 130
  if (normalizedText.includes(query)) return 110

  const queryTokens = query.split(' ').filter(Boolean)
  const textTokens = normalizedText.split(' ').filter(Boolean)
  const tokenMatches = queryTokens.filter((queryToken) =>
    textTokens.some((textToken) => textToken.startsWith(queryToken) || isSubsequence(queryToken, textToken))
  )

  if (tokenMatches.length === queryTokens.length) return 85 + tokenMatches.length
  if (acronym(normalizedText).startsWith(query.replace(/\s/g, ''))) return 70
  if (allowSubsequence && query.length >= 3 && isSubsequence(query.replace(/\s/g, ''), normalizedText.replace(/\s/g, ''))) return 35
  return 0
}

function scoreSection(section: SettingsSection, query: string): number {
  const category = categories.find((item) => item.id === section.categoryId)

  // Labels and terms use full fuzzy scoring (including global subsequence)
  const preciseTargets = [
    section.label,
    category?.label || '',
    ...section.terms
  ]

  // Long descriptions: exact/prefix/token only — no global subsequence (too many false positives)
  const broadTargets = [
    section.description
  ]

  return Math.max(
    ...preciseTargets.map((text) => scoreText(query, text, true)),
    ...broadTargets.map((text) => scoreText(query, text, false))
  )
}
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-150 flex items-center justify-center bg-black/65 p-2 backdrop-blur-sm sm:p-5"
      @click.self="closeSettings"
    >
      <section
        ref="settingsPanelRef"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        class="relative h-full max-h-[80vh] w-full max-w-7xl overflow-hidden rounded-2xl border border-theme-700 bg-theme-950 shadow-2xl"
      >
        <ResponsiveSectionLayout
          :detail-open="mobileDetailOpen"
          mobile-back-label="All settings"
          @back="mobileDetailOpen = false"
        >
          <template #sidebar>
            <header class="p-4">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <h1 class="text-2xl font-bold text-theme-100">
                    Settings
                  </h1>
                  <p class="mt-1 text-sm leading-relaxed text-theme-500">
                    Configure Cynosure, AI behavior, and your workspace.
                  </p>
                </div>
                <button
                  type="button"
                  class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-theme-700 bg-theme-900/90 text-theme-400 transition hover:bg-theme-800 hover:text-theme-100 lg:hidden"
                  aria-label="Close settings"
                  @click="closeSettings"
                >
                  <Icon
                    icon="lucide:x"
                    class="h-4 w-4"
                  />
                </button>
              </div>
            </header>
            <nav class="space-y-1 p-4">
              <template
                v-for="category in categories"
                :key="category.id"
              >
                <div
                  v-if="category.id === 'desktop-application'"
                  class="my-3 border-t border-theme-800"
                  aria-hidden="true"
                />
                <button
                  class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-all"
                  :class="categoryButtonClass(category.id)"
                  @click="selectCategory(category.id)"
                >
                  <Icon
                    :icon="category.icon"
                    class="h-4.5 w-4.5 shrink-0"
                  />
                  <span class="whitespace-nowrap">{{ category.label }}</span>
                  <span class="ml-auto flex items-center gap-2">
                    <span
                      v-if="isSearching && matchCountByCategory.get(category.id)"
                      class="rounded-full bg-accent-600/20 px-1.5 py-0.5 text-[10px] font-medium leading-none text-accent-400"
                    >
                      {{ matchCountByCategory.get(category.id) }}
                    </span>
                    <Icon
                      icon="lucide:chevron-right"
                      class="h-4 w-4 text-theme-600 lg:hidden"
                    />
                  </span>
                </button>
              </template>
            </nav>
          </template>

          <main class="h-full min-w-0 overflow-y-auto">
            <!-- Sticky search bar -->
            <div class="sticky top-0 z-10 border-b border-theme-800/60 bg-theme-950/95 backdrop-blur-sm px-4 py-3 sm:px-6 lg:px-8">
              <div class="mx-auto flex max-w-5xl items-start gap-2">
                <div class="min-w-0 flex-1">
                  <div class="relative">
                    <Icon
                      icon="lucide:search"
                      class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-500"
                    />
                    <input
                      ref="searchInputRef"
                      v-model="searchQuery"
                      type="text"
                      placeholder="Search settings..."
                      class="w-full rounded-lg border border-theme-700 bg-theme-900/80 px-9 py-2.5 text-sm text-theme-100 placeholder-theme-600 outline-none transition focus:border-accent-500 focus:ring-1 focus:ring-accent-500"
                    >
                    <kbd
                      v-if="!isSearching"
                      class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 hidden lg:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono text-theme-600 bg-theme-800 border border-theme-700 rounded"
                    >
                      /
                    </kbd>
                    <button
                      v-if="isSearching"
                      class="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-theme-500 transition hover:bg-theme-800 hover:text-theme-200"
                      type="button"
                      aria-label="Clear settings search"
                      @click="clearSearch"
                    >
                      <Icon
                        icon="lucide:x"
                        class="h-4 w-4"
                      />
                    </button>
                  </div>
                  <p
                    v-if="isSearching"
                    class="mt-2 text-xs text-theme-500"
                  >
                    {{ resultCountLabel }}
                  </p>
                </div>
                <button
                  type="button"
                  class="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg border border-theme-700 bg-theme-900/90 text-theme-400 shadow-sm transition hover:bg-theme-800 hover:text-theme-100"
                  aria-label="Close settings"
                  @click="closeSettings"
                >
                  <Icon
                    icon="lucide:x"
                    class="h-4 w-4"
                  />
                </button>
              </div>
            </div>

            <div class="mx-auto max-w-5xl px-4 pt-6 pb-8 sm:px-6 lg:px-8">
              <div
                v-if="visibleCategoryGroups.length === 0"
                class="rounded-xl border border-theme-800 bg-theme-900/50 px-5 py-10 text-center"
              >
                <Icon
                  icon="lucide:search-x"
                  class="mx-auto h-8 w-8 text-theme-600"
                />
                <h2 class="mt-3 text-sm font-semibold text-theme-200">
                  No settings found
                </h2>
                <p class="mt-1 text-sm text-theme-500">
                  Try a different term or clear the search.
                </p>
              </div>

              <div
                v-else
                class="space-y-10"
              >
                <section
                  v-for="{ category, visibleSectionIds } in visibleCategoryGroups"
                  :id="`settings-${category.id}`"
                  :key="category.id"
                  class="scroll-mt-4"
                >
                  <div class="mb-5 flex items-start gap-3">
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-theme-900 text-theme-400 ring-1 ring-theme-800">
                      <Icon
                        :icon="category.icon"
                        class="h-5 w-5"
                      />
                    </div>
                    <div class="min-w-0">
                      <h2 class="text-xl font-bold text-theme-100">
                        {{ category.label }}
                      </h2>
                      <p class="mt-1 text-sm leading-relaxed text-theme-500">
                        {{ category.description }}
                      </p>
                    </div>
                  </div>

                  <component
                    :is="category.component"
                    :visible-sections="visibleSectionIds"
                    v-bind="category.componentProps || {}"
                    @dirty-change="setDirtySource(category.id, $event)"
                  />
                </section>
              </div>
            </div>
          </main>
        </ResponsiveSectionLayout>
      </section>
    </div>
  </Teleport>

  <ModalDialog
    :show="showDiscardConfirm"
    title="Discard unsaved changes?"
    icon="lucide:triangle-alert"
    icon-color="amber"
    layer="nested"
    @close="keepEditing"
  >
    <p class="text-sm leading-relaxed text-theme-400">
      Some grouped settings have not been saved. Discard them and continue?
    </p>
    <template #actions>
      <button
        type="button"
        class="w-full rounded-xl bg-red-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-red-500"
        @click="discardChanges"
      >
        Discard changes
      </button>
      <button
        type="button"
        class="w-full rounded-xl bg-theme-800 px-4 py-3 text-sm font-medium text-theme-200 transition hover:bg-theme-700"
        @click="keepEditing"
      >
        Keep editing
      </button>
    </template>
  </ModalDialog>
</template>
