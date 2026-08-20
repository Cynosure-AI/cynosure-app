<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { api } from '../../api/client'
import { usePreferencesStore } from '../../stores/preferences.store'

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
const preferencesStore = usePreferencesStore()
const appVersion = ref<string | null>(null)
const popoverStyle = ref<CSSProperties>({})

const setupLinks = [
  { path: '/settings', label: 'Settings', description: 'Profile, providers and preferences', icon: 'lucide:settings' },
  { path: '/settings/mcp', label: 'MCP Servers', description: 'Connect external tools and services', icon: 'lucide:plug' },
  { path: '/tools-policy', label: 'Tools Policy', description: 'Review tool access and approvals', icon: 'lucide:shield-check' },
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
        class="fixed z-50 max-h-[80vh] overflow-y-auto rounded-xl border border-theme-700 bg-theme-900 p-2 shadow-2xl"
        :style="popoverStyle"
        @click.stop
      >
        <div class="flex items-center justify-between gap-3 px-2 py-1.5">
          <div>
            <p class="truncate text-base font-semibold text-theme-100">
              {{ preferencesStore.userName.trim() || 'Workspace' }}
            </p>
            <p class="text-[10px] font-medium uppercase tracking-wider text-theme-500">
              {{ preferencesStore.userName.trim() ? 'Workspace · shortcuts and configuration' : 'Shortcuts and configuration' }}
            </p>
          </div>
        </div>

        <div class="my-2 grid grid-cols-2 gap-1">
          <button
            type="button"
            class="relative flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-theme-300 transition hover:bg-theme-800 hover:text-theme-100"
            @click="goTo('/activity')"
          >
            <Icon
              icon="lucide:list-tree"
              class="h-4 w-4 text-theme-500"
            />
            <span>Activity</span>
            <span
              v-if="activeWorkCount"
              class="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white"
              :class="hasAwaitingApproval ? 'bg-amber-500' : 'bg-accent-600'"
            >{{ activeWorkCount > 9 ? '9+' : activeWorkCount }}</span>
          </button>
          <button
            type="button"
            class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-theme-300 transition hover:bg-theme-800 hover:text-theme-100"
            @click="goTo('/usage')"
          >
            <Icon
              icon="lucide:bar-chart-3"
              class="h-4 w-4 text-theme-500"
            />
            <span>Usage</span>
          </button>
        </div>

        <div class="border-t border-theme-800 pt-2">
          <button
            v-for="link in setupLinks"
            :key="link.path"
            type="button"
            class="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition hover:bg-theme-800"
            @click="goTo(link.path)"
          >
            <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-theme-800 text-theme-400 group-hover:text-accent-400">
              <Icon
                :icon="link.icon"
                class="h-4 w-4"
              />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-xs font-medium text-theme-200">{{ link.label }}</span>
              <span class="block truncate text-[10px] text-theme-500">{{ link.description }}</span>
            </span>
            <Icon
              icon="lucide:chevron-right"
              class="h-3.5 w-3.5 text-theme-600"
            />
          </button>
        </div>

        <div class="px-2 pb-1 pt-2 text-[10px] text-theme-600">
          Cynosure <span v-if="appVersion">v{{ appVersion }}</span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
