<template>
  <div class="max-w-2xl mx-auto px-4 py-6 w-full">
    <div class="mb-6">
      <h2 class="text-xl font-bold text-theme-100">
        Add MCP Tools
      </h2>
      <p class="text-sm text-theme-500 mt-1">
        Extend your agents with installable tools. The official Cynosure MCP is pinned first;
        everything here is optional and can also be added later in
        <strong class="text-theme-400">Settings → MCPs</strong>.
      </p>
    </div>

    <div
      v-if="registryLoading"
      class="flex items-center gap-2 text-sm text-theme-500 py-8"
    >
      <Icon
        icon="lucide:loader-2"
        class="w-4 h-4 animate-spin"
      />
      Loading recommended MCP servers...
    </div>

    <div
      v-if="registryError && !registryLoading"
      class="mb-3 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3"
    >
      Recommended tools could not be loaded: {{ registryError }}. The Cynosure MCP is still available below.
    </div>

    <div
      v-if="!registryLoading"
      class="space-y-3"
    >
      <div
        v-for="mcp in mcpOptions"
        :key="mcp.id"
        class="bg-theme-800/50 border border-theme-700/60 rounded-xl overflow-hidden"
      >
        <div class="flex items-center gap-4 p-4">
          <!-- Icon -->
          <div
            class="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
            :class="mcp.iconBg"
          >
            <Icon
              :icon="mcp.icon"
              class="w-5 h-5"
              :class="mcp.iconColor"
            />
          </div>

          <!-- Info -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold text-theme-100">{{ mcp.name }}</span>
              <span
                v-if="mcp.badge"
                class="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                :class="mcp.badgeClass"
              >{{ mcp.badge }}</span>
            </div>
            <p class="text-xs text-theme-500 mt-0.5">
              {{ mcp.description }}
            </p>
            <p class="text-[11px] text-theme-600 mt-0.5 font-mono">
              {{ mcp.packageId }}
            </p>
          </div>

          <!-- Action -->
          <div class="shrink-0">
            <div
              v-if="installedIds.has(mcp.id)"
              class="flex items-center gap-1.5 text-emerald-400"
            >
              <Icon
                icon="lucide:check-circle-2"
                class="w-4 h-4"
              />
              <span class="text-xs font-medium">Installed</span>
            </div>
            <button
              v-else
              class="flex items-center gap-1.5 px-3 py-1.5 bg-theme-700 hover:bg-theme-600 disabled:opacity-50 text-theme-300 text-xs font-medium rounded-lg transition-colors"
              :disabled="loadingId === mcp.id"
              @click="installMcp(mcp)"
            >
              <Icon
                :icon="loadingId === mcp.id ? 'lucide:loader-2' : 'lucide:download'"
                class="w-3.5 h-3.5"
                :class="{ 'animate-spin': loadingId === mcp.id }"
              />
              {{ loadingId === mcp.id ? 'Installing…' : 'Install' }}
            </button>
          </div>
        </div>

        <!-- Expandable env config for servers that need it -->
        <div
          v-if="expandedId === mcp.id && mcp.envVars?.length"
          class="px-4 pb-4 border-t border-theme-700/40 pt-4 space-y-3"
        >
          <p class="text-xs text-theme-400 font-medium">
            Configuration Required
          </p>
          <div
            v-for="envVar in mcp.envVars"
            :key="envVar.name"
          >
            <label class="block text-xs text-theme-500 mb-1">
              {{ envVar.label }}
              <span
                v-if="envVar.required"
                class="text-red-400"
              > *</span>
            </label>
            <input
              v-model="envValues[mcp.id + ':' + envVar.name]"
              :type="envVar.secret ? 'password' : 'text'"
              :placeholder="envVar.placeholder"
              class="w-full bg-theme-900 border border-theme-600 text-theme-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 placeholder-theme-600"
            >
          </div>
          <div class="flex gap-2">
            <button
              class="flex items-center gap-1.5 px-3 py-2 bg-accent-600 hover:bg-accent-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
              :disabled="loadingId === mcp.id || !canInstallWithEnv(mcp)"
              @click="installWithEnv(mcp)"
            >
              <Icon
                :icon="loadingId === mcp.id ? 'lucide:loader-2' : 'lucide:download'"
                class="w-3.5 h-3.5"
                :class="{ 'animate-spin': loadingId === mcp.id }"
              />
              {{ loadingId === mcp.id ? 'Installing…' : 'Install' }}
            </button>
            <button
              class="px-3 py-2 text-theme-500 hover:text-theme-300 text-xs transition-colors"
              @click="expandedId = null"
            >
              Cancel
            </button>
          </div>
        </div>

        <!-- Error -->
        <div
          v-if="errors[mcp.id]"
          class="px-4 pb-3 text-xs text-red-400"
        >
          {{ errors[mcp.id] }}
        </div>
      </div>
    </div>

    <!-- Filesystem path note -->
    <div
      v-if="filesystemExpanded"
      class="mt-3 flex items-start gap-2 text-xs text-theme-500 bg-theme-900/60 border border-theme-800 rounded-lg px-4 py-3"
    >
      <Icon
        icon="lucide:info"
        class="w-3.5 h-3.5 mt-0.5 shrink-0"
      />
      <span>The Filesystem MCP will have access to the directory you specify. You can update this in Settings → MCPs after installation.</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../../api/client'
