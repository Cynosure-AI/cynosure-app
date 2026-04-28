<template>
  <div class="max-w-2xl mx-auto px-4 py-6 w-full">
    <div class="mb-6">
      <h2 class="text-xl font-bold text-zinc-100">
        Add Popular Tools
      </h2>
      <p class="text-sm text-zinc-500 mt-1">
        Install popular MCP servers to supercharge your agents. All are optional — you can add more
        later in <strong class="text-zinc-400">Settings → MCPs</strong>.
      </p>
    </div>

    <div class="space-y-3">
      <div
        v-for="mcp in mcpOptions"
        :key="mcp.id"
        class="bg-zinc-800/50 border border-zinc-700/60 rounded-xl overflow-hidden"
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
              <span class="text-sm font-semibold text-zinc-100">{{ mcp.name }}</span>
              <span
                v-if="mcp.badge"
                class="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                :class="mcp.badgeClass"
              >{{ mcp.badge }}</span>
            </div>
            <p class="text-xs text-zinc-500 mt-0.5">
              {{ mcp.description }}
            </p>
            <p class="text-[11px] text-zinc-600 mt-0.5 font-mono">
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
              class="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-zinc-300 text-xs font-medium rounded-lg transition-colors"
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
          class="px-4 pb-4 border-t border-zinc-700/40 pt-4 space-y-3"
        >
          <p class="text-xs text-zinc-400 font-medium">
            Configuration Required
          </p>
          <div
            v-for="envVar in mcp.envVars"
            :key="envVar.name"
          >
            <label class="block text-xs text-zinc-500 mb-1">
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
              class="w-full bg-zinc-900 border border-zinc-600 text-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-600"
            >
          </div>
          <div class="flex gap-2">
            <button
              class="flex items-center gap-1.5 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
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
              class="px-3 py-2 text-zinc-500 hover:text-zinc-300 text-xs transition-colors"
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
      class="mt-3 flex items-start gap-2 text-xs text-zinc-500 bg-zinc-900/60 border border-zinc-800 rounded-lg px-4 py-3"
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
import { useMcpServers } from '../../composables/useMcpServers'

const { servers, loadServers } = useMcpServers()

const loadingId = ref<string | null>(null)
const expandedId = ref<string | null>(null)
const installedIds = ref<Set<string>>(new Set())
const errors = reactive<Record<string, string>>({})
const envValues = reactive<Record<string, string>>({})
const filesystemExpanded = ref(false)

interface EnvVar {
  name: string
  label: string
  placeholder: string
  required: boolean
  secret?: boolean
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
  envVars?: EnvVar[]
  installId?: string // substring to check if already installed
}

const mcpOptions: McpOption[] = [
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    description: 'Control a Chrome browser — navigate pages, fill forms, take screenshots, run JS.',
    packageId: 'chrome-devtools-mcp',
    icon: 'lucide:globe',
    iconBg: 'bg-amber-500/10',
    iconColor: 'text-amber-400',
    badge: 'npm',
    badgeClass: 'bg-zinc-600/60 text-zinc-300',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
    installId: 'chrome-devtools-mcp',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Read, send and manage Gmail — search emails, reply, create drafts via Smithery.',
    packageId: 'gmail (Smithery)',
    icon: 'lucide:mail',
    iconBg: 'bg-red-500/10',
    iconColor: 'text-red-400',
    badge: 'Smithery',
    badgeClass: 'bg-blue-500/20 text-blue-400',
    command: 'npx',
    args: ['-y', '@smithery/cli@latest', 'run', 'gmail'],
    installId: 'gmail',
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files and directories on your machine.',
    packageId: '@modelcontextprotocol/server-filesystem',
    icon: 'lucide:folder-open',
    iconBg: 'bg-zinc-600/40',
    iconColor: 'text-zinc-300',
    badge: 'Official',
    badgeClass: 'bg-emerald-500/20 text-emerald-400',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    envVars: [
      {
        name: 'DIRECTORY',
        label: 'Directory Path',
        placeholder: '/Users/you/Documents',
        required: true,
        secret: false,
      },
    ],
    installId: '@modelcontextprotocol/server-filesystem',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Manage repos, issues, PRs, workflows and more — full GitHub API access via Smithery.',
    packageId: 'github (Smithery)',
    icon: 'lucide:github',
    iconBg: 'bg-zinc-600/40',
    iconColor: 'text-zinc-100',
    badge: 'Smithery',
    badgeClass: 'bg-blue-500/20 text-blue-400',
    command: 'npx',
    args: ['-y', '@smithery/cli@latest', 'run', 'github'],
    installId: 'github',
  },
  {
    id: 'computer-controller',
    name: 'Computer Controller',
    description: 'Control your desktop — launch apps, capture screenshots, move mouse, type text and more.',
    packageId: '@cynosure-mcp/computer-controller',
    icon: 'lucide:monitor',
    iconBg: 'bg-violet-500/10',
    iconColor: 'text-violet-400',
    badge: 'npm',
    badgeClass: 'bg-zinc-600/60 text-zinc-300',
    command: 'npx',
    args: ['-y', '@cynosure-mcp/computer-controller'],
    installId: '@cynosure-mcp/computer-controller',
  },
  {
    id: 'youtube-downloader',
    name: 'YouTube Downloader',
    description: 'Download videos and audio from YouTube, Vimeo and more — supports mp4, mp3, and many other formats.',
    packageId: '@cynosure-mcp/youtube-video-downloader',
    icon: 'lucide:youtube',
    iconBg: 'bg-red-500/10',
    iconColor: 'text-red-400',
    badge: 'npm',
    badgeClass: 'bg-zinc-600/60 text-zinc-300',
    command: 'npx',
    args: ['-y', '@cynosure-mcp/youtube-video-downloader'],
    installId: '@cynosure-mcp/youtube-video-downloader',
  },
]

function checkInstalled() {
  const ids = new Set<string>()
  for (const mcp of mcpOptions) {
    if (!mcp.installId) continue
    if (servers.value.some(s => s.args?.some(a => a.includes(mcp.installId!)))) {
      ids.add(mcp.id)
    }
  }
  installedIds.value = ids
}

onMounted(async () => {
  await loadServers()
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
    if (val?.trim()) env[v.name] = val.trim()
  }

  // For filesystem, append directory to args
  let args = [...mcp.args]
  if (mcp.id === 'filesystem' && env['DIRECTORY']) {
    args = [...mcp.args, env['DIRECTORY']]
    delete env['DIRECTORY']
  }

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
