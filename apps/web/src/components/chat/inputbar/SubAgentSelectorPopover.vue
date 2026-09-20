<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CSSProperties } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { Icon } from '@iconify/vue'
import { useAgentDefinitionsStore } from '../../../stores/agent-definitions.store'
import { useChatStore } from '../../../stores/chat.store'
import { useProviderStore } from '../../../stores/provider.store'
import { useProviderLogos } from '../../../composables/useProviderLogos'

const agentDefs = useAgentDefinitionsStore()
const chatStore = useChatStore()
const providerStore = useProviderStore()
const { logoUrl } = useProviderLogos()

const root = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const open = ref(false)
const search = ref('')
const menuStyle = ref<CSSProperties>({})
const selectedIdsAtOpen = ref<Set<string>>(new Set())

const selectedSet = computed(() => new Set(chatStore.freeChatSubAgentIds))
const filteredAgents = computed(() => {
  const query = search.value.trim().toLowerCase()
  const matchingAgents = query
    ? agentDefs.agents.filter((agent) =>
    agent.name.toLowerCase().includes(query)
    || agent.internalName?.toLowerCase().includes(query)
    || agent.description?.toLowerCase().includes(query),
  )
    : agentDefs.agents

  return [...matchingAgents].sort((left, right) =>
    Number(selectedIdsAtOpen.value.has(right.id))
    - Number(selectedIdsAtOpen.value.has(left.id)),
  )
})
const missingCount = computed(() =>
  chatStore.freeChatSubAgentIds.filter((id) => !agentDefs.get(id)).length,
)

function toggleAgent(id: string): void {
  const index = chatStore.freeChatSubAgentIds.indexOf(id)
  if (index >= 0) chatStore.freeChatSubAgentIds.splice(index, 1)
  else chatStore.freeChatSubAgentIds.push(id)
  chatStore.markOverridesModified()
}

function clearAll(): void {
  chatStore.freeChatSubAgentIds.splice(0)
  chatStore.markOverridesModified()
}

function agentIcon(agent: { iconUrl: string | null; providerId: string }): string | null {
  if (agent.iconUrl) return agent.iconUrl
  const provider = providerStore.providers.find((item) => item.id === agent.providerId)
  return provider ? logoUrl(provider.type) : null
}

function updatePosition(): void {
  const rect = root.value?.getBoundingClientRect()
  if (!rect) return
  const padding = 8
  const gap = 8
  const preferredHeight = 512
  const width = Math.min(320, window.innerWidth - padding * 2)
  const availableAbove = Math.max(0, rect.top - gap - padding)
  const availableBelow = Math.max(0, window.innerHeight - rect.bottom - gap - padding)
  const openAbove = availableAbove >= Math.min(280, preferredHeight) || availableAbove >= availableBelow
  const availableHeight = openAbove ? availableAbove : availableBelow

  menuStyle.value = {
    width: `${width}px`,
    left: `${Math.min(Math.max(rect.left, padding), window.innerWidth - width - padding)}px`,
    maxHeight: `${Math.min(preferredHeight, availableHeight)}px`,
    ...(openAbove
      ? { bottom: `${window.innerHeight - rect.top + gap}px` }
      : { top: `${rect.bottom + gap}px` }),
  }
}

function close(): void {
  open.value = false
  search.value = ''
}

async function toggle(): Promise<void> {
  if (open.value) {
    close()
    return
  }
  selectedIdsAtOpen.value = new Set(chatStore.freeChatSubAgentIds)
  open.value = true
  await nextTick()
  updatePosition()
}

