<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useChatStore } from '../../../stores/chat.store'
import { useAgentStore } from '../../../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../../../stores/agent-definitions.store'
import { useProviderStore } from '../../../stores/provider.store'
import { Icon } from '@iconify/vue'
import ModalDialog from '../../shared/ModalDialog.vue'

const chatStore = useChatStore()
const agentStore = useAgentStore()
const agentDefs = useAgentDefinitionsStore()
const providerStore = useProviderStore()
const router = useRouter()

const hasOverrides = computed(() => chatStore.hasAgentOverrides)

const showModal = ref(false)
const newAgentName = ref('')
const newAgentDescription = ref('')
const savingAgent = ref(false)

const canSaveAsAgent = computed(() => {
  return (
    agentStore.selectedToolNames.length > 0 ||
    chatStore.freeChatSubAgentIds.length > 0 ||
    chatStore.freeChatMemorySpaceIds.length > 0 ||
    chatStore.sessionSystemPrompt.trim().length > 0
  )
})

function openModal() {
  const currentAgent = chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null
  newAgentName.value = currentAgent ? `${currentAgent.name} (copy)` : ''
  newAgentDescription.value = currentAgent?.description || ''
  showModal.value = true
}

async function saveAsNewAgent() {
  if (!newAgentName.value.trim() || savingAgent.value) return
  savingAgent.value = true
  try {
    const lastUsedProvider = providerStore.lastUsedProvider
    const currentAgent = chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null
    const providerId = chatStore.sessionProviderOverride || currentAgent?.providerId || lastUsedProvider?.id || ''
    const model = chatStore.sessionModelOverride || currentAgent?.model || lastUsedProvider?.defaultModel || ''

    const subAgents = chatStore.freeChatSubAgentIds.map(id => {
      const def = agentDefs.get(id)
      const codename = def
        ? def.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_agent'
        : id
      return { agentId: id, codename, role: def?.description || '' }
    })

    const agent = await agentDefs.create({
      name: newAgentName.value.trim(),
      description: newAgentDescription.value.trim(),
      providerId,
      model,
      systemPrompt: chatStore.sessionSystemPrompt,
      tools: [...agentStore.selectedToolNames],
      subAgents,
      memorySpaces: [...chatStore.freeChatMemorySpaceIds],
    })
    showModal.value = false
    newAgentName.value = ''
    newAgentDescription.value = ''
    router.push(`/agents/${agent.id}`)
  } catch { /* error */ }
  savingAgent.value = false
}
</script>

<template>
  <!-- Agent override bar: apply / reset -->
  <div
    v-if="hasOverrides"
    class="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5"
  >
    <Icon
      icon="lucide:info"
      class="w-3.5 h-3.5 text-amber-400 shrink-0"
    />
    <span class="text-[11px] text-amber-300 flex-1">Agent config overridden for this session</span>
    <button
      class="text-[11px] px-2 py-0.5 rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
      title="Discard overrides and reset to agent defaults"
      @click="chatStore.resetAgentOverrides()"
    >
      Reset
    </button>
    <button
      class="text-[11px] px-2 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-500 transition-colors"
      title="Save these changes to the agent definition permanently"
      @click="chatStore.applyOverridesToAgent()"
    >
      Apply to Agent
    </button>
    <button
      class="text-[11px] px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors"
      title="Create a new agent from the current session configuration"
      @click="openModal"
    >
      Save as New Agent
    </button>
  </div>

  <!-- Free chat: save as agent hint -->
  <div
    v-else-if="!chatStore.activeAgentId && canSaveAsAgent"
    class="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-lg border border-zinc-700/50 bg-zinc-800/40"
  >
    <Icon
      icon="lucide:bot"
      class="w-3.5 h-3.5 text-zinc-400 shrink-0"
    />
    <span class="text-[11px] text-zinc-400 flex-1">Session has custom configuration</span>
    <button
      class="text-[11px] px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors flex items-center gap-1"
      title="Create a new agent from the current session configuration"
      @click="openModal"
    >
      <Icon
        icon="lucide:save"
        class="w-3 h-3"
      />
      Save as Agent
    </button>
  </div>

  <!-- Save as Agent modal -->
  <ModalDialog
    :show="showModal"
    title="Save as New Agent"
    icon="lucide:bot"
    icon-color="blue"
    @close="showModal = false"
  >
    <p class="text-sm text-zinc-400 mb-4">
      Create a new agent from the current session configuration, including tools, sub-agents, memory spaces, and system prompt.
    </p>
    <div class="space-y-3">
      <div>
        <label class="block text-xs text-zinc-400 mb-1">Agent Name</label>
        <input
          v-model="newAgentName"
          type="text"
          class="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500 transition-colors"
          placeholder="e.g. Research Assistant"
          @keydown.enter="saveAsNewAgent"
        >
      </div>
      <div>
        <label class="block text-xs text-zinc-400 mb-1">Description (optional)</label>
        <input
          v-model="newAgentDescription"
          type="text"
          class="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500 transition-colors"
          placeholder="What does this agent do?"
        >
      </div>
      <!-- Config summary -->
      <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-1.5">
        <p class="text-[11px] text-zinc-500 font-medium uppercase tracking-wider mb-1">
          Configuration
        </p>
        <div
          v-if="agentStore.selectedToolNames.length"
          class="flex items-center gap-1.5 text-xs text-zinc-400"
        >
          <Icon
            icon="mdi:tools"
            class="w-3 h-3 text-blue-400"
          />
          {{ agentStore.selectedToolNames.length }} tool{{ agentStore.selectedToolNames.length !== 1 ? 's' : '' }}
        </div>
        <div
          v-if="chatStore.freeChatSubAgentIds.length"
          class="flex items-center gap-1.5 text-xs text-zinc-400"
        >
          <Icon
            icon="lucide:bot"
            class="w-3 h-3 text-blue-400"
          />
          {{ chatStore.freeChatSubAgentIds.length }} sub-agent{{ chatStore.freeChatSubAgentIds.length !== 1 ? 's' : '' }}
        </div>
        <div
          v-if="chatStore.freeChatMemorySpaceIds.length"
          class="flex items-center gap-1.5 text-xs text-zinc-400"
        >
          <Icon
            icon="lucide:brain"
            class="w-3 h-3 text-purple-400"
          />
          {{ chatStore.freeChatMemorySpaceIds.length }} memory space{{ chatStore.freeChatMemorySpaceIds.length !== 1 ? 's' : '' }}
        </div>
        <div
          v-if="chatStore.sessionSystemPrompt.trim()"
          class="flex items-center gap-1.5 text-xs text-zinc-400"
        >
          <Icon
            icon="lucide:scroll-text"
            class="w-3 h-3 text-amber-400"
          />
          Custom system prompt
        </div>
      </div>
    </div>
    <template #actions>
      <div class="flex justify-end gap-2">
        <button
          class="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          @click="showModal = false"
        >
          Cancel
        </button>
        <button
          :disabled="!newAgentName.trim() || savingAgent"
          class="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg disabled:opacity-50 transition-colors flex items-center gap-1.5"
          @click="saveAsNewAgent"
        >
          <Icon
            v-if="savingAgent"
            icon="lucide:loader-2"
            class="w-3.5 h-3.5 animate-spin"
          />
          Create Agent
        </button>
      </div>
    </template>
  </ModalDialog>
</template>
