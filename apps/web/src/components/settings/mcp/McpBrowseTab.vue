<script setup lang="ts">
import { ref, reactive, watch, onMounted, computed } from 'vue'
import { api } from '../../../api/client'
import type { McpRegistryServer } from '../../../api/types'
import { Icon } from '@iconify/vue'
import { useMcpServers } from '../../../composables/useMcpServers'

const emit = defineEmits<{
  goToInstalled: []
}>()

const { servers, actionError, isLoading, setLoading, authInProgress, refreshAll } = useMcpServers()

const registryServers = ref<McpRegistryServer[]>([])
const registrySearch = ref('')
const registrySource = ref<'recommended' | 'official' | 'smithery'>('recommended')
const selectedRegistryServer = ref<McpRegistryServer | null>(null)
const registryPage = ref(1)
const registryPageCursors = ref<Array<string | undefined>>([undefined])
const registryNextCursor = ref<string | undefined>(undefined)
const registryResultCount = ref(0)
const registryLoading = ref(false)
const addingRegistryId = ref<string | null>(null)
const registryEnv = reactive<Record<string, string>>({})
const selectedCategory = ref('all')
const viewMode = ref<'grid' | 'list'>('grid')
const catalogRef = ref<HTMLElement | null>(null)

type RegistryRow = McpRegistryServer & { id: string }
type InstallInfo = {
  kind: 'local' | 'remote'
  command: string
  args: string[]
  argEnvNames: Set<string>
  envVars: { name: string; description?: string; required: boolean }[]
}

const registryRows = computed<RegistryRow[]>(() =>
  registryServers.value.map(entry => ({
    ...entry,
    id: entryId(entry.server),
  }))
)
const registryHasPrevious = computed(() => registryPage.value > 1)
const registryHasNext = computed(() => Boolean(registryNextCursor.value))

type RegistrySource = {
  id: 'recommended' | 'official' | 'smithery'
  label: string
  detail: string
  icon: string
  badge?: string
}

const registrySources: RegistrySource[] = [
  { id: 'recommended', label: 'Recommended', detail: 'Curated by Cynosure', icon: 'lucide:star', badge: 'Curated' },
  { id: 'official', label: 'Official', detail: 'MCP Registry', icon: 'lucide:badge-check' },
  { id: 'smithery', label: 'Smithery', detail: 'smithery.ai', icon: 'lucide:sparkles' },
]

const categories = [
  { id: 'all', label: 'All', icon: 'lucide:layout-grid' },
  { id: 'productivity', label: 'Productivity', icon: 'lucide:briefcase-business' },
  { id: 'development', label: 'Development', icon: 'lucide:code-2' },
  { id: 'files', label: 'Files & System', icon: 'lucide:folder' },
  { id: 'web', label: 'Web & Data', icon: 'lucide:globe-2' },
  { id: 'media', label: 'Media', icon: 'lucide:play' },
  { id: 'ai', label: 'AI & LLM', icon: 'lucide:sparkles' },
  { id: 'communication', label: 'Communication', icon: 'lucide:messages-square' },
  { id: 'utilities', label: 'Utilities', icon: 'lucide:wrench' },
] as const

const visibleRegistryRows = computed(() => selectedCategory.value === 'all'
  ? registryRows.value
  : registryRows.value.filter(item => getCategory(item.server) === selectedCategory.value))

let searchTimer: ReturnType<typeof setTimeout> | null = null
let currentAbortController: AbortController | null = null

function resetRegistry(): void {
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null }
  currentAbortController?.abort()
  registryServers.value = []
  registryPage.value = 1
  registryPageCursors.value = [undefined]
  registryNextCursor.value = undefined
  registryResultCount.value = 0
}

watch(registrySearch, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    resetRegistry()
    loadRegistry()
  }, 400)
})

watch(registrySource, () => {
  selectedCategory.value = 'all'
  resetRegistry()
  loadRegistry()
})

