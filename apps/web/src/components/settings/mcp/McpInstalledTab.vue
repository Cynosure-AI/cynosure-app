<script setup lang="ts">
import { ref, reactive, computed } from 'vue'
import { api } from '../../../api/client'
import { Icon } from '@iconify/vue'
import DataTable from '../../shared/DataTable.vue'
import ToggleSwitch from '../../shared/ToggleSwitch.vue'
import HoverTooltip from '../../shared/HoverTooltip.vue'
import { useMcpServers } from '../../../composables/useMcpServers'
import { useAgentStore } from '../../../stores/agent-runtime.store'
import ModalDialog from '../../shared/ModalDialog.vue'
import type { McpServerInfo } from '../../../api/types'
import type { Column } from '../../shared/DataTable.vue'

const emit = defineEmits<{
  goToBrowse: []
}>()

const TOOLTIP_MAX_TOOLS = 20

const { servers, actionError, isLoading, setLoading, loadServers, refreshAll, authInProgress } = useMcpServers()
const agentStore = useAgentStore()

function serverTools(server: McpServerInfo) {
  return agentStore.availableTools.filter(t => t.namespace.id === `mcp:${server.id}`)
}

const showAddForm = ref(false)
const editingId = ref<string | null>(null)
const installedFilter = ref('')
const brokenIconUrlById = reactive<Record<string, string>>({})

function hasUsableIcon(server: McpServerInfo): boolean {
  return !!server.icon_url && brokenIconUrlById[server.id] !== server.icon_url
}

function onServerIconError(server: McpServerInfo): void {
  if (server.icon_url) brokenIconUrlById[server.id] = server.icon_url
}

function originalServerName(server: McpServerInfo): string {
  return server.originalName || server.serverInfo?.title || server.name || 'Server name'
}

function matchesInstalledFilter(server: McpServerInfo, query: string): boolean {
  return server.name.toLowerCase().includes(query)
    || originalServerName(server).toLowerCase().includes(query)
    || server.description.toLowerCase().includes(query)
    || server.command.toLowerCase().includes(query)
    || server.args.some(argument => argument.toLowerCase().includes(query))
}

// Table columns definition for DataTable component
const tableColumns: Column<McpServerInfo>[] = [
  { key: 'server', label: 'Server', width: 'minmax(0,1.75fr)', sortable: true, sortValue: originalServerName },
  { key: 'tools', label: 'Tools', width: '120px', sortable: true, sortValue: server => server.toolCount },
  { key: 'status', label: 'Status', width: '120px', sortable: true, sortValue: server => server.connected ? 3 : server.pendingAuthUrl ? 2 : server.enabled ? 1 : 0 },
  { key: 'actions', label: 'Actions', width: '200px' },
  { key: 'enable', label: 'Enable', width: '56px', sortable: true, sortValue: server => server.enabled },
]

type AddMode = 'local' | 'remote'

const newServer = reactive({
  mode: 'local' as AddMode,
  name: '',
  description: '',
  command: '',
  args: '',
  env: '',
  remoteUrl: '',
  bearerToken: '',
})
const pendingAddId = ref<string | null>(null)
const addConnected = ref(false)
const editServer = reactive({ name: '', description: '', command: '', args: '', env: '' })
const editEnvFields = reactive<Record<string, string>>({})

const editingServer = computed(() => servers.value.find(s => s.id === editingId.value) ?? null)
const isSaving = ref(false)

const editingServerHints = computed(() => {
  if (!editingId.value) return null
  const srv = servers.value.find(s => s.id === editingId.value)
  return srv?.envHints?.length ? srv.envHints : null
})

function envToText(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')
}

function textToEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (text.trim()) {
    for (const line of text.split('\n')) {
      const eqIdx = line.indexOf('=')
      if (eqIdx > 0) env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim()
    }
  }
  return env
}

function resetNewServer(): void {
  Object.assign(newServer, {
    mode: 'local',
    name: '',
    description: '',
    command: '',
    args: '',
    env: '',
    remoteUrl: '',
    bearerToken: '',
  })
}