onClickOutside(root, close, { ignore: [menu] })

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
  <span
    ref="root"
    class="inline-flex"
  >
    <slot
      name="trigger"
      :open="open"
      :toggle="toggle"
      :close="close"
    />
  </span>

  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-100 ease-out"
      leave-active-class="transition duration-75 ease-in"
      enter-from-class="translate-y-1 opacity-0"
      leave-to-class="translate-y-1 opacity-0"
    >
      <div
        v-if="open"
        ref="menu"
        class="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-theme-700 bg-theme-900 shadow-2xl shadow-black/40"
        :style="menuStyle"
        role="menu"
        aria-label="Sub-agents"
        @keydown.esc="close"
      >
        <div class="flex items-center gap-2 border-b border-theme-700 px-3 py-3">
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-500/10 text-accent-400">
            <Icon
              icon="lucide:bot"
              class="h-4 w-4"
            />
          </span>
          <div class="min-w-0 flex-1">
            <div class="text-xs font-semibold text-theme-100">
              Sub-Agent Selection
            </div>
            <div class="text-[10px] text-theme-500">
              Make agents available for the main agent to delegate tasks to during this conversation.
            </div>
          </div>
        </div>

        <div class="border-b border-theme-800 p-2">
          <label class="flex items-center gap-2 rounded-lg border border-theme-700 bg-theme-800 px-2.5 py-1.5 focus-within:ring-1 focus-within:ring-accent-500">
            <Icon
              icon="lucide:search"
              class="h-3.5 w-3.5 shrink-0 text-theme-500"
            />
            <input
              v-model="search"
              type="search"
              class="min-w-0 flex-1 bg-transparent text-xs text-theme-200 outline-none placeholder:text-theme-600"
              placeholder="Search sub-agents..."
              aria-label="Search sub-agents"
            >
          </label>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
          <div
            v-if="filteredAgents.length === 0"
            class="px-3 py-6 text-center text-xs text-theme-500"
          >
            {{ search ? `No sub-agents match “${search}”` : 'No agents created yet' }}
          </div>
          <div
            v-for="agent in filteredAgents"
            :key="agent.id"
            class="group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left text-theme-300 transition-colors hover:bg-theme-800/70 hover:text-theme-100"
            role="menuitem"
            tabindex="0"
            @click="toggleAgent(agent.id)"
            @keydown.enter.prevent="toggleAgent(agent.id)"
            @keydown.space.prevent="toggleAgent(agent.id)"
          >
            <button
              type="button"
              class="flex h-4 w-4 shrink-0 items-center justify-center rounded border"
              :class="selectedSet.has(agent.id) ? 'border-accent-500 bg-accent-500 text-white' : 'border-theme-600 bg-theme-950'"
              role="checkbox"
              :aria-checked="selectedSet.has(agent.id)"
              :aria-label="`Toggle ${agent.name}`"
              @click.stop="toggleAgent(agent.id)"
            >
              <Icon
                v-if="selectedSet.has(agent.id)"
                icon="lucide:check"
                class="h-3 w-3"
              />
            </button>
            <span class="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-theme-800">
              <img
                v-if="agentIcon(agent)"
                :src="agentIcon(agent)!"
                alt=""
                class="h-full w-full object-contain"
              >
              <Icon
                v-else
                icon="lucide:bot"
                class="h-4 w-4 text-theme-500"
              />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-xs font-medium">{{ agent.name }}</span>
              <span class="mt-0.5 block truncate text-[10px] text-theme-500">
                {{ agent.description || agent.internalName || 'No description available' }}
              </span>
            </span>
          </div>
        </div>

        <div class="flex items-center justify-between border-t border-theme-800 px-3 py-2 text-[10px] text-theme-500">
          <span>
            {{ chatStore.freeChatSubAgentIds.length }} sub-agent{{ chatStore.freeChatSubAgentIds.length === 1 ? '' : 's' }} selected
            <span
              v-if="missingCount"
              class="text-amber-400"
            > · {{ missingCount }} unavailable</span>
          </span>
          <button
            v-if="chatStore.freeChatSubAgentIds.length"
            type="button"
            class="text-theme-400 hover:text-theme-200"
            @click="clearAll"
          >
            Clear all
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