async function loadRegistry(page = 1, cursor?: string): Promise<void> {
  currentAbortController?.abort()
  currentAbortController = new AbortController()
  const { signal } = currentAbortController

  registryLoading.value = true
  try {
    const data = await api.mcp.searchRegistry({
      search: registrySearch.value || undefined,
      cursor,
      limit: registrySource.value === 'smithery' ? 12 : 20,
      registry: registrySource.value,
      signal,
    })
    if (signal.aborted) return
    registryServers.value = data.servers
    registryResultCount.value = data.metadata.count
    registryPage.value = page
    registryPageCursors.value[page - 1] = cursor
    registryPageCursors.value = registryPageCursors.value.slice(0, page)
    registryNextCursor.value = data.metadata.nextCursor
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return
    registryNextCursor.value = undefined
  } finally {
    if (!signal.aborted) registryLoading.value = false
  }
}

function loadNextRegistryPage(): void {
  if (!registryNextCursor.value || registryLoading.value) return
  loadRegistry(registryPage.value + 1, registryNextCursor.value)
}

function loadPreviousRegistryPage(): void {
  if (!registryHasPrevious.value || registryLoading.value) return
  const previousPage = registryPage.value - 1
  loadRegistry(previousPage, registryPageCursors.value[previousPage - 1])
}

function entryId(srv: McpRegistryServer['server']): string {
  return `${srv.name}@${srv.version}`
}

function getDisplayName(srv: McpRegistryServer['server']): string {
  return srv.title || srv.name.split('/').pop() || srv.name
}

function stripPackageVersion(identifier: string): string {
  const versionAtIndex = identifier.indexOf('@', identifier.startsWith('@') ? 1 : 0)
  return versionAtIndex === -1 ? identifier : identifier.slice(0, versionAtIndex)
}

function packageIdentifiersMatch(a: string, b: string): boolean {
  return a === b || stripPackageVersion(a) === stripPackageVersion(b)
}

function headerEnvName(header: string): string {
  return `MCP_HEADER_${header.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'VALUE'}`
}