function remoteTokenEnvName(): string {
  const source = newServer.name.trim() || newServer.remoteUrl.trim() || 'remote'
  const slug = source.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')
  return `MCP_${slug || 'REMOTE'}_TOKEN`
}

function buildRemoteArgs(): string[] {
  const args = ['--transport', 'streamable-http', '--url', newServer.remoteUrl.trim()]
  const token = newServer.bearerToken.trim()
  if (token) args.push(`--bearer-token-env=${token.startsWith('$') ? token.slice(1) : remoteTokenEnvName()}`)
  return args
}

function buildRemoteEnv(): Record<string, string> {
  const token = newServer.bearerToken.trim()
  if (!token || token.startsWith('$')) return {}
  return { [remoteTokenEnvName()]: token }
}

const canSubmitNewServer = computed(() => {
  if (newServer.mode === 'remote') return /^https?:\/\//.test(newServer.remoteUrl.trim())
  return !!newServer.command.trim()
})

async function addServer(): Promise<void> {
  if (!canSubmitNewServer.value || isLoading('add')) return
  setLoading('add', true)
  try {
    const isRemote = newServer.mode === 'remote'
    const command = isRemote ? 'remote' : newServer.command.trim()
    const args = isRemote
      ? buildRemoteArgs()
      : (newServer.args ? newServer.args.split('\n').map(a => a.trim()).filter(Boolean) : [])
    const env = isRemote ? buildRemoteEnv() : textToEnv(newServer.env)
    const customName = newServer.name.trim() || null

    // If we already created a server that failed to connect, update it instead of creating a duplicate
    if (pendingAddId.value) {
      const result = await api.mcp.updateServer(pendingAddId.value, {
        customName,
        description: newServer.description,
        command,
        args,
        env,
      })
      if (result.error) {
        actionError.value['add'] = result.error
        addConnected.value = false
      } else {
        actionError.value = {}
        addConnected.value = true
      }
    } else {
      const result = await api.mcp.addServer({
        customName,
        description: newServer.description,
        command,
        args,
        env: Object.keys(env).length ? env : undefined,
        origin: isRemote ? 'remote' : undefined,
      })
      if (result.error) {
        actionError.value['add'] = result.error
        addConnected.value = false
        // If server was created but failed to connect, remember its id so next "Add" updates instead of duplicates
        if (result.id) {
          pendingAddId.value = result.id
        }
      } else {
        actionError.value = {}
        pendingAddId.value = result.id
        addConnected.value = true
      }
    }
    await refreshAll()
  } catch (error) {
    actionError.value['add'] = error instanceof Error ? error.message : 'Failed to connect MCP server'
    addConnected.value = false
  } finally {
    setLoading('add', false)
  }
}

function finishAdding(): void {
  showAddForm.value = false
  resetNewServer()
  delete actionError.value['add']
  pendingAddId.value = null
  addConnected.value = false
}

async function cancelForm(): Promise<void> {
  if (isLoading('add')) return
  const failedServerId = !addConnected.value ? pendingAddId.value : null
  finishAdding()
  if (failedServerId) {
    await api.mcp.removeServer(failedServerId)
    await refreshAll()
  }
}

function startEditing(server: McpServerInfo): void {
  delete actionError.value['edit']
  editingId.value = server.id
  editServer.name = server.customName || ''
  editServer.description = server.description || ''
  editServer.command = server.command
  editServer.args = server.args.join('\n')
  Object.keys(editEnvFields).forEach(k => delete editEnvFields[k])
  if (server.envHints?.length) {
    const hintNames = new Set(server.envHints.map(h => h.name))
    for (const hint of server.envHints) {
      editEnvFields[hint.name] = server.env[hint.name] || ''
    }
    const extraVars = Object.entries(server.env).filter(([k]) => !hintNames.has(k))
    editServer.env = extraVars.map(([k, v]) => `${k}=${v}`).join('\n')
  } else {
    editServer.env = envToText(server.env)
  }
}

