<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useProviderStore } from '../../stores/provider.store'
import { useMemoryJobsStore } from '../../stores/memory-jobs.store'
import { api } from '../../api/client'
import type { AgentInstance, McpServerInfo, MemoryIndexJob } from '../../api/types'
import { Icon } from '@iconify/vue'

const props = defineProps<{
  show: boolean
  instances: AgentInstance[]
}>()

const emit = defineEmits<{
  close: []
  navigateToInstance: [instance: AgentInstance]
}>()

const router = useRouter()
const providerStore = useProviderStore()
const memoryJobsStore = useMemoryJobsStore()

// Provider health
interface ProviderHealth {
  id: string
  name: string
  status: 'checking' | 'ok' | 'error'
}
const providerHealthList = ref<ProviderHealth[]>([])
const providerChecked = ref(false)

// MCP stats
const mcpServers = ref<McpServerInfo[]>([])
const mcpLoaded = ref(false)

// Cache: skip re-fetch if data is less than 20s old
let lastFetchedAt = 0
const CACHE_TTL = 20000 // 20 seconds
const refreshing = ref(false)

const mcpStats = computed(() => {
  const total = mcpServers.value.length
  const connected = mcpServers.value.filter(s => s.connected).length
  const failed = mcpServers.value.filter(s => s.enabled && !s.connected).length
  const totalTools = mcpServers.value.reduce((sum, s) => sum + s.toolCount, 0)
  return { total, connected, failed, totalTools }
})

async function fetchStatus(force = false) {
  const now = Date.now()
  if (!force && lastFetchedAt && now - lastFetchedAt < CACHE_TTL) return

  refreshing.value = true
  void memoryJobsStore.refresh()

  // Check providers (using listModels — free, no credits)
  providerChecked.value = false
  providerHealthList.value = providerStore.providers.map(p => ({
    id: p.id,
    name: p.name,
    status: 'checking' as const
  }))

  const checks = providerStore.providers.map(async (p) => {
    try {
      await api.provider.listModels(p.id)
      return { id: p.id, ok: true }
    } catch {
      return { id: p.id, ok: false }
    }
  })

  const results = await Promise.allSettled(checks)
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const entry = providerHealthList.value.find(e => e.id === r.value.id)
      if (entry) entry.status = r.value.ok ? 'ok' : 'error'
    }
  }
  providerChecked.value = true

  // Load MCP servers
  try {
    mcpServers.value = await api.mcp.listServers()
  } catch { /* non-critical */ }
  mcpLoaded.value = true

  lastFetchedAt = Date.now()
  refreshing.value = false
}

watch(() => props.show, (visible) => {
  if (!visible) return
  fetchStatus()
})

function goTo(path: string) {
  emit('close')
  router.push(path)
}

function memoryJobLabel(job: MemoryIndexJob): string {
  return job.kind === 'entity-index' ? 'Extracting entities' : 'Indexing memory'
}

function memoryJobIcon(job: MemoryIndexJob): string {
  return job.kind === 'entity-index' ? 'lucide:network' : 'lucide:database-zap'
}
</script>

