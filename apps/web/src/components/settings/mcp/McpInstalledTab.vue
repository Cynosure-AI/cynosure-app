<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import { api } from '../../../api/client'
import { Icon } from '@iconify/vue'
import DataTable from '../../shared/DataTable.vue'
import ToggleSwitch from '../../shared/ToggleSwitch.vue'
import { useMcpServers } from '../../../composables/useMcpServers'
import type { McpServerInfo } from '../../../api/types'
import type { Column } from '../../shared/DataTable.vue'

const emit = defineEmits<{
  goToBrowse: []
}>()

const { servers, actionError, isLoading, setLoading, loadServers, refreshAll, authInProgress } = useMcpServers()

const showAddForm = ref(false)
const editingId = ref<string | null>(null)
const installedFilter = ref('')
const installedView = ref<'table' | 'json'>('table')
const brokenIconUrlById = reactive<Record<string, string>>({})

// Compute sorted server IDs reactively so it updates when servers load
const sortedServerIds = computed(() => {
  return [...servers.value]
    .sort((a, b) => (a.enabled ? 1 : 0) - (b.enabled ? 1 : 0))
    .reverse()
    .map(s => s.id)
})

function hasUsableIcon(server: McpServerInfo): boolean {
  return !!server.icon_url && brokenIconUrlById[server.id] !== server.icon_url
}

function onServerIconError(server: McpServerInfo): void {
  if (server.icon_url) brokenIconUrlById[server.id] = server.icon_url
}

function originalServerName(server: McpServerInfo): string {
  return server.originalName || server.serverInfo?.title || server.name || 'Server name'
}

// Raw JSON editor (Claude Desktop format)
const rawJson = ref('')
const rawJsonError = ref('')
const rawJsonSaving = ref(false)

function serversToClaudeJson(list: McpServerInfo[]): string {
  const obj: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {}
  for (const s of list) {
    const entry: { command: string; args: string[]; env?: Record<string, string> } = {
      command: s.command,
      args: s.args,
    }
    if (s.env && Object.keys(s.env).length) entry.env = s.env
    obj[s.name] = entry
  }
  return JSON.stringify({ mcpServers: obj }, null, 2)
}

function syncRawJson(): void {
  rawJson.value = serversToClaudeJson(servers.value)
  rawJsonError.value = ''
}

watch(installedView, (v) => {
  if (v === 'json') syncRawJson()
})

async function applyRawJson(): Promise<void> {
  rawJsonError.value = ''
  let parsed: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
  try {
    const root = JSON.parse(rawJson.value)
    parsed = root.mcpServers ?? root
  } catch (e) {
    rawJsonError.value = `Invalid JSON: ${(e as Error).message}`
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    rawJsonError.value = 'Expected an object with server names as keys'
    return
  }
  for (const [name, cfg] of Object.entries(parsed)) {
    if (!cfg || typeof cfg.command !== 'string' || !cfg.command) {
      rawJsonError.value = `Server "${name}" is missing a "command" field`
      return
    }
    if (cfg.args != null && !Array.isArray(cfg.args)) {
      rawJsonError.value = `Server "${name}": "args" must be an array`
      return
    }
  }

  rawJsonSaving.value = true
  try {
    const existingByName = new Map(servers.value.map(s => [s.name, s]))
    const incomingNames = new Set(Object.keys(parsed))

    for (const s of servers.value) {
      if (!incomingNames.has(s.name)) {
        await api.mcp.removeServer(s.id)
      }
    }

    for (const [name, cfg] of Object.entries(parsed)) {
      const args = cfg.args ?? []
      const env = cfg.env && Object.keys(cfg.env).length ? cfg.env : undefined
      const existing = existingByName.get(name)
      if (existing) {
        const argsChanged = JSON.stringify(existing.args) !== JSON.stringify(args)
        const envChanged = JSON.stringify(existing.env) !== JSON.stringify(env ?? {})
        const cmdChanged = existing.command !== cfg.command
        if (cmdChanged || argsChanged || envChanged) {
          await api.mcp.updateServer(existing.id, { name, command: cfg.command, args, env: env ?? {} })
        }
      } else {
        await api.mcp.addServer({ name, command: cfg.command, args, env })
      }
    }

    await refreshAll()
    syncRawJson()
  } catch (e) {
    rawJsonError.value = `Save failed: ${(e as Error).message}`
  } finally {
    rawJsonSaving.value = false
  }
}

