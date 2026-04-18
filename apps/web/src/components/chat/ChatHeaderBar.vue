<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useChatStore } from '../../stores/chat.store'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { useProviderStore } from '../../stores/provider.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { Icon } from '@iconify/vue'
import CustomSelect, { type SelectOptionGroup } from '../shared/CustomSelect.vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import { useChatSidebar } from '../../composables/useSidebar'
import { useProviderLogos } from '../../composables/useProviderLogos'
import { useRouter } from 'vue-router'

withDefaults(defineProps<{
  /** 'chat' = full selectors + sidebar toggle; 'instance' = read-only + back button */
  mode?: 'chat' | 'instance'
  /** Route for the back button (instance mode only) */
  backRoute?: string
  /** Instance type label (instance mode) */
  instanceType?: string
  /** Instance type icon (instance mode) */
  instanceIcon?: string
  /** Instance type color class (instance mode) */
  instanceColor?: string
}>(), {
  mode: 'chat',
  backRoute: '/instances',
  instanceType: '',
  instanceIcon: 'lucide:message-circle',
  instanceColor: 'text-blue-400',
})

const router = useRouter()
const { logoUrl } = useProviderLogos()
const chatStore = useChatStore()
const agentStore = useAgentStore()
const providerStore = useProviderStore()
const agentDefs = useAgentDefinitionsStore()
const { chatSidebarOpen, toggle: toggleSidebar } = useChatSidebar()

const selectedAgent = computed(() =>
  chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null
)

const conversationTitle = computed(() => chatStore.activeConversation?.title || '')

const dropdownValue = computed(() => chatStore.activeAgentId || '')

const agentDropdownGroups = computed((): SelectOptionGroup[] => {
  const base: SelectOptionGroup = {
    options: [{ value: '', label: 'Default', iconName: 'lucide:message-square' }],
  }
  if (!agentDefs.agents.length) return [base]
  const sorted = [...agentDefs.agents].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  return [
    base,
    {
      label: 'Agents',
      options: sorted.map((a) => {
        let imgSrc: string | null = a.iconUrl || null
        if (!imgSrc) {
          const prov = providerStore.providers.find((p) => p.id === a.providerId)
          if (prov) imgSrc = logoUrl(prov.type)
        }
        return {
          value: a.id,
          label: a.name,
          imgSrc,
          tooltip: a.description || undefined,
          tag: a.subAgents?.length ? `+${a.subAgents.length}` : undefined,
        }
      }),
    },
  ]
})

const providerDropdownGroups = computed((): SelectOptionGroup[] => [{
  options: providerStore.providers.map((p) => ({
    value: p.id,
    label: p.name,
    imgSrc: logoUrl(p.type),
  })),
}])

// ─── Model selector ───────────────────────────────────────
const sidebarModels = ref<string[]>([])
const loadingModels = ref(false)

const currentProviderId = computed(() =>
  chatStore.sessionProviderOverride || selectedAgent.value?.providerId || providerStore.lastUsedProviderId
)

const defaultModelLabel = computed(() => {
  const agentModel = selectedAgent.value?.model
  const provider = providerStore.providers.find(p => p.id === currentProviderId.value)
  const providerDefault = provider?.defaultModel
  // When provider is overridden away from the agent's own provider, the agent's
  // model doesn't exist on the new provider — show the provider's default instead.
  const isProviderOverridden = chatStore.sessionProviderOverride &&
    chatStore.sessionProviderOverride !== selectedAgent.value?.providerId
  const effectiveDefault = isProviderOverridden ? providerDefault : (agentModel || providerDefault)
  return effectiveDefault ? `Default (${effectiveDefault})` : 'Provider default'
})

const modelDropdownGroups = computed((): SelectOptionGroup[] => [{
  options: [
    { value: '', label: defaultModelLabel.value },
    ...sidebarModels.value.map((m) => ({ value: m, label: m })),
  ],
}])

async function fetchSidebarModels(): Promise<void> {
  const providerId = currentProviderId.value
  if (!providerId) return
  loadingModels.value = true
  try {
    sidebarModels.value = await providerStore.listModels(providerId, 'llm')
  } catch {
    sidebarModels.value = []
  } finally {
    loadingModels.value = false
  }
}

function onProviderOverride(providerId: string): void {
  // Provider change → clear model (downstream in the chain), keep provider override
  chatStore.sessionModelOverride = null
  if (chatStore.activeAgentId) {
    // If switching back to the agent's own provider, clear both overrides entirely.
    chatStore.sessionProviderOverride =
      providerId !== selectedAgent.value?.providerId ? providerId : null
  } else {
    // Free chat — set per-session override so it persists per conversation,
    // AND update the global active provider for new chats.
    chatStore.sessionProviderOverride = providerId
    providerStore.setLastUsed(providerId)
  }
}

function onModelChange(value: string): void {
  // Model is downstream of provider — changing model never affects the provider override.
  chatStore.sessionModelOverride = value || null
}

watch(currentProviderId, (newId, oldId) => {
  if (newId !== oldId) sidebarModels.value = []
  if (newId) fetchSidebarModels()
}, { immediate: true })

async function onAgentChange(value: string) {
  const agentId = value || null
  await chatStore.setActiveAgent(agentId)
  if (agentId) {
    const agent = agentDefs.get(agentId)
    if (agent?.providerId) {
      providerStore.setLastUsed(agent.providerId)
    }
  }
}

async function newChat(): Promise<void> {
  chatStore.startNewChat()
  agentStore.clearExecution()
}
</script>