function getInstallInfo(srv: McpRegistryServer['server']): InstallInfo | null {
  const remote = srv.remotes?.find(r => /^https?:\/\//.test(r.url) && (r.type === 'streamable-http' || r.type === 'http'))
  if (remote) {
    const envVars = (remote.headers || []).map(header => {
      const name = headerEnvName(header.name)
      return {
        name,
        description: header.description || `Value for ${header.name}`,
        required: header.isRequired,
      }
    })
    return {
      kind: 'remote',
      command: 'remote',
      args: [
        '--transport',
        'streamable-http',
        '--url',
        remote.url,
        ...(remote.headers || []).map(header => `--header-env=${header.name}=${headerEnvName(header.name)}`),
      ],
      argEnvNames: new Set(),
      envVars,
    }
  }

  const pkg = srv.packages?.find(p => p.transport?.type === 'stdio' || p.registryType === 'smithery')
  if (pkg) {
    const packageArgs = (pkg.arguments || []).map(arg => arg.fromEnv ? `\${${arg.fromEnv}}` : (arg.value || '')).filter(Boolean)
    const argEnvNames = new Set((pkg.arguments || []).map(arg => arg.fromEnv).filter((name): name is string => Boolean(name)))
    const envVars = (pkg.environmentVariables || []).map(v => ({
      name: v.name,
      description: v.description,
      required: v.isRequired,
    }))
    if (pkg.registryType === 'smithery') return { kind: 'local', command: 'npx', args: ['-y', '@smithery/cli@latest', 'run', pkg.identifier, ...packageArgs], argEnvNames, envVars }
    if (pkg.registryType === 'npm') return { kind: 'local', command: 'npx', args: ['-y', pkg.identifier, ...packageArgs], argEnvNames, envVars }
    if (pkg.registryType === 'pypi') return { kind: 'local', command: 'uvx', args: [pkg.identifier, ...packageArgs], argEnvNames, envVars }
  }
  return null
}

function getTypeTags(srv: McpRegistryServer['server']): string[] {
  const tags = new Set<string>()
  const install = getInstallInfo(srv)
  const pkg = srv.packages?.find(p => p.transport?.type === 'stdio' || p.registryType === 'smithery')

  if (install?.kind === 'remote') tags.add('remote')
  if (pkg?.registryType === 'smithery') tags.add('smithery')
  else if (pkg?.registryType === 'npm') tags.add('npm')
  else if (pkg?.registryType === 'pypi') tags.add('pypi')
  else if (install?.command === 'npx') tags.add('npm')
  else if (install?.command === 'uvx') tags.add('pypi')

  if ((srv as { isLocal?: boolean }).isLocal) tags.add('local')
  if (srv.isRemote || (srv as { isRemote?: boolean }).isRemote || srv.remotes?.length) tags.add('remote')
  if (!install && !(srv as { isLocal?: boolean }).isLocal && !srv.isRemote) tags.add('remote only')

  return [...tags]
}

function getCategory(srv: McpRegistryServer['server']): string {
  const haystack = `${srv.name} ${srv.title || ''} ${srv.description || ''}`.toLowerCase()
  if (/mail|gmail|imap|slack|telegram|notification|message/.test(haystack)) return 'communication'
  if (/image|video|media|music|audio|webcam|youtube|chart|mermaid/.test(haystack)) return 'media'
  if (/file|document|sftp|ssh|terminal|computer|system/.test(haystack)) return 'files'
  if (/web|fetch|browser|weather|search|data/.test(haystack)) return 'web'
  if (/code|github|git|devtool|developer/.test(haystack)) return 'development'
  if (/ai|llm|stability|model/.test(haystack)) return 'ai'
  if (/clock|time|calendar|task|productiv/.test(haystack)) return 'productivity'
  return 'utilities'
}

function getCardTags(srv: McpRegistryServer['server']): string[] {
  const category = categories.find(item => item.id === getCategory(srv))?.label.toLowerCase() || 'utility'
  return [category, ...getTypeTags(srv)].slice(0, 3)
}

function getPublisher(): string {
  if (registrySource.value === 'recommended') return 'Cynosure'
  if (registrySource.value === 'official') return 'Official registry'
  return 'Smithery'
}

function selectSource(source: RegistrySource['id']): void {
  registrySource.value = source
}

function clearSearchAndFilters(): void {
  registrySearch.value = ''
  selectedCategory.value = 'all'
}

function browseRecommendations(): void {
  selectedCategory.value = 'all'
  catalogRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function addFromRegistry(srv: McpRegistryServer): Promise<void> {
  const install = getInstallInfo(srv.server)
  if (!install) return

  const id = entryId(srv.server)
  const requiredVars = install.envVars.filter(v => v.required)

  // Always show the configuration form on the first click if the server has any
  // env vars (required or optional). This gives users time to enter credentials
  // before the connection attempt starts instead of connecting immediately.
  if (install.envVars.length > 0 && addingRegistryId.value !== id) {
    addingRegistryId.value = id
    return
  }

  // Safety guard: don't connect if required vars are still empty
  if (requiredVars.some(v => !registryEnv[v.name])) {
    return
  }

  addingRegistryId.value = id
  setLoading(id, true)
  try {
    const env: Record<string, string> = {}
    for (const v of install.envVars) {
      if (registryEnv[v.name] && !install.argEnvNames.has(v.name)) env[v.name] = registryEnv[v.name]
    }
    const args = install.args.map(arg => {
      const match = arg.match(/^\$\{([^}]+)\}$/)
      return match ? registryEnv[match[1]] : arg
    })

    const pkgType = srv.server.packages?.[0]?.registryType || 'unknown'
    const originLabel = install.kind === 'remote'
      ? `${registrySource.value}:remote`
      : (pkgType === 'smithery' ? 'smithery.ai' : (pkgType === 'npm' ? 'npm' : (pkgType === 'pypi' ? 'pypi' : 'mcp-official')))
    const iconUrl = srv.server.icons?.[0]?.src || undefined

    const result = await api.mcp.addServer({
      originalName: getDisplayName(srv.server),
      command: install.command,
      args,
      env: Object.keys(env).length ? env : undefined,
      icon_url: iconUrl,
      origin: originLabel,
      env_hints: install.envVars.length ? install.envVars.map(v => ({
        name: v.name,
        description: v.description,
        required: v.required,
      })) : undefined,
    })

    // Server is always created in the DB, even if initial connection fails.
    // Switch to installed tab where the user can see connection status.
    delete actionError.value[id]
    addingRegistryId.value = null
    install.envVars.forEach(v => { registryEnv[v.name] = '' })
    emit('goToInstalled')

    if (result.error && result.pendingAuthUrl) {
      // Auth modal is triggered via the 'mcp-auth-needed' WebSocket event
      // in App.vue — user clicks "Open Authorization Page" to proceed.
      authInProgress.value = result.id
    }

    await refreshAll()
  } finally {
    setLoading(id, false)
  }
}

function cancelRegistryAdd(): void {
  addingRegistryId.value = null
  Object.keys(registryEnv).forEach(k => { registryEnv[k] = '' })
}

function isInstalled(srv: McpRegistryServer['server']): boolean {
  const install = getInstallInfo(srv)
  if (!install) return false
  const urlIdx = install.args.indexOf('--url')
  const identifier = urlIdx >= 0 ? install.args[urlIdx + 1] : install.args[install.args.length - 1]
  if (urlIdx >= 0) return servers.value.some(s => s.args.some(a => a === identifier))
  return servers.value.some(s => s.args.some(a => packageIdentifiersMatch(a, identifier)))
}

onMounted(() => {
  loadRegistry()
})
</script>

<template>
  <section
    class="space-y-4"
    aria-label="MCP server marketplace"
  >
    <div
      class="grid grid-cols-2 gap-2 lg:grid-cols-4"
      role="tablist"
      aria-label="Registry source"
    >
      <button
        v-for="source in registrySources"
        :key="source.id"
        type="button"
        role="tab"
        :aria-selected="registrySource === source.id"
        :data-source="source.id"
        class="group flex min-w-0 items-center gap-3 rounded-xl border px-4 py-3 text-left transition"
        :class="registrySource === source.id
          ? 'border-accent-500 bg-accent-500/8 shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent-500)_12%,transparent)]'
          : 'border-theme-800 bg-theme-900/55 hover:border-theme-700 hover:bg-theme-900'"
        @click="selectSource(source.id)"
      >
        <span
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          :class="registrySource === source.id ? 'bg-accent-500/15 text-accent-fg' : 'bg-theme-800 text-theme-400 group-hover:text-theme-200'"
        >
          <Icon
            :icon="source.icon"
            class="h-5 w-5"
          />
        </span>
        <span class="min-w-0">
          <span class="flex items-center gap-2 text-sm font-semibold text-theme-100">
            {{ source.label }}
            <span
              v-if="source.badge"
              class="rounded bg-accent-500 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-accent-on"
            >{{ source.badge }}</span>
          </span>
          <span class="block truncate text-[11px] text-theme-500">{{ source.detail }}</span>
        </span>
      </button>
    </div>

    <div class="relative">
      <Icon
        icon="lucide:search"
        class="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-500"
      />
      <input
        v-model="registrySearch"
        type="search"
        placeholder="Search MCP servers..."
        class="h-11 w-full rounded-xl border border-theme-800 bg-theme-900/65 pl-10 pr-4 text-sm text-theme-200 outline-none transition placeholder:text-theme-600 focus:border-accent-500/60 focus:ring-2 focus:ring-accent-500/10"
      >
    </div>

    <div
      v-if="registrySource === 'recommended' && !registrySearch"
      class="mcp-store-hero relative isolate overflow-hidden rounded-2xl border border-accent-500/20 px-5 py-6 sm:px-7"
    >
      <div class="relative z-10 max-w-xl">
        <p class="text-[10px] font-bold uppercase tracking-[0.16em] text-accent-fg">
          Featured
        </p>
        <h2 class="mt-2 text-xl font-bold text-theme-50 sm:text-2xl">
          Supercharge your workflow
        </h2>
        <p class="mt-1.5 text-sm text-theme-300">
          Explore MCP servers built and handpicked by Cynosure to expand what your agents can do.
        </p>
        <button
          type="button"
          class="mt-4 inline-flex items-center gap-2 rounded-lg bg-accent-600 px-4 py-2 text-xs font-semibold text-accent-on transition hover:bg-accent-500"
          @click="browseRecommendations"
        >
          Explore recommendations
          <Icon
            icon="lucide:arrow-right"
            class="h-3.5 w-3.5"
          />
        </button>
      </div>
      <div class="pointer-events-none absolute -right-8 top-1/2 hidden -translate-y-1/2 items-center gap-2 opacity-80 md:flex">
        <span
          v-for="icon in ['lucide:github', 'lucide:globe-2', 'lucide:terminal', 'lucide:file-text']"
          :key="icon"
          class="flex h-16 w-16 -skew-x-6 items-center justify-center rounded-xl border border-accent-500/20 bg-theme-950/75 shadow-xl"
        >
          <Icon
            :icon="icon"
            class="h-7 w-7 skew-x-6 text-theme-200"
          />
        </span>
      </div>
    </div>

    <div ref="catalogRef">
      <div class="mb-2 flex items-center justify-between gap-3">
        <h2 class="text-sm font-semibold text-theme-200">
          Browse by category
        </h2>
        <div class="flex items-center gap-2">
          <span class="hidden text-xs text-theme-500 sm:inline">{{ registryResultCount }} {{ registryResultCount === 1 ? 'server' : 'servers' }}</span>
          <div class="flex rounded-lg border border-theme-800 bg-theme-900/70 p-1">
            <button
              type="button"
              aria-label="Grid view"
              class="rounded-md p-1.5 transition"
              :class="viewMode === 'grid' ? 'bg-accent-500/15 text-accent-fg' : 'text-theme-500 hover:text-theme-200'"
              @click="viewMode = 'grid'"
            >
              <Icon
                icon="lucide:grid-2x2"
                class="h-4 w-4"
              />
            </button>
            <button
              type="button"
              aria-label="List view"
              class="rounded-md p-1.5 transition"
              :class="viewMode === 'list' ? 'bg-accent-500/15 text-accent-fg' : 'text-theme-500 hover:text-theme-200'"
              @click="viewMode = 'list'"
            >
              <Icon
                icon="lucide:list"
                class="h-4 w-4"
              />
            </button>
          </div>
        </div>
      </div>
      <div class="flex gap-2 overflow-x-auto pb-1">
        <button
          v-for="category in categories"
          :key="category.id"
          type="button"
          class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition"
          :class="selectedCategory === category.id ? 'border-accent-500 bg-accent-500/12 text-accent-fg' : 'border-theme-800 bg-theme-900/60 text-theme-400 hover:border-theme-700 hover:text-theme-200'"
          @click="selectedCategory = category.id"
        >
          <Icon
            :icon="category.icon"
            class="h-3.5 w-3.5"
          />
          {{ category.label }}
        </button>
      </div>
    </div>

    <div
      v-if="visibleRegistryRows.length"
      class="grid gap-3"
      :class="viewMode === 'grid' ? 'sm:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1'"
    >
      <article
        v-for="item in visibleRegistryRows"
        :key="item.id"
        class="group flex min-w-0 flex-col rounded-xl border border-theme-800 bg-theme-900/55 p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-theme-700 hover:bg-theme-900 hover:shadow-lg"
        :class="{ 'opacity-65': isInstalled(item.server) }"
      >
        <div class="flex min-w-0 items-start gap-3">
          <button
            type="button"
            class="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-theme-800"
            @click="selectedRegistryServer = item"
          >
            <img
              v-if="item.server.icons?.length"
              :src="item.server.icons[0].src"
              :alt="`${getDisplayName(item.server)} icon`"
              class="h-full w-full object-cover"
              @error="($event.target as HTMLImageElement).style.display = 'none'"
            >
            <Icon
              v-else
              icon="lucide:package"
              class="h-5 w-5 text-theme-400"
            />
          </button>
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                class="truncate text-left text-sm font-semibold text-theme-100 transition hover:text-accent-fg"
                @click="selectedRegistryServer = item"
              >
                {{ getDisplayName(item.server) }}
              </button>
              <Icon
                v-if="registrySource === 'recommended'"
                icon="lucide:badge-check"
                class="h-3.5 w-3.5 shrink-0 text-status-info"
                aria-label="Verified by Cynosure"
              />
            </div>
            <p class="mt-0.5 truncate text-[11px] text-theme-500">
              {{ getPublisher() }} · v{{ item.server.version }}
            </p>
          </div>
          <button
            type="button"
            class="rounded-md p-1 text-theme-600 transition hover:bg-theme-800 hover:text-theme-300"
            aria-label="Show server details"
            @click="selectedRegistryServer = item"
          >
            <Icon
              icon="lucide:ellipsis-vertical"
              class="h-4 w-4"
            />
          </button>
        </div>

        <p class="mt-3 line-clamp-2 min-h-10 text-xs leading-relaxed text-theme-400">
          {{ item.server.description || 'No description available.' }}
        </p>
        <div class="mt-3 flex flex-wrap gap-1.5">
          <span
            v-for="tag in getCardTags(item.server)"
            :key="tag"
            class="rounded-md bg-theme-800 px-2 py-1 text-[10px] text-theme-400"
          >{{ tag }}</span>
        </div>

        <div
          v-if="actionError[entryId(item.server)]"
          class="mt-3 text-xs text-status-danger"
        >
          {{ actionError[entryId(item.server)] }}
        </div>

        <div
          v-if="addingRegistryId === item.id && getInstallInfo(item.server)?.envVars.length"
          class="mt-4 space-y-2 border-t border-theme-800 pt-3"
        >
          <p class="text-xs font-medium text-theme-300">
            Configure before installing
          </p>
          <div
            v-for="ev in getInstallInfo(item.server)!.envVars"
            :key="ev.name"
          >
            <label class="mb-1 block text-[11px] text-theme-400">{{ ev.name }} <span
              v-if="ev.required"
              class="text-status-danger"
            >*</span></label>
            <input
              v-model="registryEnv[ev.name]"
              :type="ev.name.includes('KEY') || ev.name.includes('PASSWORD') ? 'password' : 'text'"
              :placeholder="ev.description || ev.name"
              class="w-full rounded-lg border border-theme-700 bg-theme-950 px-2.5 py-2 text-xs text-theme-200 outline-none placeholder:text-theme-600 focus:border-accent-500/60"
            >
          </div>
          <div class="flex justify-end gap-2 pt-1">
            <button
              type="button"
              class="rounded-md px-3 py-1.5 text-xs text-theme-400 hover:bg-theme-800"
              @click="cancelRegistryAdd"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="isLoading(item.id) || getInstallInfo(item.server)!.envVars.some(v => v.required && !registryEnv[v.name])"
              class="rounded-md bg-accent-600 px-3 py-1.5 text-xs font-medium text-accent-on hover:bg-accent-500 disabled:opacity-60"
              @click="addFromRegistry(item)"
            >
              {{ isLoading(item.id) ? 'Installing...' : 'Confirm & install' }}
            </button>
          </div>
        </div>

        <div
          class="mt-auto flex items-center gap-2 border-t border-theme-800/80 pt-3"
          :class="addingRegistryId === item.id ? 'mt-3' : 'mt-4'"
        >
          <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-theme-600">{{ item.server.name }}</span>
          <a
            v-if="item.server.repository?.url"
            :href="item.server.repository.url"
            target="_blank"
            rel="noopener"
            class="p-1 text-theme-500 transition hover:text-theme-200"
            aria-label="Open repository"
          ><Icon
            icon="lucide:github"
            class="h-3.5 w-3.5"
          /></a>
          <span
            v-if="isInstalled(item.server)"
            class="inline-flex items-center gap-1 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-status-success"
          ><Icon
            icon="lucide:check"
            class="h-3.5 w-3.5"
          /> Installed</span>
          <button
            v-else-if="getInstallInfo(item.server)"
            type="button"
            :disabled="isLoading(item.id)"
            class="rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-semibold text-accent-on transition hover:bg-accent-500 disabled:opacity-60"
            @click="addFromRegistry(item)"
          >
            {{ isLoading(item.id) ? 'Installing...' : 'Install' }}
          </button>
          <span
            v-else
            class="text-[11px] text-theme-600"
          >Not installable</span>
        </div>
      </article>
    </div>

    <div class="flex justify-center py-8">
      <div
        v-if="registryLoading && registryRows.length === 0"
        class="flex items-center gap-2 text-theme-500 text-sm"
      >
        <Icon
          icon="lucide:loader-2"
          class="w-4 h-4 animate-spin"
        />
        Loading...
      </div>
      <div
        v-else-if="visibleRegistryRows.length === 0"
        class="flex flex-col items-center text-center"
      >
        <span class="flex h-12 w-12 items-center justify-center rounded-xl bg-theme-900 text-theme-500"><Icon
          icon="lucide:package-search"
          class="h-6 w-6"
        /></span>
        <p class="mt-3 text-sm font-medium text-theme-300">
          No servers found{{ registrySearch ? ` for "${registrySearch}"` : '' }}
        </p>
        <button
          v-if="registrySearch || selectedCategory !== 'all'"
          type="button"
          class="mt-2 text-xs text-accent-fg hover:text-accent-fg"
          @click="clearSearchAndFilters"
        >
          Clear search and filters
        </button>
      </div>
      <div
        v-else-if="registryHasPrevious || registryHasNext"
        class="flex items-center gap-3"
        aria-label="Registry pagination"
      >
        <button
          :disabled="!registryHasPrevious || registryLoading"
          class="px-3 py-2 bg-theme-800 hover:bg-theme-700 disabled:opacity-40 disabled:cursor-not-allowed text-theme-300 text-sm rounded-lg transition-colors"
          aria-label="Previous registry page"
          @click="loadPreviousRegistryPage"
        >
          Previous
        </button>
        <span class="min-w-16 text-center text-theme-500 text-sm">
          <Icon
            v-if="registryLoading"
            icon="lucide:loader-2"
            class="inline-block w-4 h-4 animate-spin"
          />
          <template v-else>Page {{ registryPage }}</template>
        </span>
        <button
          :disabled="!registryHasNext || registryLoading"
          class="px-3 py-2 bg-theme-800 hover:bg-theme-700 disabled:opacity-40 disabled:cursor-not-allowed text-theme-300 text-sm rounded-lg transition-colors"
          aria-label="Next registry page"
          @click="loadNextRegistryPage"
        >
          Next
        </button>
      </div>
      <p
        v-else
        class="text-theme-600 text-xs"
      >
        End of results
      </p>
    </div>
  </section>

  <!-- Server Details Modal -->
  <div
    v-if="selectedRegistryServer"
    class="fixed inset-0 z-100 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
    @click.self="selectedRegistryServer = null"
  >
    <div class="bg-theme-900 border border-theme-800 rounded-xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[85vh]">
      <div class="flex items-center justify-between p-4 border-b border-theme-800 shrink-0">
        <div class="flex items-center gap-3">
          <Icon
            v-if="!selectedRegistryServer.server.icons?.[0]?.src"
            icon="lucide:box"
            class="w-6 h-6 text-theme-400"
          />
          <img
            v-else
            :src="selectedRegistryServer.server.icons[0].src"
            class="w-8 h-8 rounded shrink-0 object-cover"
          >
          <h3 class="text-lg font-medium text-theme-100">
            {{ getDisplayName(selectedRegistryServer.server) }}
          </h3>
          <span class="text-xs text-theme-500">v{{ selectedRegistryServer.server.version }}</span>
        </div>
        <button
          class="p-2 text-theme-400 hover:text-theme-200 transition-colors"
          @click="selectedRegistryServer = null"
        >
          <Icon
            icon="lucide:x"
            class="w-5 h-5"
          />
        </button>
      </div>

      <div class="p-6 overflow-y-auto space-y-6 text-sm text-theme-300">
        <div v-if="selectedRegistryServer.server.description">
          <h4 class="text-xs font-semibold uppercase tracking-wider text-theme-500 mb-2">
            Description
          </h4>
          <p>{{ selectedRegistryServer.server.description }}</p>
        </div>

        <div v-if="getInstallInfo(selectedRegistryServer.server)">
          <h4 class="text-xs font-semibold uppercase tracking-wider text-theme-500 mb-2">
            Installation Details
          </h4>
          <div class="bg-theme-950 p-3 rounded-lg font-mono text-xs border border-theme-800 wrap-break-word whitespace-pre-wrap">
            {{ getInstallInfo(selectedRegistryServer.server)!.command }} {{ getInstallInfo(selectedRegistryServer.server)!.args.join(' ') }}
          </div>

          <div
            v-if="getInstallInfo(selectedRegistryServer.server)!.envVars.length > 0"
            class="mt-4"
          >
            <h4 class="text-xs font-semibold uppercase tracking-wider text-theme-500 mb-2">
              Environment Variables
            </h4>
            <div class="space-y-2">
              <div
                v-for="env in getInstallInfo(selectedRegistryServer.server)!.envVars"
                :key="env.name"
                class="flex flex-col gap-1 bg-theme-800/50 p-3 rounded-lg border border-theme-800"
              >
                <div class="flex items-center gap-2">
                  <span class="font-mono text-theme-200">{{ env.name }}</span>
                  <span
                    v-if="env.required"
                    class="text-[10px] uppercase bg-red-900/30 text-status-danger px-1.5 py-0.5 rounded"
                  >Required</span>
                </div>
                <p
                  v-if="env.description"
                  class="text-xs text-theme-500 mt-1"
                >
                  {{ env.description }}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div>
          <h4 class="text-xs font-semibold uppercase tracking-wider text-theme-500 mb-2">
            Metadata
          </h4>
          <div class="flex flex-col gap-2">
            <div
              v-if="selectedRegistryServer.server.repository?.url"
              class="flex gap-2"
            >
              <span class="text-theme-500 w-24">Repository:</span>
              <a
                :href="selectedRegistryServer.server.repository.url"
                target="_blank"
                rel="noopener"
                class="text-accent-fg hover:underline inline-flex items-center gap-1"
              >
                {{ selectedRegistryServer.server.repository.url }}
                <Icon
                  icon="lucide:external-link"
                  class="w-3 h-3"
                />
              </a>
            </div>
            <div
              v-if="selectedRegistryServer.server.websiteUrl"
              class="flex gap-2"
            >
              <span class="text-theme-500 w-24">Website:</span>
              <a
                :href="selectedRegistryServer.server.websiteUrl"
                target="_blank"
                rel="noopener"
                class="text-accent-fg hover:underline inline-flex items-center gap-1"
              >
                {{ selectedRegistryServer.server.websiteUrl }}
                <Icon
                  icon="lucide:external-link"
                  class="w-3 h-3"
                />
              </a>
            </div>
            <div
              v-if="selectedRegistryServer.server.isRemote || (selectedRegistryServer.server as any).isLocal"
              class="flex items-center gap-2"
            >
              <span class="text-theme-500 w-24">Hosting:</span>
              <span
                v-if="(selectedRegistryServer.server as any).isLocal"
                class="text-status-green"
              >Local</span>
              <span v-if="selectedRegistryServer.server.isRemote && (selectedRegistryServer.server as any).isLocal"> / </span>
              <span
                v-if="selectedRegistryServer.server.isRemote"
                class="text-purple-400"
              >Remote</span>
            </div>
          </div>
        </div>
      </div>

      <div class="p-4 border-t border-theme-800 shrink-0 bg-theme-900/50 rounded-b-xl flex justify-end">
        <button
          class="px-4 py-2 bg-theme-800 hover:bg-theme-700 text-theme-300 text-sm rounded-lg transition-colors border border-theme-700"
          @click="selectedRegistryServer = null"
        >
          Close
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mcp-store-hero {
  background:
    radial-gradient(circle at 85% 30%, color-mix(in srgb, var(--color-accent-500) 24%, transparent), transparent 30%),
    linear-gradient(115deg, color-mix(in srgb, var(--color-accent-950) 45%, var(--color-theme-900)), var(--color-theme-900) 70%);
}

.mcp-store-hero::after {
  position: absolute;
  inset: 0;
  background-image: linear-gradient(120deg, transparent 25%, color-mix(in srgb, var(--color-accent-400) 8%, transparent) 50%, transparent 70%);
  content: '';
  pointer-events: none;
}
</style>