import type { McpRegistryServer } from '../../api/types'
import { useMcpServers } from '../../composables/useMcpServers'

const { servers, loadServers } = useMcpServers()

const loadingId = ref<string | null>(null)
const expandedId = ref<string | null>(null)
const installedIds = ref<Set<string>>(new Set())
const errors = reactive<Record<string, string>>({})
const envValues = reactive<Record<string, string>>({})
const filesystemExpanded = ref(false)
const registryLoading = ref(false)
const registryError = ref('')

interface EnvVar {
  name: string
  label: string
  placeholder: string
  required: boolean
  secret?: boolean
  description?: string
}

interface McpOption {
  id: string
  name: string
  description: string
  packageId: string
  icon: string
  iconBg: string
  iconColor: string
  badge?: string
  badgeClass?: string
  command: string
  args: string[]
  argEnvNames: Set<string>
  envVars?: EnvVar[]
  installId?: string // substring to check if already installed
}

const mcpOptions = ref<McpOption[]>([])
const cynosureMcp: McpOption = {
  id: 'cynosure',
  name: 'Cynosure MCP',
  description: 'Manage Cynosure agents, conversations, memory, providers, MCP servers, and settings.',
  packageId: '@cynosure-mcp/cynosure@latest',
  icon: 'lucide:sparkles',
  iconBg: 'bg-accent-500/10',
  iconColor: 'text-accent-400',
  badge: 'Recommended',
  badgeClass: 'bg-accent-500/20 text-accent-400',
  command: 'npx',
  args: ['-y', '@cynosure-mcp/cynosure@latest'],
  argEnvNames: new Set(),
  installId: '@cynosure-mcp/cynosure',
}