<template>
  <div class="shrink-0 border-b border-zinc-800/60 px-3 py-2 flex items-center gap-2">
    <!-- ── Chat mode: sidebar toggle + selectors ── -->
    <template v-if="mode === 'chat'">
      <!-- Sidebar toggle -->
      <button
        class="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors text-zinc-500 hover:text-zinc-300"
        title="Toggle chat history"
        @click="toggleSidebar"
      >
        <Icon
          :icon="chatSidebarOpen ? 'lucide:panel-left-close' : 'lucide:panel-left-open'"
          class="w-4 h-4"
        />
      </button>

      <!-- Agent selector -->
      <div class="w-44 shrink-0">
        <CustomSelect
          :model-value="dropdownValue"
          :groups="agentDropdownGroups"
          placeholder="Default"
          placeholder-icon="lucide:message-square"
          max-height="max-h-96"
          :filterable="true"
          @change="onAgentChange"
        />
      </div>

      <!-- Provider selector -->
      <div
        v-if="providerStore.providers.length > 1"
        class="w-36 shrink-0 hidden sm:block"
      >
        <CustomSelect
          :model-value="currentProviderId"
          :groups="providerDropdownGroups"
          max-height="max-h-96"
          @change="onProviderOverride"
        />
      </div>

      <!-- Model selector -->
      <div
        v-if="currentProviderId"
        class="items-center gap-1 hidden sm:flex"
      >
        <div class="w-52 shrink-0">
          <CustomSelect
            :model-value="chatStore.sessionModelOverride || ''"
            :groups="modelDropdownGroups"
            max-height="max-h-96"
            dropdown-width="min-w-full"
            :filterable="true"
            @change="onModelChange"
          />
        </div>
        <button
          :disabled="loadingModels"
          class="p-1 text-zinc-500 hover:text-zinc-300 disabled:opacity-40 rounded-lg transition-colors shrink-0"
          title="Load available models"
          @click="fetchSidebarModels"
        >
          <Icon
            :icon="loadingModels ? 'lucide:loader-2' : 'lucide:refresh-cw'"
            class="w-3.5 h-3.5"
            :class="{ 'animate-spin': loadingModels }"
          />
        </button>
      </div>

      <!-- Sub-agent override toggle -->
      <label
        v-if="(chatStore.sessionModelOverride || chatStore.sessionProviderOverride) && (selectedAgent?.subAgents?.length || chatStore.freeChatSubAgentIds?.length)"
        class="items-center gap-1.5 hidden md:flex cursor-pointer select-none shrink-0"
        :title="chatStore.sessionOverrideSubAgents ? 'Override applies to all sub-agents — click to restrict to main agent only' : 'Override applies to main agent only — click to propagate to sub-agents'"
      >
        <ToggleSwitch
          :model-value="chatStore.sessionOverrideSubAgents"
          size="sm"
          color="amber"
          @update:model-value="chatStore.sessionOverrideSubAgents = $event"
        />
        <span
          class="text-[10px]"
          :class="chatStore.sessionOverrideSubAgents ? 'text-amber-400' : 'text-zinc-500'"
        >
          Apply to All agents
        </span>
      </label>

      <!-- Conversation title -->
      <span
        v-if="conversationTitle"
        class="text-xs text-zinc-500 truncate hidden md:inline"
      >
        {{ conversationTitle }}
      </span>
    </template>

    <!-- ── Instance mode: back button + agent info ── -->
    <template v-else>
      <!-- Back button -->
      <button
        class="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors text-zinc-500 hover:text-zinc-300"
        @click="router.push(backRoute)"
      >
        <Icon
          icon="lucide:arrow-left"
          class="w-4 h-4"
        />
      </button>

      <!-- Agent icon -->
      <img
        v-if="selectedAgent?.iconUrl"
        :src="selectedAgent.iconUrl"
        alt=""
        class="w-7 h-7 rounded-lg object-cover shrink-0"
      >
      <div
        v-else
        class="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center shrink-0"
      >
        <Icon
          icon="lucide:bot"
          class="w-4 h-4 text-zinc-500"
        />
      </div>

      <!-- Agent name + instance type -->
      <div class="min-w-0">
        <div class="text-sm font-medium text-zinc-200 truncate">
          {{ selectedAgent?.name || 'Agent' }}
        </div>
        <div
          v-if="instanceType"
          class="text-xs text-zinc-500 flex items-center gap-1.5"
        >
          <Icon
            :icon="instanceIcon"
            class="w-3 h-3"
            :class="instanceColor"
          />
          {{ instanceType }}
        </div>
      </div>

      <!-- Conversation title -->
      <span
        v-if="conversationTitle"
        class="text-xs text-zinc-500 truncate hidden sm:inline"
      >
        — {{ conversationTitle }}
      </span>

      <!-- Execution status -->
      <div class="flex items-center gap-1.5 ml-auto shrink-0">
        <span
          class="w-2 h-2 rounded-full"
          :class="agentStore.isExecuting ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-600'"
        />
        <span
          class="text-xs"
          :class="agentStore.isExecuting ? 'text-emerald-400' : 'text-zinc-500'"
        >{{ agentStore.isExecuting ? 'Running' : 'Idle' }}</span>
      </div>
    </template>

    <!-- ── Right section (chat mode only) ── -->
    <template v-if="mode === 'chat'">
      <div class="flex-1" />

      <!-- New Chat button -->
      <button
        class="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium transition-colors shrink-0"
        @click="newChat"
      >
        <Icon
          icon="lucide:plus"
          class="w-3.5 h-3.5"
        />
        <span class="hidden sm:inline">New Chat</span>
      </button>
    </template>
  </div>
</template>
