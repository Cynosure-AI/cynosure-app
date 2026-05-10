<script setup lang="ts">
import { ref, reactive, watch, onMounted, computed } from 'vue'
import { api } from '../../../api/client'
import type { McpRegistryServer } from '../../../api/types'
import { Icon } from '@iconify/vue'
import { useMcpServers } from '../../../composables/useMcpServers'
import DataTable from '../../shared/DataTable.vue'
import type { Column } from '../../shared/DataTable.vue'

const emit = defineEmits<{
  goToInstalled: []
}>()

const { servers, actionError, isLoading, setLoading, authInProgress, refreshAll } = useMcpServers()

const registryServers = ref<McpRegistryServer[]>([])
const registrySearch = ref('')
const registrySource = ref<'official' | 'smithery' | 'glama'>('official')
const selectedRegistryServer = ref<McpRegistryServer | null>(null)
const registryCursor = ref<string | undefined>(undefined)
const registryLoading = ref(false)
const registryHasMore = ref(true)
const addingRegistryId = ref<string | null>(null)
const registryEnv = reactive<Record<string, string>>({})

type RegistryRow = McpRegistryServer & { id: string }

const registryRows = computed<RegistryRow[]>(() =>
  registryServers.value.map(entry => ({
    ...entry,
    id: entryId(entry.server),
  }))
)

const registryTableColumns: Column[] = [
  { key: 'server', label: 'Server', width: 'minmax(0,4fr)' },
  { key: 'type', label: 'Type', width: 'minmax(180px,1fr)', hideOnMobile: true },
  { key: 'actions', label: 'Actions', width: 'minmax(200px,1fr)' },
]

let searchTimer: ReturnType<typeof setTimeout> | null = null
let currentAbortController: AbortController | null = null

function resetRegistry(): void {
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null }
  registryServers.value = []
  registryCursor.value = undefined
  registryHasMore.value = true
}

watch(registrySearch, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    registryServers.value = []
    registryCursor.value = undefined
    registryHasMore.value = true
    loadRegistry()
  }, 400)
})

watch(registrySource, () => {
  resetRegistry()
  loadRegistry()
})

async function loadRegistry(): Promise<void> {
  currentAbortController?.abort()
  currentAbortController = new AbortController()
  const { signal } = currentAbortController

  registryLoading.value = true
  try {
    const data = await api.mcp.searchRegistry({
      search: registrySearch.value || undefined,
      cursor: registryCursor.value,
      limit: 20,
      registry: registrySource.value,
      signal,
    })
    if (signal.aborted) return
    registryServers.value.push(...data.servers)
    registryCursor.value = data.metadata.nextCursor
    registryHasMore.value = !!data.metadata.nextCursor && data.metadata.count >= 20
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return
    registryHasMore.value = false
  } finally {
    if (!signal.aborted) registryLoading.value = false
  }
}

function entryId(srv: McpRegistryServer['server']): string {
  return `${srv.name}@${srv.version}`
}

function getDisplayName(srv: McpRegistryServer['server']): string {
  return srv.title || srv.name.split('/').pop() || srv.name
}

function getInstallInfo(srv: McpRegistryServer['server']): {
  command: string
  args: string[]
  envVars: { name: string; description?: string; required: boolean }[]
} | null {
  const pkg = srv.packages?.find(p => p.transport?.type === 'stdio' || p.registryType === 'smithery')
  if (pkg) {
    const envVars = (pkg.environmentVariables || []).map(v => ({
      name: v.name,
      description: v.description,
      required: v.isRequired,
    }))
    if (pkg.registryType === 'smithery') return { command: 'npx', args: ['-y', '@smithery/cli@latest', 'run', pkg.identifier], envVars }
    if (pkg.registryType === 'npm') return { command: 'npx', args: ['-y', pkg.identifier], envVars }
    if (pkg.registryType === 'pypi') return { command: 'uvx', args: [pkg.identifier], envVars }
  }
  return null
}

