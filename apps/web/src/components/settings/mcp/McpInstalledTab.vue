<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import { api } from '../../../api/client'
import { Icon } from '@iconify/vue'
import ToggleSwitch from '../../shared/ToggleSwitch.vue'
import { useMcpServers } from '../../../composables/useMcpServers'
import type { McpServerInfo } from '../../../api/types'

const emit = defineEmits<{
  goToBrowse: []
}>()

const { servers, actionError, isLoading, setLoading, loadServers, refreshAll, authInProgress } = useMcpServers()

const showAddForm = ref(false)
const editingId = ref<string | null>(null)
const installedFilter = ref('')
const installedView = ref<'cards' | 'json'>('cards')

// --- Raw JSON editor ---
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
  const list = q
    ? servers.value.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q) ||
        s.args.some(a => a.toLowerCase().includes(q)),
      )
    : servers.value
  return [...list].reverse()
})

const newServer = reactive({ name: '', command: '', args: '', env: '' })
const editServer = reactive({ name: '', command: '', args: '', env: '' })
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
  if (!newServer.name || !newServer.command) return
  setLoading('add', true)
  try {
    const args = newServer.args ? newServer.args.split('\n').map(a => a.trim()).filter(Boolean) : []
    const env = textToEnv(newServer.env)
    const result = await api.mcp.addServer({
      name: newServer.name,
      command: newServer.command,
      args,
      env: Object.keys(env).length ? env : undefined,
    })
    if (result.error) {
      actionError.value['add'] = result.error
    } else {
      showAddForm.value = false
      Object.assign(newServer, { name: '', command: '', args: '', env: '' })
      actionError.value = {}
    }
    await refreshAll()
  } finally {
    setLoading('add', false)
  }
}

function cancelForm(): void {
  showAddForm.value = false
  Object.assign(newServer, { name: '', command: '', args: '', env: '' })
  delete actionError.value['add']
}