<template>
  <Transition
    enter-active-class="transition duration-150 ease-out"
    enter-from-class="opacity-0 translate-y-2"
    enter-to-class="opacity-100 translate-y-0"
    leave-active-class="transition duration-100 ease-in"
    leave-from-class="opacity-100 translate-y-0"
    leave-to-class="opacity-0 translate-y-2"
  >
    <div
      v-if="show"
      class="absolute left-3 right-3 bottom-full mb-2 bg-theme-900 border border-theme-700 rounded-xl shadow-2xl p-3 space-y-3 z-50 max-h-[70vh] overflow-y-auto"
    >
      <!-- Refresh button -->
      <div class="flex justify-end -mt-0.5 -mb-1">
        <button
          class="p-1 rounded-md text-theme-500 hover:text-theme-300 hover:bg-theme-800 transition-colors"
          title="Refresh status"
          :disabled="refreshing"
          @click="fetchStatus(true)"
        >
          <Icon
            icon="lucide:refresh-cw"
            class="w-3 h-3"
            :class="{ 'animate-spin': refreshing }"
          />
        </button>
      </div>

      <!-- ── Memory Jobs ── -->
      <div>
        <div class="flex items-center gap-2 mb-1.5">
          <Icon
            icon="lucide:database"
            class="w-3.5 h-3.5 text-theme-500"
          />
          <span class="text-[11px] font-medium text-theme-400 uppercase tracking-wider">Memory Jobs</span>
          <button
            v-if="memoryJobsStore.runningJobs.length > 1"
            class="ml-auto text-[10px] text-theme-500 hover:text-red-300 transition-colors"
            :disabled="memoryJobsStore.refreshing"
            @click="memoryJobsStore.cancelRunningJobs()"
          >
            Cancel all
          </button>
        </div>

        <template v-if="memoryJobsStore.runningJobs.length > 0">
          <div
            v-for="job in memoryJobsStore.runningJobs"
            :key="job.id"
            class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-theme-800 transition-colors group"
          >
            <Icon
              :icon="memoryJobIcon(job)"
              class="w-3.5 h-3.5 text-accent-400 animate-pulse shrink-0"
            />
            <button
              class="min-w-0 flex-1 text-left"
              @click="goTo('/memory-spaces/documents')"
            >
              <div class="text-[11px] text-theme-300 truncate">
                {{ memoryJobLabel(job) }}
              </div>
              <div class="text-[10px] text-theme-600 truncate">
                {{ job.fileName }}
              </div>
            </button>
            <button
              class="p-1 rounded-md text-theme-500 hover:text-red-300 hover:bg-red-500/10 transition-colors"
              title="Cancel job"
              @click="memoryJobsStore.cancelJob(job.id)"
            >
              <Icon
                icon="lucide:x"
                class="w-3 h-3"
              />
            </button>
          </div>
        </template>
        <div
          v-else
          class="text-[11px] text-theme-600 px-2"
        >
          No memory jobs
        </div>
      </div>

      <div class="border-t border-theme-800" />

      <!-- ── Running Instances ── -->
      <div>
        <div class="flex items-center gap-2 mb-1.5">
          <Icon
            icon="lucide:activity"
            class="w-3.5 h-3.5 text-theme-500"
          />
          <span class="text-[11px] font-medium text-theme-400 uppercase tracking-wider">Instances</span>
          <span
            v-if="instances.length"
            class="text-[10px] text-theme-500 ml-auto"
          >{{ instances.length }} running</span>
        </div>

        <template v-if="instances.length > 0">
          <div
            v-for="instance in instances"
            :key="instance.id"
            role="button"
            tabindex="0"
            class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-theme-800 transition-colors cursor-pointer group"
            @click="emit('navigateToInstance', instance)"
            @keydown.enter="emit('navigateToInstance', instance)"
          >
            <Icon
              v-if="instance.status === 'awaiting-approval'"
              icon="lucide:lightbulb"
              class="w-3.5 h-3.5 text-amber-400 animate-pulse shrink-0"
            />
            <Icon
              v-else
              icon="lucide:loader-2"
              class="w-3.5 h-3.5 text-accent-400 animate-spin shrink-0"
            />
            <span
              class="text-[11px] truncate flex-1"
              :class="instance.status === 'awaiting-approval' ? 'text-amber-400 group-hover:text-amber-300' : 'text-theme-400 group-hover:text-theme-200'"
            >{{ instance.agentName }}</span>
          </div>
        </template>
        <div
          v-else
          class="text-[11px] text-theme-600 px-2"
        >
          No running instances
        </div>
      </div>

      <div class="border-t border-theme-800" />

      <!-- ── LLM Providers ── -->
      <div>
        <button
          class="flex items-center gap-2 mb-1.5 w-full hover:opacity-80 transition-opacity"
          @click="goTo('/settings?category=providers')"
        >
          <Icon
            icon="lucide:cpu"
            class="w-3.5 h-3.5 text-theme-500"
          />
          <span class="text-[11px] font-medium text-theme-400 uppercase tracking-wider">Providers</span>
        </button>

        <div
          v-if="providerHealthList.length === 0"
          class="text-[11px] text-theme-600 px-2"
        >
          No providers configured
        </div>
        <div
          v-for="p in providerHealthList"
          :key="p.id"
          class="flex items-center gap-2 px-2 py-1"
        >
          <span
            class="w-1.5 h-1.5 rounded-full shrink-0"
            :class="{
              'bg-theme-600 animate-pulse': p.status === 'checking',
              'bg-emerald-500': p.status === 'ok',
              'bg-red-500': p.status === 'error'
            }"
          />
          <span
            class="text-[11px] truncate flex-1"
            :class="p.status === 'error' ? 'text-red-400' : 'text-theme-400'"
          >{{ p.name }}</span>
        </div>
      </div>

      <div class="border-t border-theme-800" />

      <!-- ── MCPs ── -->
      <div>
        <button
          class="flex items-center gap-2 mb-1.5 w-full hover:opacity-80 transition-opacity"
          @click="goTo('/settings/mcp')"
        >
          <Icon
            icon="lucide:plug"
            class="w-3.5 h-3.5 text-theme-500"
          />
          <span class="text-[11px] font-medium text-theme-400 uppercase tracking-wider">MCPs</span>
        </button>

        <div
          v-if="!mcpLoaded"
          class="text-[11px] text-theme-600 px-2"
        >
          Loading…
        </div>
        <template v-else>
          <div class="flex flex-wrap gap-x-4 gap-y-1 px-2">
            <div class="flex items-center gap-1.5">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
              <span class="text-[11px] text-theme-400">{{ mcpStats.connected }} connected</span>
            </div>
            <div
              v-if="mcpStats.failed > 0"
              class="flex items-center gap-1.5"
            >
              <span class="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
              <span class="text-[11px] text-red-400">{{ mcpStats.failed }} failed</span>
            </div>
            <div class="flex items-center gap-1.5">
              <Icon
                icon="lucide:wrench"
                class="w-3 h-3 text-theme-500"
              />
              <span class="text-[11px] text-theme-400">{{ mcpStats.totalTools }} tools</span>
            </div>
          </div>
          <div
            v-if="mcpStats.total === 0"
            class="text-[11px] text-theme-600 px-2"
          >
            No MCP servers configured
          </div>
        </template>
      </div>
    </div>
  </Transition>
</template>