function getTypeTags(srv: McpRegistryServer['server']): string[] {
  const tags = new Set<string>()
  const install = getInstallInfo(srv)
  const pkg = srv.packages?.find(p => p.transport?.type === 'stdio' || p.registryType === 'smithery')

  if (pkg?.registryType === 'smithery') tags.add('smithery')
  else if (pkg?.registryType === 'npm') tags.add('npm')
  else if (pkg?.registryType === 'pypi') tags.add('pypi')
  else if (install?.command === 'npx') tags.add('npm')
  else if (install?.command === 'uvx') tags.add('pypi')

  if ((srv as { isLocal?: boolean }).isLocal) tags.add('local')
  if (srv.isRemote || (srv as { isRemote?: boolean }).isRemote) tags.add('remote')
  if (!install && !(srv as { isLocal?: boolean }).isLocal && !srv.isRemote) tags.add('remote only')

  return [...tags]
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
      if (registryEnv[v.name]) env[v.name] = registryEnv[v.name]
    }

    const pkgType = srv.server.packages?.[0]?.registryType || 'unknown'
    const originLabel = pkgType === 'smithery' ? 'smithery.ai' : (pkgType === 'npm' ? 'npm' : (pkgType === 'pypi' ? 'pypi' : 'mcp-official'))
    const iconUrl = srv.server.icons?.[0]?.src || undefined

    const result = await api.mcp.addServer({
      originalName: getDisplayName(srv.server),
      command: install.command,
      args: install.args,
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
  const identifier = install.args[install.args.length - 1]
  return servers.value.some(s => s.args.some(a => a === identifier))
}

function registryRowClass(item: RegistryRow): string | undefined {
  return isInstalled(item.server) ? 'opacity-60' : undefined
}

onMounted(() => {
  loadRegistry()
})
</script>

<template>
  <!-- Search -->
  <div class="flex gap-2 mb-4">
    <div class="relative flex-1">
      <Icon
        icon="lucide:search"
        class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500"
      />
      <input
        v-model="registrySearch"
        type="text"
        placeholder="Search MCP servers..."
        class="w-full pl-9 pr-3 py-2 bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
      >
    </div>
    <select
      v-model="registrySource"
      class="bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
    >
      <option value="official">
        Official Registry
      </option>
      <option value="smithery">
        Smithery.ai
      </option>
      <option value="glama">
        Glama.ai
      </option>
    </select>
  </div>

  <!-- Registry list -->
  <DataTable
    :items="registryRows"
    :columns="registryTableColumns"
    :row-class="registryRowClass"
    empty-message="No servers found"
  >
    <template #col-server="{ item }">
      <div class="min-w-0 flex items-start gap-3">
        <div class="w-10 h-10 rounded-lg bg-zinc-700/70 flex items-center justify-center shrink-0 overflow-hidden">
          <img
            v-if="item.server.icons?.length"
            :src="item.server.icons[0].src"
            class="w-full h-full object-cover"
            @error="($event.target as HTMLImageElement).style.display = 'none'"
          >
          <Icon
            v-else
            icon="lucide:puzzle"
            class="w-5 h-5 text-zinc-400"
          />
        </div>

        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <button
              class="font-medium text-zinc-100 text-sm hover:underline hover:text-zinc-50 transition-colors text-left"
              @click="selectedRegistryServer = item"
            >
              {{ getDisplayName(item.server) }}
            </button>
            <span class="text-xs text-zinc-500">v{{ item.server.version }}</span>
          </div>
          <p class="text-xs text-zinc-400 mt-1 line-clamp-2">
            {{ item.server.description || 'No description' }}
          </p>
          <div class="flex items-center gap-3 mt-2 text-xs text-zinc-600">
            <span class="truncate">{{ item.server.name }}</span>
            <a
              v-if="item.server.repository?.url"
              :href="item.server.repository.url"
              target="_blank"
              rel="noopener"
              class="flex items-center gap-1 text-zinc-500 hover:text-zinc-300 transition-colors shrink-0"
            >
              <Icon
                icon="lucide:github"
                class="w-3 h-3"
              /> Repo
            </a>
          </div>

          <div
            v-if="addingRegistryId === entryId(item.server) && getInstallInfo(item.server)?.envVars.length"
            class="mt-3 p-3 border border-zinc-700 rounded-lg bg-zinc-900/60 space-y-2"
          >
            <p class="text-xs text-zinc-400 mb-1">
              Required configuration:
            </p>
            <div
              v-for="ev in getInstallInfo(item.server)!.envVars"
              :key="ev.name"
            >
              <label class="block text-xs text-zinc-400 mb-1">
                {{ ev.name }}
                <span
                  v-if="ev.required"
                  class="text-red-400"
                >*</span>
                <span
                  v-if="ev.description"
                  class="text-zinc-600 ml-1"
                >- {{ ev.description }}</span>
              </label>
              <input
                v-model="registryEnv[ev.name]"
                type="text"
                :placeholder="ev.name"
                class="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
              >
            </div>
            <div class="flex gap-2 justify-end mt-2">
              <button
                class="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded-md transition-colors"
                @click="cancelRegistryAdd"
              >
                Cancel
              </button>
              <button
                :disabled="isLoading(entryId(item.server)) || getInstallInfo(item.server)!.envVars.some(v => v.required && !registryEnv[v.name])"
                class="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-md transition-colors"
                @click="addFromRegistry(item)"
              >
                {{ isLoading(entryId(item.server)) ? 'Adding...' : 'Confirm & Add' }}
              </button>
            </div>
          </div>

          <div
            v-if="actionError[entryId(item.server)]"
            class="mt-2 text-xs text-red-400"
          >
            {{ actionError[entryId(item.server)] }}
          </div>
        </div>
      </div>
    </template>

    <template #col-type="{ item }">
      <div class="flex flex-wrap items-center gap-1.5 md:pt-1">
        <span
          v-for="tag in getTypeTags(item.server)"
          :key="tag"
          class="text-[11px] px-2 py-1 rounded-md"
          :class="tag === 'npm'
            ? 'bg-sky-500/15 text-sky-300'
            : tag === 'pypi'
              ? 'bg-indigo-500/15 text-indigo-300'
              : tag === 'smithery'
                ? 'bg-blue-500/15 text-blue-300'
                : tag === 'local'
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : tag === 'remote'
                    ? 'bg-violet-500/15 text-violet-300'
                    : 'bg-zinc-700/60 text-zinc-400'"
        >
          {{ tag }}
        </span>
      </div>
    </template>

    <template #col-actions="{ item }">
      <div class="flex items-center gap-2 md:justify-start md:pt-0.5">
        <button
          class="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 rounded-md transition-colors"
          @click="selectedRegistryServer = item"
        >
          Details
        </button>
        <template v-if="isInstalled(item.server)">
          <span class="text-xs text-zinc-500 flex items-center gap-1">
            <Icon
              icon="lucide:check"
              class="w-3.5 h-3.5"
            /> Added
          </span>
        </template>
        <template v-else-if="getInstallInfo(item.server)">
          <button
            :disabled="isLoading(entryId(item.server))"
            class="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-md transition-colors"
            @click="addFromRegistry(item)"
          >
            {{ isLoading(entryId(item.server)) ? 'Adding...' : 'Add' }}
          </button>
        </template>
        <template v-else>
          <span class="text-xs text-zinc-600">Not installable</span>
        </template>
      </div>
    </template>
  </DataTable>

  <!-- Load more / Loading -->
  <div class="flex justify-center py-6">
    <button
      v-if="registryHasMore && !registryLoading"
      class="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm rounded-lg transition-colors"
      @click="loadRegistry"
    >
      Load More
    </button>
    <div
      v-else-if="registryLoading"
      class="flex items-center gap-2 text-zinc-500 text-sm"
    >
      <Icon
        icon="lucide:loader-2"
        class="w-4 h-4 animate-spin"
      />
      Loading...
    </div>
    <p
      v-else-if="registryServers.length === 0"
      class="text-zinc-500 text-sm"
    >
      No servers found{{ registrySearch ? ` for "${registrySearch}"` : '' }}
    </p>
    <p
      v-else
      class="text-zinc-600 text-xs"
    >
      End of results
    </p>
  </div>

  <!-- Server Details Modal -->
  <div
    v-if="selectedRegistryServer"
    class="fixed inset-0 z-100 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
    @click.self="selectedRegistryServer = null"
  >
    <div class="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[85vh]">
      <div class="flex items-center justify-between p-4 border-b border-zinc-800 shrink-0">
        <div class="flex items-center gap-3">
          <Icon
            v-if="!selectedRegistryServer.server.icons?.[0]?.src"
            icon="lucide:box"
            class="w-6 h-6 text-zinc-400"
          />
          <img
            v-else
            :src="selectedRegistryServer.server.icons[0].src"
            class="w-8 h-8 rounded shrink-0 object-cover"
          >
          <h3 class="text-lg font-medium text-zinc-100">
            {{ getDisplayName(selectedRegistryServer.server) }}
          </h3>
          <span class="text-xs text-zinc-500">v{{ selectedRegistryServer.server.version }}</span>
        </div>
        <button
          class="p-2 text-zinc-400 hover:text-zinc-200 transition-colors"
          @click="selectedRegistryServer = null"
        >
          <Icon
            icon="lucide:x"
            class="w-5 h-5"
          />
        </button>
      </div>

      <div class="p-6 overflow-y-auto space-y-6 text-sm text-zinc-300">
        <div v-if="selectedRegistryServer.server.description">
          <h4 class="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">
            Description
          </h4>
          <p>{{ selectedRegistryServer.server.description }}</p>
        </div>

        <div v-if="getInstallInfo(selectedRegistryServer.server)">
          <h4 class="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">
            Installation Details
          </h4>
          <div class="bg-zinc-950 p-3 rounded-lg font-mono text-xs border border-zinc-800 wrap-break-word whitespace-pre-wrap">
            {{ getInstallInfo(selectedRegistryServer.server)!.command }} {{ getInstallInfo(selectedRegistryServer.server)!.args.join(' ') }}
          </div>

          <div
            v-if="getInstallInfo(selectedRegistryServer.server)!.envVars.length > 0"
            class="mt-4"
          >
            <h4 class="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">
              Environment Variables
            </h4>
            <div class="space-y-2">
              <div
                v-for="env in getInstallInfo(selectedRegistryServer.server)!.envVars"
                :key="env.name"
                class="flex flex-col gap-1 bg-zinc-800/50 p-3 rounded-lg border border-zinc-800"
              >
                <div class="flex items-center gap-2">
                  <span class="font-mono text-zinc-200">{{ env.name }}</span>
                  <span
                    v-if="env.required"
                    class="text-[10px] uppercase bg-red-900/30 text-red-400 px-1.5 py-0.5 rounded"
                  >Required</span>
                </div>
                <p
                  v-if="env.description"
                  class="text-xs text-zinc-500 mt-1"
                >
                  {{ env.description }}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div>
          <h4 class="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">
            Metadata
          </h4>
          <div class="flex flex-col gap-2">
            <div
              v-if="selectedRegistryServer.server.repository?.url"
              class="flex gap-2"
            >
              <span class="text-zinc-500 w-24">Repository:</span>
              <a
                :href="selectedRegistryServer.server.repository.url"
                target="_blank"
                rel="noopener"
                class="text-blue-400 hover:underline inline-flex items-center gap-1"
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
              <span class="text-zinc-500 w-24">Website:</span>
              <a
                :href="selectedRegistryServer.server.websiteUrl"
                target="_blank"
                rel="noopener"
                class="text-blue-400 hover:underline inline-flex items-center gap-1"
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
              <span class="text-zinc-500 w-24">Hosting:</span>
              <span
                v-if="(selectedRegistryServer.server as any).isLocal"
                class="text-green-400"
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

      <div class="p-4 border-t border-zinc-800 shrink-0 bg-zinc-900/50 rounded-b-xl flex justify-end">
        <button
          class="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm rounded-lg transition-colors border border-zinc-700"
          @click="selectedRegistryServer = null"
        >
          Close
        </button>
      </div>
    </div>
  </div>
</template>