function startEditing(server: McpServerInfo): void {
  editingId.value = server.id
  editServer.name = server.name
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
      name: editServer.name,
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
    <div class="flex gap-2 mb-4">
      <!-- View toggle -->
      <div class="flex bg-zinc-800 border border-zinc-700 rounded-lg p-0.5 shrink-0">
        <button
          class="px-2.5 py-1.5 text-xs rounded-md transition-colors"
          :class="installedView === 'cards' ? 'bg-zinc-600 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'"
          title="Graphical editor"
          @click="installedView = 'cards'"
        >
          <Icon
            icon="lucide:layout-grid"
            class="w-4 h-4"
          />
        </button>
        <button
          class="px-2.5 py-1.5 text-xs rounded-md transition-colors"
          :class="installedView === 'json' ? 'bg-zinc-600 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'"
          title="Raw JSON (Claude Desktop format)"
          @click="installedView = 'json'"
        >
          <Icon
            icon="lucide:braces"
            class="w-4 h-4"
          />
        </button>
      </div>

      <div
        v-if="installedView === 'cards'"
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
          class="w-full pl-9 pr-3 py-2 bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
        >
      </div>
      <button
        v-if="installedView === 'cards'"
        class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
        @click="showAddForm ? cancelForm() : (showAddForm = true)"
      >
        {{ showAddForm ? 'Cancel' : 'Add Manually' }}
      </button>
    </div>

    <!-- ── Raw JSON View ── -->
    <div v-if="installedView === 'json'">
      <p class="text-xs text-zinc-500 mb-3">
        Edit servers in <span class="text-zinc-400">Claude Desktop</span> JSON format. Changes are applied when you click Save.
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

    <!-- ── Cards View ── -->
    <template v-if="installedView === 'cards'">
      <!-- Manual Add Form -->
      <div
        v-if="showAddForm"
        class="bg-zinc-800 border border-zinc-700 rounded-xl p-4 mb-6 space-y-4"
      >
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm text-zinc-400 mb-1">Name</label>
            <input
              v-model="newServer.name"
              type="text"
              placeholder="My MCP Server"
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
          :disabled="!newServer.name || !newServer.command || isLoading('add')"
          class="w-full px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm rounded-lg transition-colors"
          @click="addServer"
        >
          {{ isLoading('add') ? 'Connecting...' : 'Add Server' }}
        </button>
      </div>

      <!-- Server List -->
      <div class="space-y-3">
        <div
          v-for="server in filteredServers"
          :key="server.id"
          class="bg-zinc-800 border border-zinc-700 rounded-xl p-4"
        >
          <!-- Edit mode -->
          <template v-if="editingId === server.id">
            <div class="space-y-3">
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs text-zinc-400 mb-1">Name</label>
                  <input
                    v-model="editServer.name"
                    type="text"
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
                <label class="block text-xs text-zinc-400 mb-1">Arguments (one per line)</label>
                <textarea
                  v-model="editServer.args"
                  rows="3"
                  class="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-3 py-1.5 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label class="block text-xs text-zinc-400 mb-1">Environment Variables</label>
                <!-- Structured env inputs when envHints are available -->
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
                        >— {{ hint.description }}</span>
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
                <!-- Fallback raw textarea when no envHints -->
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
                  :disabled="!editServer.name || !editServer.command || isLoading(server.id)"
                  class="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-md transition-colors"
                  @click="saveEditing(server.id)"
                >
                  {{ isLoading(server.id) ? 'Saving...' : 'Save & Reconnect' }}
                </button>
              </div>
            </div>
          </template>

          <!-- Display mode -->
          <template v-else>
            <div class="flex items-start gap-3">
              <!-- Icon with status dot -->
              <div class="relative shrink-0">
                <img
                  v-if="server.icon_url"
                  :src="server.icon_url"
                  class="w-10 h-10 rounded-lg object-cover"
                  :class="!server.connected && 'opacity-40 grayscale'"
                >
                <div
                  v-else
                  class="w-10 h-10 rounded-lg flex items-center justify-center"
                  :class="server.connected ? 'bg-blue-500/10 text-blue-400' : 'bg-zinc-700/50 text-zinc-500'"
                >
                  <Icon
                    icon="lucide:plug"
                    class="w-5 h-5"
                  />
                </div>
                <div
                  class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-zinc-800"
                  :class="server.connected ? 'bg-green-500' : server.enabled ? 'bg-red-500' : 'bg-zinc-500'"
                />
              </div>

              <!-- Info -->
              <div class="flex-1 min-w-0 pt-0.5">
                <span class="font-medium text-sm text-zinc-200">{{ server.name || server.serverInfo?.title }}</span>
                <div
                  v-if="server.serverInfo?.description"
                  class="text-xs text-zinc-400 mt-0.5"
                >
                  {{ server.serverInfo.description }}
                </div>
                <div class="text-xs text-zinc-500 mt-0.5 truncate font-mono">
                  {{ server.command }} {{ server.args.join(' ') }}
                </div>
                <div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <span
                    v-if="server.origin"
                    class="text-[11px] leading-none px-1.5 py-0.5 bg-zinc-700/60 text-zinc-400 rounded"
                  >
                    {{ server.origin }}
                  </span>
                  <span
                    v-if="server.connected"
                    class="text-[11px] leading-none px-1.5 py-0.5 bg-green-500/10 text-green-400 rounded"
                  >
                    {{ server.toolCount }} {{ server.toolCount === 1 ? 'tool' : 'tools' }}
                  </span>
                  <span
                    v-else-if="server.enabled && server.pendingAuthUrl"
                    class="text-[11px] leading-none px-1.5 py-0.5 bg-amber-500/10 text-amber-400 rounded"
                  >
                    auth required
                  </span>
                  <span
                    v-else-if="server.enabled"
                    class="text-[11px] leading-none px-1.5 py-0.5 bg-red-500/10 text-red-400 rounded"
                  >
                    disconnected
                  </span>
                  <span
                    v-else
                    class="text-[11px] leading-none px-1.5 py-0.5 bg-zinc-600/20 text-zinc-500 rounded"
                  >
                    disabled
                  </span>
                </div>
                <!-- Env var hints when server has missing required env vars -->
                <div
                  v-if="server.envHints?.length && server.envHints.some(h => h.required && !server.env[h.name])"
                  class="mt-2 flex items-center gap-1.5 text-[11px] text-amber-400/80"
                >
                  <Icon
                    icon="lucide:key"
                    class="w-3 h-3 shrink-0"
                  />
                  <span>Requires: {{ server.envHints.filter(h => h.required && !server.env[h.name]).map(h => h.name).join(', ') }}</span>
                </div>
              </div>

              <!-- Actions -->
              <div class="flex items-center gap-1.5 shrink-0 pt-0.5">
                <button
                  class="px-2.5 py-1.5 text-xs bg-zinc-700/60 hover:bg-zinc-600 text-zinc-300 rounded-md transition-colors"
                  @click="startEditing(server)"
                >
                  Edit
                </button>

                <button
                  v-if="server.enabled && !server.pendingAuthUrl"
                  class="px-2.5 py-1.5 text-xs bg-zinc-700/60 hover:bg-zinc-600 text-zinc-300 rounded-md transition-colors"
                  :disabled="isLoading(server.id)"
                  @click="reconnectServer(server.id)"
                >
                  {{ isLoading(server.id) ? 'Connecting...' : 'Reconnect' }}
                </button>
                <button
                  v-if="server.enabled && !server.pendingAuthUrl && (server.origin === 'smithery.ai' || server.args.some(a => /^https?:\/\//.test(a) || a === 'mcp-remote'))"
                  class="px-2.5 py-1.5 text-xs bg-amber-700/60 hover:bg-amber-600 text-amber-200 rounded-md transition-colors"
                  :disabled="isLoading(server.id)"
                  title="Clear cached OAuth tokens and re-authorize"
                  @click="reauthServer(server.id)"
                >
                  <Icon
                    icon="lucide:key-round"
                    class="w-3 h-3 inline -mt-0.5 mr-1"
                  />
                  Re-Auth
                </button>
                <ToggleSwitch
                  :model-value="server.enabled"
                  size="sm"
                  color="green"
                  :title="server.enabled ? 'Disable' : 'Enable'"
                  @update:model-value="toggleServer(server.id)"
                />
                <button
                  class="p-1.5 text-zinc-600 hover:text-red-400 rounded-md hover:bg-red-500/10 transition-colors"
                  @click="removeServer(server.id)"
                >
                  <Icon
                    icon="lucide:trash-2"
                    class="w-3.5 h-3.5"
                  />
                </button>
              </div>
            </div>

            <!-- Auth required button -->
            <div
              v-if="server.pendingAuthUrl && !server.connected && server.enabled"
              class="mt-3 pt-3 border-t border-zinc-700"
            >
              <div
                v-if="authInProgress !== server.id"
                class="flex items-center gap-3"
              >
                <div class="flex items-center gap-2 text-amber-400 text-xs">
                  <Icon
                    icon="lucide:shield-alert"
                    class="w-4 h-4"
                  />
                  <span>This server requires authorization before it can connect.</span>
                </div>
                <button
                  class="shrink-0 px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-md transition-colors font-medium"
                  @click="startAuth(server)"
                >
                  Authorize
                </button>
              </div>
              <div
                v-else
                class="flex items-center gap-3"
              >
                <span class="text-xs text-zinc-400">Complete authorization in the opened tab, then:</span>
                <button
                  class="shrink-0 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors font-medium"
                  :disabled="isLoading(server.id)"
                  @click="finishAuth(server.id)"
                >
                  {{ isLoading(server.id) ? 'Reconnecting...' : 'Reconnect' }}
                </button>
              </div>
            </div>

            <div
              v-if="actionError[server.id]"
              class="mt-2 text-xs text-red-400"
            >
              {{ actionError[server.id] }}
            </div>
          </template>
        </div>

        <div
          v-if="servers.length === 0 && !showAddForm"
          class="text-center py-8 text-zinc-500"
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
            Browse Registry →
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
