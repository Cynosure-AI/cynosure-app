<script setup lang="ts">
import { ref, watch, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import type { CSSProperties } from 'vue'
import { useRouter } from 'vue-router'
import { useProviderStore } from '../../stores/provider.store'
import { api } from '../../api/client'
import type { McpServerInfo } from '../../api/types'
import { Icon } from '@iconify/vue'

const props = defineProps<{
  show: boolean
  anchorEl?: HTMLElement | null
}>()

const emit = defineEmits<{
  close: []
}>()

const router = useRouter()
const providerStore = useProviderStore()

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
const appVersion = ref<string | null>(null)

// Cache: skip re-fetch if data is less than 20s old
let lastFetchedAt = 0
const CACHE_TTL = 20000 // 20 seconds
const refreshing = ref(false)
const popoverStyle = ref<CSSProperties>({})

function updatePosition() {
  if (!props.anchorEl) return

  const anchorRect = props.anchorEl.getBoundingClientRect()
  const viewportPadding = 12
  const gap = 8
  const preferredWidth = 216
  const width = Math.min(preferredWidth, window.innerWidth - viewportPadding * 2)
  const maxLeft = Math.max(viewportPadding, window.innerWidth - width - viewportPadding)

  popoverStyle.value = {
    width: `${width}px`,
    left: `${Math.min(Math.max(anchorRect.left, viewportPadding), maxLeft)}px`,
    bottom: `${Math.max(viewportPadding, window.innerHeight - anchorRect.top + gap)}px`
  }
}

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

  try {
    const health = await api.system.health()
    appVersion.value = health.version
  } catch { /* non-critical */ }

  lastFetchedAt = Date.now()
  refreshing.value = false
}

watch(() => props.show, async (visible) => {
  if (!visible) return
  await nextTick()
  updatePosition()
  fetchStatus()
})

onMounted(() => {
  window.addEventListener('resize', updatePosition)
  window.addEventListener('scroll', updatePosition, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updatePosition)
  window.removeEventListener('scroll', updatePosition, true)
})

function goTo(path: string) {
  emit('close')
  router.push(path)
}
</script>

<template>
  <Teleport to="body">
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
        class="fixed bg-theme-900 border border-theme-700 rounded-xl shadow-2xl p-3 space-y-3 z-50 max-h-[70vh] overflow-y-auto"
        :style="popoverStyle"
        @click.stop
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

        <div class="border-t border-theme-800" />

        <div class="px-2 text-[10px] text-theme-600">
          Cynosure <span v-if="appVersion">v{{ appVersion }}</span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