const iconByName: Record<string, Pick<McpOption, 'icon' | 'iconBg' | 'iconColor'>> = {
  time: { icon: 'lucide:clock', iconBg: 'bg-cyan-500/10', iconColor: 'text-cyan-400' },
  tavily: { icon: 'lucide:search', iconBg: 'bg-emerald-500/10', iconColor: 'text-emerald-400' },
  weather: { icon: 'lucide:cloud-sun', iconBg: 'bg-sky-500/10', iconColor: 'text-sky-400' },
  chrome: { icon: 'lucide:globe', iconBg: 'bg-amber-500/10', iconColor: 'text-amber-400' },
  computer: { icon: 'lucide:monitor', iconBg: 'bg-violet-500/10', iconColor: 'text-violet-400' },
  filesystem: { icon: 'lucide:folder-open', iconBg: 'bg-theme-600/40', iconColor: 'text-theme-300' },
  gmail: { icon: 'lucide:mail', iconBg: 'bg-red-500/10', iconColor: 'text-red-400' },
  github: { icon: 'lucide:github', iconBg: 'bg-theme-600/40', iconColor: 'text-theme-100' },
  youtube: { icon: 'lucide:youtube', iconBg: 'bg-red-500/10', iconColor: 'text-red-400' },
  cynosure: { icon: 'lucide:sparkles', iconBg: 'bg-accent-500/10', iconColor: 'text-accent-400' },
  media: { icon: 'lucide:file-cog', iconBg: 'bg-indigo-500/10', iconColor: 'text-indigo-400' },
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function getDisplayName(srv: McpRegistryServer['server']): string {
  return srv.title || srv.name.split('/').pop() || srv.name
}

function getIcon(srv: McpRegistryServer['server']): Pick<McpOption, 'icon' | 'iconBg' | 'iconColor'> {
  const haystack = `${srv.name} ${srv.title || ''}`.toLowerCase()
  const match = Object.entries(iconByName).find(([key]) => haystack.includes(key))
  return match?.[1] || { icon: 'lucide:puzzle', iconBg: 'bg-theme-600/40', iconColor: 'text-theme-300' }
}

function getBadge(pkgType: string): Pick<McpOption, 'badge' | 'badgeClass'> {
  if (pkgType === 'smithery') return { badge: 'Smithery', badgeClass: 'bg-accent-500/20 text-accent-400' }
  if (pkgType === 'pypi') return { badge: 'PyPI', badgeClass: 'bg-indigo-500/20 text-indigo-300' }
  return { badge: 'npm', badgeClass: 'bg-theme-600/60 text-theme-300' }
}

function getInstallOption(entry: McpRegistryServer): McpOption | null {
  const srv = entry.server
  const pkg = srv.packages?.find(p => p.transport?.type === 'stdio' || p.registryType === 'smithery')
  if (!pkg) return null

  const packageArgs = (pkg.arguments || []).map(arg => arg.fromEnv ? `\${${arg.fromEnv}}` : (arg.value || '')).filter(Boolean)
  const argEnvNames = new Set((pkg.arguments || []).map(arg => arg.fromEnv).filter((name): name is string => Boolean(name)))
  const pkgType = pkg.registryType
  const command = pkgType === 'pypi' ? 'uvx' : 'npx'
  const args = pkgType === 'smithery'
    ? ['-y', '@smithery/cli@latest', 'run', pkg.identifier, ...packageArgs]
    : pkgType === 'pypi'
      ? [pkg.identifier, ...packageArgs]
      : ['-y', pkg.identifier, ...packageArgs]

  return {
    id: slugify(srv.name),
    name: getDisplayName(srv),
    description: srv.description || 'Recommended MCP server.',
    packageId: pkgType === 'smithery' ? `${pkg.identifier} (Smithery)` : pkg.identifier,
    ...getIcon(srv),
    ...getBadge(pkgType),
    command,
    args,
    argEnvNames,
    envVars: (pkg.environmentVariables || []).map(v => ({
      name: v.name,
      label: v.name,
      placeholder: v.description || v.name,
      required: v.isRequired,
      secret: v.format === 'password' || /token|key|secret|password/i.test(v.name),
      description: v.description,
    })),
    installId: pkg.identifier,
  }
}

async function loadRecommendedMcps() {
  registryLoading.value = true
  registryError.value = ''
  try {
    const data = await api.mcp.searchRegistry({ registry: 'recommended', limit: 50 })
    const recommended = data.servers
      .map(getInstallOption)
      .filter((mcp): mcp is McpOption => Boolean(mcp))
      .filter((mcp) => !mcp.installId?.includes('@cynosure-mcp/cynosure'))
    mcpOptions.value = [cynosureMcp, ...recommended]
  } catch (e) {
    mcpOptions.value = [cynosureMcp]
    registryError.value = e instanceof Error ? e.message : 'Could not load recommended MCP servers'
  } finally {
    registryLoading.value = false
  }
}

function checkInstalled() {
  const ids = new Set<string>()
  for (const mcp of mcpOptions.value) {
    if (!mcp.installId) continue
    if (servers.value.some(s => s.args?.some(a => a.includes(mcp.installId!)))) {
      ids.add(mcp.id)
    }
  }
  installedIds.value = ids
}

onMounted(async () => {
  await Promise.all([loadRecommendedMcps(), loadServers()])
  checkInstalled()
})

async function installMcp(mcp: McpOption) {
  if (mcp.envVars?.length) {
    expandedId.value = mcp.id
    if (mcp.id === 'filesystem') filesystemExpanded.value = true
    return
  }
  await doInstall(mcp, {})
}

function canInstallWithEnv(mcp: McpOption): boolean {
  if (!mcp.envVars) return true
  return mcp.envVars.filter(v => v.required).every(v => {
    const val = envValues[mcp.id + ':' + v.name]
    return val && val.trim()
  })
}

async function installWithEnv(mcp: McpOption) {
  const env: Record<string, string> = {}
  for (const v of (mcp.envVars || [])) {
    const val = envValues[mcp.id + ':' + v.name]
    if (val?.trim() && !mcp.argEnvNames.has(v.name)) env[v.name] = val.trim()
  }

  const args = mcp.args.map(arg => {
    const match = arg.match(/^\$\{([^}]+)\}$/)
    return match ? envValues[mcp.id + ':' + match[1]] : arg
  })

  await doInstall(mcp, env, args)
}

async function doInstall(mcp: McpOption, env: Record<string, string>, argsOverride?: string[]) {
  loadingId.value = mcp.id
  errors[mcp.id] = ''
  try {
    await api.mcp.addServer({
      originalName: mcp.name,
      command: mcp.command,
      args: argsOverride ?? mcp.args,
      env: Object.keys(env).length ? env : undefined,
      origin: mcp.badge?.toLowerCase() === 'smithery' ? 'smithery.ai' : 'npm',
      description: mcp.description,
      env_hints: mcp.envVars?.length ? mcp.envVars.map(v => ({
        name: v.name,
        description: v.description,
        required: v.required,
        sensitive: v.secret,
      })) : undefined,
    })
    await loadServers()
    checkInstalled()
    installedIds.value.add(mcp.id)
    expandedId.value = null
  } catch (e) {
    errors[mcp.id] = e instanceof Error ? e.message : 'Installation failed'
  } finally {
    loadingId.value = null
  }
}
</script>