const filteredServers = computed(() => {
  const q = installedFilter.value.trim().toLowerCase()
  const serverMap = new Map(servers.value.map(s => [s.id, s]))
  let list = sortedServerIds.value
    .map(id => serverMap.get(id))
    .filter((s): s is McpServerInfo => !!s)

  if (q) {
    list = list.filter(s =>
      s.name.toLowerCase().includes(q) ||
      originalServerName(s).toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.command.toLowerCase().includes(q) ||
      s.args.some(a => a.toLowerCase().includes(q)),
    )
  }

  return list
})

// Table columns definition for DataTable component
const tableColumns: Column[] = [
  { key: 'server', label: 'Server', width: 'minmax(0,1.75fr)' },
  { key: 'tools', label: 'Tools', width: '120px', hideOnMobile: true, hideOnTablet: true },
  { key: 'status', label: 'Status', width: '120px', hideOnMobile: true },
  { key: 'actions', label: 'Actions', width: '200px' },
  { key: 'enable', label: 'Enable', width: '56px', hideOnMobile: true},
]

const newServer = reactive({ name: '', description: '', command: '', args: '', env: '' })
const pendingAddId = ref<string | null>(null)
const editServer = reactive({ name: '', description: '', command: '', args: '', env: '' })
const editEnvFields = reactive<Record<string, string>>({})

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

async function addServer(): Promise<void> {
  if (!newServer.command) return
  setLoading('add', true)
  try {
    const args = newServer.args ? newServer.args.split('\n').map(a => a.trim()).filter(Boolean) : []
    const env = textToEnv(newServer.env)
    const customName = newServer.name.trim() || null

    // If we already created a server that failed to connect, update it instead of creating a duplicate
    if (pendingAddId.value) {
      const result = await api.mcp.updateServer(pendingAddId.value, {
        customName,
        description: newServer.description,
        command: newServer.command,
        args,
        env,
      })
      if (result.error) {
        actionError.value['add'] = result.error
      } else {
        showAddForm.value = false
        Object.assign(newServer, { name: '', description: '', command: '', args: '', env: '' })
        actionError.value = {}
        pendingAddId.value = null
      }
    } else {
      const result = await api.mcp.addServer({
        customName,
        description: newServer.description,
        command: newServer.command,
        args,
        env: Object.keys(env).length ? env : undefined,
      })
      if (result.error) {
        actionError.value['add'] = result.error
        // If server was created but failed to connect, remember its id so next "Add" updates instead of duplicates
        if (result.id) {
          pendingAddId.value = result.id
        }
      } else {
        showAddForm.value = false
        Object.assign(newServer, { name: '', description: '', command: '', args: '', env: '' })
        actionError.value = {}
        pendingAddId.value = null
      }
    }
    await refreshAll()
  } finally {
    setLoading('add', false)
  }
}

function cancelForm(): void {
  showAddForm.value = false
  Object.assign(newServer, { name: '', description: '', command: '', args: '', env: '' })
  delete actionError.value['add']
  pendingAddId.value = null
}

function startEditing(server: McpServerInfo): void {
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
  editingId.value = null
  delete actionError.value['edit']
}

async function saveEditing(id: string): Promise<void> {
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
      command: editServer.command,
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
  } finally {
    setLoading(id, false)
  }
}

