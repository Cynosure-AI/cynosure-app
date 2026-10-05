<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { api } from '../../api/client'
import { useAppUpdater } from '../../composables/useAppUpdater'

const props = withDefaults(defineProps<{
  show: boolean
  anchorEl?: HTMLElement | null
  activeWorkCount?: number
  hasAwaitingApproval?: boolean
}>(), {
  anchorEl: null,
  activeWorkCount: 0,
  hasAwaitingApproval: false,
})

const emit = defineEmits<{ close: [] }>()
const router = useRouter()
const appVersion = ref<string | null>(null)
const { state: updateState, progressPercent, download, install } = useAppUpdater()
const popoverStyle = ref<CSSProperties>({})
const electron = (window as unknown as { electron?: { quitApp?: () => Promise<void> } }).electron
const isElectron = typeof electron?.quitApp === 'function'

const setupLinks = [
  { path: '/settings', label: 'Settings', icon: 'lucide:settings' },
  { path: '/settings/mcp', label: 'MCP Servers', icon: 'lucide:plug' },
  { path: '/tools-policy', label: 'Tools', icon: 'lucide:shield-check' },
]

function updatePosition() {
  if (!props.anchorEl) return
  const rect = props.anchorEl.getBoundingClientRect()
  const padding = 12
  const gap = 8
  const width = Math.min(304, window.innerWidth - padding * 2)
  popoverStyle.value = {
    width: `${width}px`,
    left: `${Math.min(Math.max(rect.left, padding), window.innerWidth - width - padding)}px`,
    bottom: `${Math.max(padding, window.innerHeight - rect.top + gap)}px`,
  }
}

async function fetchVersion() {
  try {
    appVersion.value = (await api.system.health()).version
  } catch { /* non-critical */ }
}

function goTo(path: string) {
  emit('close')
  router.push(path)
}

function quitApp(): void {
  emit('close')
  void electron?.quitApp?.()
}

watch(() => props.show, async (show) => {
  if (!show) return
  await nextTick()
  updatePosition()
  if (!appVersion.value) void fetchVersion()
})

onMounted(() => {
  window.addEventListener('resize', updatePosition)
  window.addEventListener('scroll', updatePosition, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updatePosition)
  window.removeEventListener('scroll', updatePosition, true)
})
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
        role="dialog"
        aria-label="Workspace and configuration"
        class="workspace-popover fixed z-50 max-h-[80vh] overflow-y-auto rounded-xl border border-theme-700 bg-theme-900 p-2 shadow-2xl"
        :style="popoverStyle"
        @click.stop
      >
        <div class="mb-2 border-b border-theme-800 pb-2">
          <button
            type="button"
            class="relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-theme-300 transition hover:bg-theme-800 hover:text-theme-100"
            @click="goTo('/activity')"
          >
            <Icon
              icon="lucide:list-tree"
              class="h-5 w-5 text-ink-muted"
            />
            <span>Activity</span>
            <span
              v-if="activeWorkCount"
              class="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white"
              :class="hasAwaitingApproval ? 'bg-amber-500' : 'bg-accent-600'"
            >
              {{ activeWorkCount > 9 ? '9+' : activeWorkCount }}
            </span>
          </button>

          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-theme-300 transition hover:bg-theme-800 hover:text-theme-100"
            @click="goTo('/usage')"
          >
            <Icon
              icon="lucide:bar-chart-3"
              class="h-5 w-5 text-ink-muted"
            />
            <span>Usage</span>
          </button>
        </div>

        <div class="py-1">
          <button
            v-for="link in setupLinks"
            :key="link.path"
            type="button"
            class="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-theme-300 transition hover:bg-theme-800 hover:text-theme-100"
            @click="goTo(link.path)"
          >
            <Icon
              :icon="link.icon"
              class="h-5 w-5 shrink-0 text-ink-muted group-hover:text-accent-fg"
            />
            <span class="min-w-0 flex-1">{{ link.label }}</span>
            <Icon
              icon="lucide:chevron-right"
              class="h-4 w-4 text-ink-faint"
            />
          </button>

          <button
            v-if="isElectron"
            type="button"
            class="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-theme-300 transition hover:bg-theme-800 hover:text-status-danger"
            @click="quitApp"
          >
            <Icon
              icon="lucide:power"
              class="h-5 w-5 shrink-0 text-ink-muted group-hover:text-status-danger"
            />
            <span class="min-w-0 flex-1">Quit</span>
          </button>
        </div>

        <div
          v-if="['available', 'downloading', 'downloaded'].includes(updateState.status)"
          class="mt-1 border-t border-theme-800 px-1 pt-2"
        >
          <button
            type="button"
            class="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-theme-200 transition hover:bg-theme-800 disabled:cursor-default disabled:hover:bg-transparent"
            :disabled="updateState.status === 'downloading'"
            @click="updateState.status === 'available' ? download() : updateState.status === 'downloaded' ? install() : undefined"
          >
            <Icon
              :icon="updateState.status === 'downloaded' ? 'lucide:badge-check' : updateState.status === 'downloading' ? 'lucide:loader-circle' : 'lucide:download'"
              class="h-5 w-5 shrink-0 text-accent-fg"
              :class="{ 'animate-spin': updateState.status === 'downloading' }"
            />
            <span class="min-w-0 flex-1">
              <span class="block font-medium">
                {{ updateState.status === 'downloaded' ? 'Install and restart' : updateState.status === 'downloading' ? `Downloading update… ${progressPercent}%` : 'Update available' }}
              </span>
              <span class="block text-[11px] text-ink-muted">
                Version {{ updateState.availableVersion }}
              </span>
            </span>
            <Icon
              v-if="updateState.status !== 'downloading'"
              icon="lucide:chevron-right"
              class="h-4 w-4 text-ink-faint"
            />
          </button>
        </div>

        <div class="mt-1 border-t border-theme-800 px-3 pb-1 pt-3 text-[10px] text-ink-faint">
          Cynosure <span v-if="updateState.currentVersion || appVersion">v{{ updateState.currentVersion || appVersion }}</span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
