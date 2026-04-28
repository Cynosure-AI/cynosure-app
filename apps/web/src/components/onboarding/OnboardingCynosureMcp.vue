<template>
  <div class="max-w-2xl mx-auto px-4 py-6 w-full">
    <div class="mb-6">
      <h2 class="text-xl font-bold text-zinc-100">
        Install Cynosure MCP
      </h2>
      <p class="text-sm text-zinc-500 mt-1">
        Let your AI agents configure Cynosure itself — create agents, manage memory spaces, and more,
        all through natural language.
      </p>
    </div>

    <div class="bg-zinc-800/50 border border-zinc-700/60 rounded-xl overflow-hidden">
      <!-- Header -->
      <div class="flex items-center gap-4 p-5 border-b border-zinc-700/40">
        <div class="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
          <Icon
            icon="lucide:settings-2"
            class="w-6 h-6 text-blue-400"
          />
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-zinc-100">Cynosure MCP</span>
            <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 font-medium">Official</span>
          </div>
          <div class="text-xs text-zinc-500 mt-0.5">
            @cynosure-mcp/cynosure · npm
          </div>
        </div>
        <div
          v-if="installed"
          class="flex items-center gap-1.5 text-emerald-400"
        >
          <Icon
            icon="lucide:check-circle-2"
            class="w-4 h-4"
          />
          <span class="text-xs font-medium">Installed</span>
        </div>
      </div>

      <!-- Features list -->
      <div class="px-5 py-4 space-y-2.5">
        <div
          v-for="feat in features"
          :key="feat.label"
          class="flex items-start gap-2.5"
        >
          <Icon
            :icon="feat.icon"
            class="w-4 h-4 mt-0.5 text-zinc-500 shrink-0"
          />
          <div>
            <span class="text-sm text-zinc-300 font-medium">{{ feat.label }}</span>
            <span class="text-sm text-zinc-500"> — {{ feat.desc }}</span>
          </div>
        </div>
      </div>

      <!-- Actions -->
      <div class="px-5 py-4 border-t border-zinc-700/40 flex items-center gap-3">
        <button
          v-if="!installed"
          class="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
          :disabled="installing"
          @click="install"
        >
          <Icon
            :icon="installing ? 'lucide:loader-2' : 'lucide:download'"
            class="w-4 h-4"
            :class="{ 'animate-spin': installing }"
          />
          {{ installing ? 'Installing…' : 'Install' }}
        </button>
        <button
          v-else
          class="flex items-center gap-2 px-4 py-2 bg-zinc-700 text-zinc-400 text-sm font-medium rounded-lg cursor-default"
          disabled
        >
          <Icon
            icon="lucide:check"
            class="w-4 h-4"
          />
          Installed
        </button>

        <p
          v-if="error"
          class="text-xs text-red-400"
        >
          {{ error }}
        </p>
        <p
          v-else-if="installed && !installing"
          class="text-xs text-emerald-400"
        >
          Connected and ready to use
        </p>
      </div>
    </div>

    <!-- Info box -->
    <div class="mt-4 flex items-start gap-2.5 text-xs text-zinc-500 bg-zinc-900/60 border border-zinc-800 rounded-lg px-4 py-3">
      <Icon
        icon="lucide:info"
        class="w-3.5 h-3.5 mt-0.5 shrink-0"
      />
      <span>
        This step is optional. You can install Cynosure MCP later from
        <strong class="text-zinc-400">Settings → MCPs</strong>.
        Requires Node.js and npx to be available.
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '../../api/client'
import { useMcpServers } from '../../composables/useMcpServers'

const { servers, loadServers } = useMcpServers()

const installing = ref(false)
const error = ref('')
const installed = ref(false)

const features = [
  { icon: 'lucide:bot', label: 'Create & manage agents', desc: 'spin up agents via chat' },
  { icon: 'lucide:brain', label: 'Configure memory spaces', desc: 'set up vector memory from conversation' },
  { icon: 'lucide:plug', label: 'Install MCP servers', desc: 'add tools without leaving the chat' },
  { icon: 'lucide:settings', label: 'Adjust settings', desc: 'update providers and preferences via AI' },
]

function checkInstalled() {
  installed.value = servers.value.some(s => s.args?.some(a => a.includes('@cynosure-mcp/cynosure')))
}

onMounted(async () => {
  await loadServers()
  checkInstalled()
})

async function install() {
  installing.value = true
  error.value = ''
  try {
    await api.mcp.addServer({
      originalName: 'Cynosure',
      command: 'npx',
      args: ['-y', '@cynosure-mcp/cynosure'],
      origin: 'npm',
      description: 'Configure Cynosure itself via AI — manage agents, memory, MCPs and settings.',
    })
    await loadServers()
    checkInstalled()
    if (!installed.value) {
      installed.value = true // optimistic
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Installation failed'
  } finally {
    installing.value = false
  }
}
</script>