async function toggleServer(id: string): Promise<void> {
  const result = await api.mcp.toggleServer(id)
  if (result.error) actionError.value[id] = result.error
  else delete actionError.value[id]
  await refreshAll()
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

async function removeServer(id: string): Promise<void> {
  await api.mcp.removeServer(id)
  delete actionError.value[id]
  await refreshAll()
}

defineExpose({ loadServers })
</script>

<template>
  <div>
    <div class="flex flex-col gap-3 mb-4 md:flex-row md:items-center md:justify-between">
      <button
        v-if="installedView === 'table'"
        class="h-10 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors self-start"
        @click="showAddForm ? cancelForm() : (showAddForm = true)"
      >
        {{ showAddForm ? 'Cancel' : 'Add Manually' }}
      </button>

      <div class="flex items-center gap-2 w-full md:w-auto md:min-w-130">
        <div
          v-if="installedView === 'table'"
          class="relative flex-1"
        >
          <Icon
            icon="lucide:search"
            class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500"
          />
          <input
            v-model="installedFilter"
            type="text"
            placeholder="Filter installed servers..."
            class="h-10 w-full pl-9 pr-3 bg-zinc-900/80 border border-zinc-700 text-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
          >
        </div>

        <div class="flex bg-zinc-900/80 border border-zinc-700 rounded-lg p-0.5 shrink-0">
          <button
            class="px-2.5 py-1.5 text-xs rounded-md transition-colors"
            :class="installedView === 'table' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'"
            title="Table view"
            @click="installedView = 'table'"
          >
            <Icon
              icon="lucide:list"
              class="w-4 h-4"
            />
          </button>
          <button
            class="px-2.5 py-1.5 text-xs rounded-md transition-colors"
            :class="installedView === 'json' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'"
            title="Raw JSON view"
            @click="installedView = 'json'"
          >
            <Icon
              icon="lucide:braces"
              class="w-4 h-4"
            />
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="showAddForm && installedView === 'table'"
      class="bg-zinc-900/60 border border-zinc-700 rounded-xl p-4 mb-6 space-y-4"
    >
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label class="block text-sm text-zinc-400 mb-1">Custom name</label>
          <input
            v-model="newServer.name"
            type="text"
            placeholder="Use original MCP name"
            class="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
          >
        </div>
        <div>
          <label class="block text-sm text-zinc-400 mb-1">Command</label>
          <input
            v-model="newServer.command"
            type="text"
            placeholder="npx"
            class="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
          >
        </div>
      </div>
      <div>
        <label class="block text-sm text-zinc-400 mb-1">Description</label>
        <textarea
          v-model="newServer.description"
          rows="2"
          placeholder="What this MCP server is useful for"
          class="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
        />
      </div>
      <div>
        <label class="block text-sm text-zinc-400 mb-1">Arguments (one per line)</label>
        <textarea
          v-model="newServer.args"
          rows="3"
          placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/path/to/dir"
          class="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
        />
      </div>
      <div>
        <label class="block text-sm text-zinc-400 mb-1">Environment Variables (KEY=VALUE, one per line)</label>
        <textarea
          v-model="newServer.env"
          rows="2"
          placeholder="API_KEY=sk-..."
          class="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
        />
      </div>
      <div
        v-if="actionError['add']"
        class="text-xs text-red-400"
      >
        {{ actionError['add'] }}
      </div>
      <button
        :disabled="!newServer.command || isLoading('add')"
        class="w-full px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm rounded-lg transition-colors"
        @click="addServer"
      >
        {{ isLoading('add') ? 'Connecting...' : pendingAddId ? 'Save & Reconnect' : 'Add Server' }}
      </button>
    </div>

    <template v-if="installedView === 'table'">
      <DataTable
        v-if="filteredServers.length"
        :items="filteredServers"
        :columns="tableColumns"
        empty-message="No servers found"
      >
        <!-- Server column -->
        <template #col-server="{ item: server }">
          <div
            v-if="editingId === server.id"
            class="space-y-3 py-2"
          >
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs text-zinc-400 mb-1">Custom name</label>
                <input
                  v-model="editServer.name"
                  type="text"
                  :placeholder="originalServerName(server)"
                  class="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
              </div>
              <div>
                <label class="block text-xs text-zinc-400 mb-1">Command</label>
                <input
                  v-model="editServer.command"
                  type="text"
                  class="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
              </div>
            </div>
            <div>
              <label class="block text-xs text-zinc-400 mb-1">Description</label>
              <textarea
                v-model="editServer.description"
                rows="2"
                :placeholder="server.description || server.serverInfo?.description || 'What this MCP server is useful for'"
                class="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-1.5 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
              />
            </div>
            <div>
              <label class="block text-xs text-zinc-400 mb-1">Arguments (one per line)</label>
              <textarea
                v-model="editServer.args"
                rows="3"
                class="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-1.5 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label class="block text-xs text-zinc-400 mb-1">Environment Variables</label>
              <template v-if="server.envHints?.length">
                <div class="space-y-2">
                  <div
                    v-for="hint in server.envHints"
                    :key="hint.name"
                  >
                    <label class="flex items-center gap-1.5 text-xs text-zinc-400 mb-1">
                      <span class="font-mono">{{ hint.name }}</span>
                      <span
                        v-if="hint.required"
                        class="text-red-400/80"
                      >*</span>
                      <span
                        v-if="hint.description"
                        class="text-zinc-400/70 font-normal"
                      >- {{ hint.description }}</span>
                    </label>
                    <input
                      v-model="editEnvFields[hint.name]"
                      :type="hint.sensitive ? 'password' : 'text'"
                      :placeholder="hint.name"
                      class="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
                    >
                  </div>
                </div>
                <div class="mt-2">
                  <label class="block text-[11px] text-zinc-500 mb-1">Additional env vars (KEY=VALUE, one per line)</label>
                  <textarea
                    v-model="editServer.env"
                    rows="2"
                    placeholder="EXTRA_VAR=value"
                    class="w-full resize-y bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
                  />
                </div>
              </template>
              <template v-else>
                <textarea
                  v-model="editServer.env"
                  rows="3"
                  class="w-full resize-y bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
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
            <div class="flex gap-2 justify-end">
              <button
                class="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded-md transition-colors"
                @click="cancelEditing"
              >
                Cancel
              </button>
              <button
                :disabled="!editServer.command || isLoading(server.id)"
                class="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-md transition-colors"
                @click="saveEditing(server.id)"
              >
                {{ isLoading(server.id) ? 'Saving...' : 'Save & Reconnect' }}
              </button>
            </div>
          </div>
          <div
            v-else
            class="min-w-0 flex items-start gap-3"
          >
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
                :class="server.connected ? 'bg-blue-500/15 text-blue-300' : 'bg-zinc-700/50 text-zinc-500'"
              >
                <Icon
                  icon="lucide:plug"
                  class="w-5 h-5"
                />
              </div>
              <div
                class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-zinc-900"
                :class="server.connected ? 'bg-emerald-500' : server.enabled ? 'bg-blue-400' : 'bg-zinc-500'"
              />
            </div>

            <div class="min-w-0">
              <div class="text-sm font-medium text-zinc-100 truncate">
                {{ server.name || server.serverInfo?.title }}
              </div>
              <div
                v-if="server.description || server.serverInfo?.description"
                class="text-xs text-zinc-400 mt-0.5 line-clamp-2"
              >
                {{ server.description || server.serverInfo?.description }}
              </div>
              <div class="text-xs text-zinc-500 mt-1 truncate font-mono">
                {{ server.command }} {{ server.args.join(' ') }}
              </div>
              <div
                v-if="server.envHints?.length && server.envHints.some(h => h.required && !server.env[h.name])"
                class="text-[11px] text-blue-400/90 mt-1"
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
          <span
            v-if="!editingId || editingId !== server.id"
            class="inline-flex items-center text-[11px] px-2 py-1 rounded-md"
            :class="server.toolCount > 0 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-700/60 text-zinc-400'"
          >
            {{ server.toolCount }} {{ server.toolCount === 1 ? 'tool' : 'tools' }}
          </span>
        </template>

        <!-- Status column -->
        <template #col-status="{ item: server }">
          <span
            v-if="!editingId || editingId !== server.id"
            class="inline-flex items-center gap-1.5 text-xs"
            :class="server.connected ? 'text-emerald-400' : server.enabled ? (server.pendingAuthUrl ? 'text-blue-400' : 'text-red-400') : 'text-zinc-500'"
          >
            <span
              class="w-1.5 h-1.5 rounded-full"
              :class="server.connected ? 'bg-emerald-400' : server.enabled ? (server.pendingAuthUrl ? 'bg-blue-400' : 'bg-red-400') : 'bg-zinc-500'"
            />
            {{ server.connected ? 'Connected' : server.enabled ? (server.pendingAuthUrl ? 'Authorization required' : 'Disconnected') : 'Disabled' }}
          </span>
        </template>

        <!-- Actions column -->
        <template #col-actions="{ item: server }">
          <div
            v-if="!editingId || editingId !== server.id"
            class="flex flex-wrap items-center gap-1.5"
          >
            <button
              class="px-2.5 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md transition-colors"
              @click="startEditing(server)"
            >
              Edit
            </button>

            <button
              v-if="server.enabled && server.pendingAuthUrl && authInProgress !== server.id"
              class="px-2.5 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
              @click="startAuth(server)"
            >
              Authorize
            </button>
            <button
              v-else-if="server.enabled && server.pendingAuthUrl && authInProgress === server.id"
              :disabled="isLoading(server.id)"
              class="px-2.5 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-md transition-colors"
              @click="finishAuth(server.id)"
            >
              {{ isLoading(server.id) ? 'Reconnecting...' : 'Reconnect' }}
            </button>
            <button
              v-else-if="server.enabled"
              class="px-2.5 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md transition-colors"
              :disabled="isLoading(server.id)"
              @click="reconnectServer(server.id)"
            >
              {{ isLoading(server.id) ? 'Connecting...' : 'Reconnect' }}
            </button>

            <button
              class="p-1.5 text-zinc-600 hover:text-red-400 rounded-md hover:bg-red-500/10 transition-colors"
              @click="removeServer(server.id)"
            >
              <Icon
                icon="lucide:trash-2"
                class="w-3.5 h-3.5"
              />
            </button>

            <button
              v-if="server.enabled && !server.pendingAuthUrl && (server.origin === 'smithery.ai' || server.args.some(a => /^https?:\/\//.test(a) || a === 'mcp-remote'))"
              class="p-1.5 text-zinc-600 hover:text-blue-400 rounded-md hover:bg-blue-500/10 transition-colors"
              :disabled="isLoading(server.id)"
              title="Clear cached OAuth tokens and re-authorize"
              @click="reauthServer(server.id)"
            >
              <Icon
                icon="lucide:key"
                class="w-3.5 h-3.5"
              />
            </button>
          </div>
        </template>

        <!-- Enable column -->
        <template #col-enable="{ item: server }">
          <ToggleSwitch
            v-if="!editingId || editingId !== server.id"
            :model-value="server.enabled"
            size="sm"
            color="green"
            :title="server.enabled ? 'Disable' : 'Enable'"
            @update:model-value="toggleServer(server.id)"
          />
        </template>
      </DataTable>

      <div
        v-else-if="servers.length === 0 && !showAddForm"
        class="text-center py-10 text-zinc-500"
      >
        <Icon
          icon="lucide:plug"
          class="w-8 h-8 mx-auto mb-2 text-zinc-600"
        />
        <p class="text-lg mb-2">
          No MCP servers installed
        </p>
        <p class="text-sm mb-4">
          Browse the registry to discover and add servers, or add one manually.
        </p>
        <button
          class="text-sm text-blue-400 hover:text-blue-300 transition-colors"
          @click="emit('goToBrowse')"
        >
          Browse Registry ->
        </button>
      </div>
    </template>

    <template v-if="installedView === 'json'">
      <div class="rounded-xl border border-zinc-800 bg-zinc-950/45 p-4">
        <p class="text-xs text-zinc-500 mb-3">
          Edit servers in Claude Desktop JSON format. Changes are applied when you click Save.
        </p>
        <textarea
          v-model="rawJson"
          spellcheck="false"
          rows="18"
          class="w-full bg-zinc-950 border border-zinc-700 text-zinc-200 rounded-lg px-4 py-3 text-sm font-mono resize-y focus:outline-none focus:ring-1 focus:ring-blue-500 leading-relaxed"
          :class="rawJsonError ? 'border-red-500/60' : ''"
        />
        <div
          v-if="rawJsonError"
          class="mt-2 text-xs text-red-400"
        >
          {{ rawJsonError }}
        </div>
        <div class="flex items-center justify-between mt-3">
          <button
            class="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded-md transition-colors"
            @click="syncRawJson"
          >
            Reset
          </button>
          <button
            :disabled="rawJsonSaving"
            class="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg transition-colors"
            @click="applyRawJson"
          >
            {{ rawJsonSaving ? 'Saving...' : 'Save & Apply' }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