function cancelEditing(): void {
  if (isSaving.value || confirmDeleteId.value) return
  editingId.value = null
  delete actionError.value['edit']
}

async function saveEditing(id: string): Promise<void> {
  if (isLoading(id) || !editServer.command.trim()) return
  isSaving.value = true
  setLoading(id, true)
  try {
    const args = editServer.args ? editServer.args.split('\n').map(a => a.trim()).filter(Boolean) : []
    let env: Record<string, string>
    if (editingServerHints.value) {
      env = {}
      for (const hint of editingServerHints.value) {
        if (editEnvFields[hint.name]) env[hint.name] = editEnvFields[hint.name]
      }
      const extraEnv = textToEnv(editServer.env)
      const hintNames = new Set(editingServerHints.value.map(h => h.name))
      for (const [k, v] of Object.entries(extraEnv)) {
        if (!hintNames.has(k)) env[k] = v
      }
    } else {
      env = textToEnv(editServer.env)
    }
    const result = await api.mcp.updateServer(id, {
      customName: editServer.name.trim() || null,
      description: editServer.description,
      command: editServer.command.trim(),
      args,
      env,
    })
    if (result.error) {
      actionError.value['edit'] = result.error
    } else {
      editingId.value = null
      delete actionError.value['edit']
    }
    await refreshAll()
  } catch (error) {
    actionError.value['edit'] = error instanceof Error ? error.message : 'Failed to save MCP settings'
  } finally {
    isSaving.value = false
    setLoading(id, false)
  }
}

async function toggleServer(id: string): Promise<void> {
  if (isLoading(id)) return
  setLoading(id, true)
  try {
    const result = await api.mcp.toggleServer(id)
    if (result.error) actionError.value[id] = result.error
    else delete actionError.value[id]
    await refreshAll()
  } finally {
    setLoading(id, false)
  }
}

async function reconnectServer(id: string): Promise<void> {
  setLoading(id, true)
  try {
    const result = await api.mcp.reconnectServer(id)
    if (result.error) actionError.value[id] = result.error
    else delete actionError.value[id]
    await refreshAll()
  } finally {
    setLoading(id, false)
  }
}

function startAuth(server: McpServerInfo): void {
  if (server.pendingAuthUrl) {
    window.open(server.pendingAuthUrl, '_blank')
    authInProgress.value = server.id
  }
}

async function finishAuth(id: string): Promise<void> {
  authInProgress.value = null
  await reconnectServer(id)
}

async function reauthServer(id: string): Promise<void> {
  setLoading(id, true)
  try {
    const result = await api.mcp.reauthServer(id)
    if (result.error && !result.authRequired) actionError.value[id] = result.error
    else delete actionError.value[id]
    await refreshAll()
  } finally {
    setLoading(id, false)
  }
}

const confirmDeleteId = ref<string | null>(null)
const serverToDelete = computed(() => servers.value.find(s => s.id === confirmDeleteId.value) ?? null)

function promptRemoveServer(id: string): void {
  confirmDeleteId.value = id
}

async function confirmRemoveServer(): Promise<void> {
  if (!confirmDeleteId.value) return
  await api.mcp.removeServer(confirmDeleteId.value)
  if (editingId.value === confirmDeleteId.value) editingId.value = null
  delete actionError.value[confirmDeleteId.value]
  confirmDeleteId.value = null
  await refreshAll()
}

defineExpose({ loadServers })
</script>

