<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CSSProperties } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { Icon } from '@iconify/vue'
import { useChatStore } from '../../stores/chat.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { useProviderStore } from '../../stores/provider.store'
import { api } from '../../api/client'

// Keep entries separate from the view: other destination kinds can be added here later.
type QuickPickerEntry = {
  kind: 'chat-agent'
  id: string | null
  label: string
  description: string
  iconUrl: string | null
}

const chatStore = useChatStore()
const agentDefs = useAgentDefinitionsStore()
const providerStore = useProviderStore()
const trigger = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const open = ref(false)
const search = ref('')
const menuStyle = ref<CSSProperties>({})
const recentAgentIds = ref<string[]>([])

const freeChat: QuickPickerEntry = {
  kind: 'chat-agent', id: null, label: 'Free Chat',
  description: 'Chat without an agent', iconUrl: null,
}

const entries = computed<QuickPickerEntry[]>(() => agentDefs.agents.map(agent => ({
  kind: 'chat-agent', id: agent.id, label: agent.name,
  description: agent.description || agent.internalName || '', iconUrl: agent.iconUrl,
})))
const favorites = computed(() => entries.value.filter(entry => agentDefs.get(entry.id!)?.favorite))
const recent = computed(() => recentAgentIds.value
  .filter(id => !agentDefs.get(id)?.favorite)
  .map(id => entries.value.find(entry => entry.id === id))
  .filter((entry): entry is QuickPickerEntry => Boolean(entry))
  .slice(0, 5))
const other = computed(() => {
  const listed = new Set([...favorites.value, ...recent.value].map(entry => entry.id))
  const query = search.value.trim().toLocaleLowerCase()
  return [freeChat, ...entries.value]
    .filter(entry => !listed.has(entry.id))
    .filter(entry => !query || `${entry.label} ${entry.description}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => a.label.localeCompare(b.label))
})
const visibleFavorites = computed(() => filterEntries(favorites.value))
const visibleRecent = computed(() => filterEntries(recent.value))

function filterEntries(items: QuickPickerEntry[]): QuickPickerEntry[] {
  const query = search.value.trim().toLocaleLowerCase()
  return query ? items.filter(entry => `${entry.label} ${entry.description}`.toLocaleLowerCase().includes(query)) : items
}

function positionMenu(): void {
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect) return
  const margin = 8
  const width = Math.min(320, window.innerWidth - margin * 2)
  const availableAbove = rect.top - margin * 2
  const availableBelow = window.innerHeight - rect.bottom - margin * 2
  const above = availableAbove >= 280 || availableAbove > availableBelow
  menuStyle.value = {
    width: `${width}px`,
    left: `${Math.min(Math.max(rect.right - width, margin), window.innerWidth - width - margin)}px`,
    maxHeight: `${Math.max(120, Math.min(440, above ? availableAbove : availableBelow))}px`,
    ...(above ? { bottom: `${window.innerHeight - rect.top + margin}px` } : { top: `${rect.bottom + margin}px` }),
  }
}

function close(): void {
  open.value = false
  search.value = ''
}

async function toggle(): Promise<void> {
  if (open.value) return close()
  open.value = true
  await nextTick()
  positionMenu()
  searchInput.value?.focus()
  try {
    const response = await api.chat.listConversationsPaginated(100, 0, 'updated')
    recentAgentIds.value = [...new Set(response.items.map(item => item.agent_id).filter((id): id is string => Boolean(id)))]
  } catch {
    // The rest of the picker remains available when recent chats cannot load.
  }
}

async function select(entry: QuickPickerEntry): Promise<void> {
  if (entry.kind !== 'chat-agent') return
  close()
  if (chatStore.activeAgentId === entry.id) return
  await chatStore.setActiveAgent(entry.id)
  if (entry.id) {
    const providerId = agentDefs.get(entry.id)?.providerId
    if (providerId) providerStore.setLastUsed(providerId)
  }
}

onClickOutside(trigger, close, { ignore: [menu] })
onMounted(() => {
  window.addEventListener('resize', positionMenu)
  window.addEventListener('scroll', positionMenu, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', positionMenu)
  window.removeEventListener('scroll', positionMenu, true)
})
</script>

<template>
  <span
    ref="trigger"
    class="absolute -bottom-2 -right-2 z-10 inline-flex"
  >
    <button
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-full border border-theme-700 bg-theme-950 text-accent-400 shadow-lg transition-colors hover:border-accent-500 hover:bg-theme-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
      title="Switch agent"
      aria-label="Switch agent"
      :aria-expanded="open"
      @click="toggle"
    >
      <Icon
        icon="lucide:arrow-left-right"
        class="h-4 w-4"
      />
    </button>
  </span>

  <Teleport to="body">
    <div
      v-if="open"
      ref="menu"
      class="fixed z-[110] flex flex-col overflow-hidden rounded-xl border border-theme-700 bg-theme-900 shadow-2xl shadow-black/40"
      :style="menuStyle"
      role="dialog"
      aria-label="Quick agent picker"
      @keydown.esc.stop="close"
    >
      <div class="border-b border-theme-700 px-3 py-2.5">
        <div class="mb-2 text-xs font-semibold text-theme-100">
          Switch chat
        </div>
        <div class="flex items-center gap-2 rounded-lg border border-theme-700 bg-theme-950 px-2.5 py-1.5 text-theme-500">
          <Icon
            icon="lucide:search"
            class="h-3.5 w-3.5 shrink-0"
          />
          <input
            ref="searchInput"
            v-model="search"
            type="search"
            placeholder="Search agents…"
            aria-label="Search agents"
            class="min-w-0 flex-1 bg-transparent text-xs text-theme-100 outline-none placeholder:text-theme-500"
          >
        </div>
      </div>
      <div class="min-h-0 overflow-y-auto p-1.5">
        <template
          v-for="group in [
            { label: 'Favorites', items: visibleFavorites },
            { label: 'Recently used', items: visibleRecent },
            { label: 'Other chats', items: other },
          ]"
          :key="group.label"
        >
          <div
            v-if="group.items.length"
            class="pb-1"
          >
            <div class="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-theme-500">
              {{ group.label }}
            </div>
            <button
              v-for="entry in group.items"
              :key="entry.id ?? 'free-chat'"
              type="button"
              class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-theme-800 focus-visible:outline-none focus-visible:bg-theme-800"
              :aria-current="chatStore.activeAgentId === entry.id ? 'true' : undefined"
              @click="select(entry)"
            >
              <span class="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-theme-800 text-accent-400">
                <img
                  v-if="entry.iconUrl"
                  :src="entry.iconUrl"
                  alt=""
                  class="h-full w-full object-cover"
                >
                <Icon
                  v-else
                  :icon="entry.id ? 'lucide:bot' : 'lucide:message-square'"
                  class="h-4 w-4"
                />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-xs font-medium text-theme-100">{{ entry.label }}</span>
                <span
                  v-if="entry.description"
                  class="block truncate text-[10px] text-theme-500"
                >{{ entry.description }}</span>
              </span>
              <Icon
                v-if="chatStore.activeAgentId === entry.id"
                icon="lucide:check"
                class="h-3.5 w-3.5 text-accent-400"
              />
            </button>
          </div>
        </template>
        <div
          v-if="!visibleFavorites.length && !visibleRecent.length && !other.length"
          class="px-2 py-5 text-center text-xs text-theme-500"
        >
          No agents found
        </div>
      </div>
    </div>
  </Teleport>
</template>