<template>
  <div>
    <div class="flex flex-col gap-3 mb-4 md:flex-row md:items-center md:justify-between">
      <button
        class="h-10 px-4 bg-accent-600 hover:bg-accent-500 text-white text-sm font-medium rounded-lg transition-colors self-start"
        @click="showAddForm = true"
      >
        Add Manually
      </button>

      <div class="flex items-center gap-2 w-full md:w-auto md:min-w-130">
        <div class="relative flex-1">
          <Icon
            icon="lucide:search"
            class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-500"
          />
          <input
            v-model="installedFilter"
            type="text"
            placeholder="Filter installed servers..."
            class="h-10 w-full pl-9 pr-3 bg-theme-900/80 border border-theme-700 text-theme-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
          >
        </div>
      </div>
    </div>

    <ModalDialog
      :show="showAddForm"
      title="Manually Add MCP"
      icon="lucide:plug"
      max-width="max-w-2xl"
      @close="cancelForm"
    >
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-1 rounded-lg bg-theme-950/70 border border-theme-800 p-1">
          <button
            class="h-8 rounded-md text-sm transition-colors"
            :class="newServer.mode === 'local' ? 'bg-theme-700 text-theme-100' : 'text-theme-400 hover:text-theme-200'"
            @click="newServer.mode = 'local'"
          >
            Local
          </button>
          <button
            class="h-8 rounded-md text-sm transition-colors"
            :class="newServer.mode === 'remote' ? 'bg-theme-700 text-theme-100' : 'text-theme-400 hover:text-theme-200'"
            @click="newServer.mode = 'remote'"
          >
            Remote
          </button>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="block text-sm text-theme-400 mb-1">Custom name</label>
            <input
              v-model="newServer.name"
              type="text"
              placeholder="Use original MCP name"
              class="w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
            >
          </div>
          <div v-if="newServer.mode === 'remote'">
            <label class="block text-sm text-theme-400 mb-1">URL</label>
            <input
              v-model="newServer.remoteUrl"
              type="url"
              placeholder="https://mcp.example.com/mcp"
              class="w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
            >
          </div>
          <div v-else>
            <label class="block text-sm text-theme-400 mb-1">Command</label>
            <input
              v-model="newServer.command"
              type="text"
              placeholder="npx"
              class="w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
            >
          </div>
        </div>
        <div>
          <label class="block text-sm text-theme-400 mb-1">Description</label>
          <textarea
            v-model="newServer.description"
            rows="2"
            placeholder="What this MCP server is useful for"
            class="w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-2 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
          />
        </div>
        <template v-if="newServer.mode === 'local'">
          <div>
            <label class="block text-sm text-theme-400 mb-1">Arguments (one per line)</label>
            <textarea
              v-model="newServer.args"
              rows="3"
              placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/path/to/dir"
              class="w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
            />
          </div>
        </template>
        <template v-else>
          <div>
            <label class="block text-sm text-theme-400 mb-1">Bearer token</label>
            <input
              v-model="newServer.bearerToken"
              type="password"
              placeholder="Leave blank for OAuth, paste a token, or use $MCP_BEARER_TOKEN"
              class="w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
            >
            <p class="mt-1 text-xs text-theme-500">
              Remote MCP servers normally authenticate with OAuth. Use this only for servers that accept an Authorization bearer token.
            </p>
          </div>
        </template>
        <div v-if="newServer.mode === 'local'">
          <label class="block text-sm text-theme-400 mb-1">Environment Variables (KEY=VALUE, one per line)</label>
          <textarea
            v-model="newServer.env"
            rows="2"
            placeholder="API_KEY=sk-..."
            class="w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
          />
        </div>
        <div
          v-if="actionError['add']"
          class="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400"
          role="alert"
        >
          {{ actionError['add'] }}
        </div>
        <div
          v-if="addConnected"
          class="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"
        >
          <Icon
            icon="lucide:circle-check"
            class="h-4 w-4 shrink-0"
          />
          MCP connected successfully.
        </div>
      </div>
      <template #actions>
        <div class="flex justify-end gap-2">
          <button
            v-if="actionError['add']"
            :disabled="isLoading('add')"
            class="px-4 py-2 text-sm bg-theme-700 hover:bg-theme-600 text-theme-200 rounded-lg transition-colors"
            @click="finishAdding"
          >
            Add Anyway
          </button>
          <button
            v-if="actionError['add']"
            :disabled="!canSubmitNewServer || isLoading('add')"
            class="px-4 py-2 bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white text-sm rounded-lg transition-colors"
            @click="addServer"
          >
            {{ isLoading('add') ? 'Reconnecting...' : 'Re-connect' }}
          </button>
          <button
            v-if="!addConnected && !actionError['add']"
            :disabled="!canSubmitNewServer || isLoading('add')"
            class="px-4 py-2 bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white text-sm rounded-lg transition-colors"
            @click="addServer"
          >
            {{ isLoading('add') ? 'Connecting...' : 'Save & Connect' }}
          </button>
          <button
            v-if="addConnected || actionError['add']"
            class="px-4 py-2 text-sm bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-lg transition-colors"
            :disabled="isLoading('add')"
            @click="cancelForm"
          >
            {{ actionError['add'] ? 'Cancel' : 'Close' }}
          </button>
        </div>
      </template>
    </ModalDialog>

    <DataTable
      v-if="servers.length"
      :items="servers"
      :columns="tableColumns"
      :filter-text="installedFilter"
      :filter-predicate="matchesInstalledFilter"
      initial-sort-key="enable"
      initial-sort-direction="desc"
      :initial-sort-once="true"
      empty-message="No servers found"
    >
      <!-- Server column -->
      <template #col-server="{ item: server }">
        <div class="min-w-0 flex items-start gap-3">
          <div class="relative shrink-0 mt-0.5">
            <img
              v-if="hasUsableIcon(server)"
              :src="server.icon_url"
              class="w-10 h-10 rounded-lg object-cover"
              :class="!server.connected && 'opacity-40 grayscale'"
              @error="onServerIconError(server)"
            >
            <div
              v-else
              class="w-10 h-10 rounded-lg flex items-center justify-center"
              :class="server.connected ? 'bg-accent-500/15 text-accent-300' : 'bg-theme-700/50 text-theme-500'"
            >
              <Icon
                icon="lucide:plug"
                class="w-5 h-5"
              />
            </div>
            <div
              class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-theme-900"
              :class="server.connected ? 'bg-emerald-500' : server.enabled ? 'bg-accent-400' : 'bg-theme-500'"
            />
          </div>

          <div class="min-w-0">
            <div class="text-sm font-medium text-theme-100 truncate">
              {{ server.name || server.serverInfo?.title }}
            </div>
            <div
              v-if="server.description || server.serverInfo?.description"
              class="text-xs text-theme-400 mt-0.5 line-clamp-2"
            >
              {{ server.description || server.serverInfo?.description }}
            </div>
            <div class="text-xs text-theme-500 mt-1 truncate font-mono">
              {{ server.command }} {{ server.args.join(' ') }}
            </div>
            <div
              v-if="server.envHints?.length && server.envHints.some(h => h.required && !server.env[h.name])"
              class="text-[11px] text-accent-400/90 mt-1"
            >
              Requires: {{ server.envHints.filter(h => h.required && !server.env[h.name]).map(h => h.name).join(', ') }}
            </div>
            <div
              v-if="actionError[server.id]"
              class="text-xs text-red-400 mt-1"
            >
              {{ actionError[server.id] }}
            </div>
          </div>
        </div>
      </template>

      <!-- Tools column -->
      <template #col-tools="{ item: server }">
        <HoverTooltip
          :disabled="server.toolCount === 0"
          placement="mouse"
          :max-width="220"
        >
          <span
            class="mcp-tool-count inline-flex items-center text-[11px] px-2 py-1 rounded-md"
            :class="server.toolCount > 0 ? 'bg-emerald-500/15 text-emerald-300 cursor-default' : 'bg-theme-700/60 text-theme-400'"
          >
            {{ server.toolCount }} {{ server.toolCount === 1 ? 'tool' : 'tools' }}
          </span>
          <template #content>
            <div class="font-medium text-theme-300 mb-1.5">
              {{ server.toolCount }} {{ server.toolCount === 1 ? 'tool' : 'tools' }}
            </div>
            <div
              v-for="t in serverTools(server).slice(0, TOOLTIP_MAX_TOOLS)"
              :key="t.key"
              class="font-mono text-[10px] text-theme-300 truncate py-0.5"
            >
              {{ t.name }}
            </div>
            <div
              v-if="server.toolCount > TOOLTIP_MAX_TOOLS"
              class="text-theme-500 text-[10px] mt-1"
            >
              +{{ server.toolCount - TOOLTIP_MAX_TOOLS }} more
            </div>
          </template>
        </HoverTooltip>
      </template>

      <!-- Status column -->
      <template #col-status="{ item: server }">
        <span
          class="mcp-server-status inline-flex items-center gap-1.5 text-xs"
          :class="server.connected ? 'text-emerald-400' : server.enabled ? (server.pendingAuthUrl ? 'text-accent-400' : 'text-red-400') : 'text-theme-500'"
        >
          <span
            class="w-1.5 h-1.5 rounded-full"
            :class="server.connected ? 'bg-emerald-400' : server.enabled ? (server.pendingAuthUrl ? 'bg-accent-400' : 'bg-red-400') : 'bg-theme-500'"
          />
          {{ server.connected ? 'Connected' : server.enabled ? (server.pendingAuthUrl ? 'Authorization required' : 'Disconnected') : 'Disabled' }}
        </span>
      </template>

      <!-- Actions column -->
      <template #col-actions="{ item: server }">
        <div
          class="flex flex-wrap items-center gap-1.5"
        >
          <button
            class="px-2.5 py-1.5 text-xs bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-md transition-colors"
            @click="startEditing(server)"
          >
            Edit
          </button>

          <button
            v-if="server.enabled && server.pendingAuthUrl && authInProgress !== server.id"
            class="px-2.5 py-1.5 text-xs bg-accent-600 hover:bg-accent-500 text-white rounded-md transition-colors"
            @click="startAuth(server)"
          >
            Authorize
          </button>
          <button
            v-else-if="server.enabled && server.pendingAuthUrl && authInProgress === server.id"
            :disabled="isLoading(server.id)"
            class="px-2.5 py-1.5 text-xs bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white rounded-md transition-colors"
            @click="finishAuth(server.id)"
          >
            {{ isLoading(server.id) ? 'Reconnecting...' : 'Reconnect' }}
          </button>
          <button
            v-else-if="server.enabled"
            class="px-2.5 py-1.5 text-xs bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-md transition-colors"
            :disabled="isLoading(server.id)"
            @click="reconnectServer(server.id)"
          >
            {{ isLoading(server.id) ? 'Connecting...' : 'Reconnect' }}
          </button>

          <button
            type="button"
            class="p-1.5 text-theme-600 hover:text-red-400 rounded-md hover:bg-red-500/10 transition-colors"
            :aria-label="`Remove ${server.name}`"
            @click="promptRemoveServer(server.id)"
          >
            <Icon
              icon="lucide:trash-2"
              class="w-3.5 h-3.5"
            />
          </button>
        </div>
      </template>

      <!-- Enable column -->
      <template #col-enable="{ item: server }">
        <ToggleSwitch
          :model-value="server.enabled"
          :disabled="isLoading(server.id)"
          :label="server.enabled ? `Disable ${server.name}` : `Enable ${server.name}`"
          size="sm"
          color="green"
          :title="server.enabled ? 'Disable' : 'Enable'"
          @update:model-value="toggleServer(server.id)"
          @click.stop
        />
      </template>
    </DataTable>

    <div
      v-else-if="servers.length === 0 && !showAddForm"
      class="text-center py-10 text-theme-500"
    >
      <Icon
        icon="lucide:plug"
        class="w-8 h-8 mx-auto mb-2 text-theme-600"
      />
      <p class="text-lg mb-2">
        No MCP servers installed
      </p>
      <p class="text-sm mb-4">
        Browse the registry to discover and add servers, or add one manually.
      </p>
      <button
        class="text-sm text-accent-400 hover:text-accent-300 transition-colors"
        @click="emit('goToBrowse')"
      >
        Browse Registry ->
      </button>
    </div>

    <ModalDialog
      :show="!!editingServer && !confirmDeleteId"
      title="Edit MCP Server"
      icon="lucide:plug"
      max-width="max-w-2xl"
      @close="cancelEditing"
    >
      <div
        v-if="editingServer"
        class="space-y-4"
      >
        <div class="flex items-center gap-3">
          <img
            v-if="hasUsableIcon(editingServer)"
            :src="editingServer.icon_url"
            :alt="editingServer.name"
            class="w-10 h-10 rounded-lg object-cover"
            @error="onServerIconError(editingServer)"
          >
          <div>
            <p class="text-sm font-medium text-theme-100">
              {{ originalServerName(editingServer) }}
            </p>
            <p class="text-xs text-theme-400">
              {{ editingServer.connected ? 'Connected' : editingServer.enabled ? (editingServer.pendingAuthUrl ? 'Authorization required' : 'Disconnected') : 'Disabled' }}
              · {{ editingServer.toolCount }} tools
              <span v-if="editingServer.origin"> · {{ editingServer.origin }}</span>
            </p>
          </div>
        </div>
        <fieldset
          :disabled="isLoading(editingServer.id)"
          class="space-y-3"
        >
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label class="block text-xs text-theme-400 mb-1">Custom name</label>
              <input
                v-model="editServer.name"
                type="text"
                :placeholder="originalServerName(editingServer)"
                class="w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500"
              >
            </div>
            <div>
              <label class="block text-xs text-theme-400 mb-1">Command</label>
              <input
                v-model="editServer.command"
                type="text"
                class="w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500"
              >
            </div>
          </div>
          <div>
            <label class="block text-xs text-theme-400 mb-1">Description</label>
            <textarea
              v-model="editServer.description"
              rows="2"
              :placeholder="editingServer.description || editingServer.serverInfo?.description || 'What this MCP server is useful for'"
              class="w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-1.5 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
            />
          </div>
          <div>
            <label class="block text-xs text-theme-400 mb-1">Arguments (one per line)</label>
            <textarea
              v-model="editServer.args"
              rows="3"
              class="w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-1.5 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-accent-500"
            />
          </div>
          <div>
            <label class="block text-xs text-theme-400 mb-1">Environment Variables</label>
            <template v-if="editingServer.envHints?.length">
              <div class="space-y-2">
                <div
                  v-for="hint in editingServer.envHints"
                  :key="hint.name"
                >
                  <label class="flex items-center gap-1.5 text-xs text-theme-400 mb-1">
                    <span class="font-mono">{{ hint.name }}</span>
                    <span
                      v-if="hint.required"
                      class="text-red-400/80"
                    >*</span>
                    <span
                      v-if="hint.description"
                      class="text-theme-400/70 font-normal"
                    >- {{ hint.description }}</span>
                  </label>
                  <input
                    v-model="editEnvFields[hint.name]"
                    :type="hint.sensitive ? 'password' : 'text'"
                    :placeholder="hint.name"
                    class="w-full bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
                  >
                </div>
              </div>
              <div class="mt-2">
                <label class="block text-[11px] text-theme-500 mb-1">Additional env vars (KEY=VALUE, one per line)</label>
                <textarea
                  v-model="editServer.env"
                  rows="2"
                  placeholder="EXTRA_VAR=value"
                  class="w-full resize-y bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
                />
              </div>
            </template>
            <template v-else>
              <textarea
                v-model="editServer.env"
                rows="3"
                class="w-full resize-y bg-theme-900 border border-theme-700 text-theme-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
                placeholder="API_KEY=sk-..."
              />
            </template>
          </div>
          <div
            v-if="actionError['edit']"
            class="text-xs text-red-400"
          >
            {{ actionError['edit'] }}
          </div>
        </fieldset>
        <div class="border-t border-theme-800 pt-4 space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-sm text-theme-300">Enable server</span>
            <ToggleSwitch
              :model-value="editingServer.enabled"
              :disabled="isLoading(editingServer.id)"
              label="Enable server"
              size="sm"
              color="green"
              @update:model-value="toggleServer(editingServer.id)"
            />
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-if="editingServer.enabled && editingServer.pendingAuthUrl && authInProgress !== editingServer.id"
              class="px-2.5 py-1.5 text-xs bg-accent-600 hover:bg-accent-500 text-white rounded-md transition-colors"
              :disabled="isLoading(editingServer.id)"
              @click="startAuth(editingServer)"
            >
              Authorize
            </button>
            <button
              v-else-if="editingServer.enabled && editingServer.pendingAuthUrl && authInProgress === editingServer.id"
              :disabled="isLoading(editingServer.id)"
              class="px-2.5 py-1.5 text-xs bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white rounded-md transition-colors"
              @click="finishAuth(editingServer.id)"
            >
              {{ isLoading(editingServer.id) ? 'Reconnecting...' : 'Reconnect' }}
            </button>
            <button
              v-else-if="editingServer.enabled"
              class="px-2.5 py-1.5 text-xs bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-md transition-colors"
              :disabled="isLoading(editingServer.id)"
              @click="reconnectServer(editingServer.id)"
            >
              {{ isLoading(editingServer.id) ? 'Connecting...' : 'Reconnect' }}
            </button>

            <button
              type="button"
              class="p-1.5 text-theme-600 hover:text-red-400 rounded-md hover:bg-red-500/10 transition-colors"
              :aria-label="`Remove ${editingServer.name}`"
              :disabled="isLoading(editingServer.id)"
              @click="promptRemoveServer(editingServer.id)"
            >
              <Icon
                icon="lucide:trash-2"
                class="w-3.5 h-3.5 inline"
              />
              Remove
            </button>

            <button
              v-if="editingServer.enabled && !editingServer.pendingAuthUrl && (editingServer.origin === 'smithery.ai' || editingServer.args.some(a => /^https?:\/\//.test(a) || a === 'mcp-remote'))"
              class="p-1.5 text-theme-600 hover:text-accent-400 rounded-md hover:bg-accent-500/10 transition-colors"
              :disabled="isLoading(editingServer.id)"
              title="Clear cached OAuth tokens and re-authorize"
              @click="reauthServer(editingServer.id)"
            >
              <Icon
                icon="lucide:key"
                class="w-3.5 h-3.5 inline"
              />
              Re-auth
            </button>
          </div>
          <p
            v-if="actionError[editingServer.id]"
            class="text-xs text-red-400"
            role="alert"
          >
            {{ actionError[editingServer.id] }}
          </p>
        </div>
      </div>
      <template #actions>
        <template v-if="editingServer">
          <div class="flex gap-2 justify-end">
            <button
              class="px-3 py-1.5 text-xs bg-theme-700 hover:bg-theme-600 text-theme-300 rounded-md transition-colors"
              :disabled="isSaving"
              @click="cancelEditing"
            >
              Cancel
            </button>
            <button
              :disabled="!editServer.command.trim() || isLoading(editingServer.id)"
              class="px-3 py-1.5 text-xs bg-accent-600 hover:bg-accent-500 disabled:bg-theme-700 disabled:text-theme-500 text-white rounded-md transition-colors"
              @click="saveEditing(editingServer.id)"
            >
              {{ isSaving ? 'Saving...' : 'Save' }}
            </button>
          </div>
        </template>
      </template>
    </ModalDialog>

    <ModalDialog
      :show="!!confirmDeleteId"
      title="Remove MCP Server"
      icon="lucide:trash-2"
      icon-color="red"
      @close="confirmDeleteId = null"
    >
      <template #default>
        <p class="text-sm text-theme-300">
          Are you sure you want to remove
          <span class="font-medium text-theme-100">{{ serverToDelete?.name || serverToDelete?.serverInfo?.title || 'this server' }}</span>?
          This action cannot be undone.
        </p>
      </template>
      <template #actions>
        <div class="flex justify-end gap-2">
          <button
            class="px-4 py-2 text-sm bg-theme-800 hover:bg-theme-700 text-theme-300 rounded-lg transition-colors"
            @click="confirmDeleteId = null"
          >
            Cancel
          </button>
          <button
            class="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors"
            @click="confirmRemoveServer"
          >
            Remove
          </button>
        </div>
      </template>
    </ModalDialog>
  </div>
</template>
