<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useChatStore } from '../../../stores/chat.store'
import { useAgentDefinitionsStore } from '../../../stores/agent-definitions.store'
import { useProviderStore } from '../../../stores/provider.store'
import { Icon } from '@iconify/vue'
import ModalDialog from '../../shared/ModalDialog.vue'

const chatStore = useChatStore()
const agentDefs = useAgentDefinitionsStore()
const providerStore = useProviderStore()
const router = useRouter()

const hasOverrides = computed(() => chatStore.hasAgentOverrides)

const showModal = ref(false)
const showPopover = ref(false)
const newAgentName = ref('')
const newAgentDescription = ref('')
const savingAgent = ref(false)

const canSaveAsAgent = computed(() => {
  return (
    chatStore.selectedToolNames.length > 0 ||
    chatStore.freeChatSubAgentIds.length > 0 ||
    chatStore.hasFreeChatOverrides ||
    chatStore.sessionSystemPrompt.trim().length > 0
  )
})

const hasCustomConfig = computed(() => hasOverrides.value || (
  !chatStore.activeAgentId && (chatStore.hasFreeChatOverrides || canSaveAsAgent.value)
))

function openModal() {
  const currentAgent = chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null
  newAgentName.value = currentAgent ? `${currentAgent.name} (copy)` : ''
  newAgentDescription.value = currentAgent?.description || ''
  showModal.value = true
  showPopover.value = false
}

function resetConfig() {
  if (chatStore.activeAgentId) chatStore.resetAgentOverrides()
  else chatStore.resetToDefaults()
  showPopover.value = false
}

async function saveAsNewAgent() {
  if (!newAgentName.value.trim() || savingAgent.value) return
  savingAgent.value = true
  try {
    const lastUsedProvider = providerStore.lastUsedProvider
    const currentAgent = chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null
    const providerId = chatStore.sessionProviderOverride || currentAgent?.providerId || lastUsedProvider?.id || ''
    const model = chatStore.sessionProviderOverride && !chatStore.sessionModelOverride
      ? ''
      : chatStore.sessionModelOverride || currentAgent?.model || lastUsedProvider?.defaultModel || ''

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
      tools: [...chatStore.selectedToolNames],
      subAgents,
      memorySpaces: [...chatStore.freeChatMemorySpaceIds],
      thinkingEnabled: chatStore.sessionThinkingEnabled,
      reasoningEffort: chatStore.sessionReasoningEffort,
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
  <div
    v-if="hasCustomConfig"
    class="relative shrink-0"
  >
    <button
      type="button"
      class="relative rounded-lg bg-amber-500/10 p-1.5 text-amber-400 transition-colors hover:bg-amber-500/20 hover:text-amber-300"
      title="Session configuration differs from defaults"
      aria-label="Open session configuration status"
      aria-haspopup="dialog"
      :aria-expanded="showPopover"
      @click.stop="showPopover = !showPopover"
    >
      <Icon
        icon="lucide:info"
        class="h-4 w-4"
      />
      <span class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />
    </button>

    <div
      v-if="showPopover"
      role="dialog"
      aria-label="Session configuration status"
      class="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border border-theme-700 bg-theme-950 p-3 shadow-2xl shadow-black/40"
      @click.stop
    >
      <div class="flex items-start gap-2.5">
        <Icon
          icon="lucide:info"
          class="mt-0.5 h-4 w-4 shrink-0 text-amber-400"
        />
        <div class="min-w-0 flex-1">
          <p class="text-xs font-medium text-theme-200">
            {{ hasOverrides ? 'Agent config overridden for this session' : 'Session has custom configuration' }}
          </p>
          <p
            v-if="hasOverrides && chatStore.agentOverrideFields.length"
            class="mt-1 text-[11px] leading-relaxed text-theme-500"
          >
            Changed: {{ chatStore.agentOverrideFields.join(', ') }}
          </p>
        </div>
      </div>
      <div class="mt-3 flex flex-wrap justify-end gap-2">
        <button
          class="rounded bg-theme-700 px-2 py-1 text-[11px] text-theme-300 transition-colors hover:bg-theme-600"
          :title="hasOverrides ? 'Discard overrides and reset to current agent defaults' : 'Reset to default chat configuration'"
          @click="resetConfig"
        >
          Reset
        </button>
        <button
          v-if="hasOverrides"
          class="rounded bg-amber-600 px-2 py-1 text-[11px] text-white transition-colors hover:bg-amber-500"
          title="Save these changes to the agent definition permanently"
          @click="chatStore.applyOverridesToAgent(); showPopover = false"
        >
          Apply to Agent
        </button>
        <button
          class="rounded bg-accent-600 px-2 py-1 text-[11px] text-white transition-colors hover:bg-accent-500"
          title="Create a new agent from the current session configuration"
          @click="openModal"
        >
          {{ hasOverrides ? 'Save as New Agent' : 'Save as Agent' }}
        </button>
      </div>
    </div>

    <div
      v-if="showPopover"
      class="fixed inset-0 z-40"
      aria-hidden="true"
      @click="showPopover = false"
    />
  </div>

  <!-- Save as Agent modal -->
  <ModalDialog
    :show="showModal"
    title="Save as New Agent"
    icon="lucide:bot"
    icon-color="accent"
    @close="showModal = false"
  >
    <p class="text-sm text-theme-400 mb-4">
      Create a new agent from the current session configuration, including tools, sub-agents, memory folders, and system prompt.
    </p>
    <div class="space-y-3">
      <div>
        <label class="block text-xs text-theme-400 mb-1">Agent Name</label>
        <input
          v-model="newAgentName"
          type="text"
          class="w-full px-3 py-2 text-sm bg-theme-800 border border-theme-700 rounded-lg text-theme-200 placeholder-theme-500 focus:outline-none focus:border-accent-500 transition-colors"
          placeholder="e.g. Research Assistant"
          @keydown.enter="saveAsNewAgent"
        >
      </div>
      <div>
        <label class="block text-xs text-theme-400 mb-1">Description (optional)</label>
        <input
          v-model="newAgentDescription"
          type="text"
          class="w-full px-3 py-2 text-sm bg-theme-800 border border-theme-700 rounded-lg text-theme-200 placeholder-theme-500 focus:outline-none focus:border-accent-500 transition-colors"
          placeholder="What does this agent do?"
        >
      </div>
      <!-- Config summary -->
      <div class="rounded-lg border border-theme-800 bg-theme-900/50 p-3 space-y-1.5">
        <p class="text-[11px] text-theme-500 font-medium uppercase tracking-wider mb-1">
          Configuration
        </p>
        <div
          v-if="chatStore.selectedToolNames.length"
          class="flex items-center gap-1.5 text-xs text-theme-400"
        >
          <Icon
            icon="mdi:tools"
            class="w-3 h-3 text-accent-400"
          />
          {{ chatStore.selectedToolNames.length }} tool{{ chatStore.selectedToolNames.length !== 1 ? 's' : '' }}
        </div>
        <div
          v-if="chatStore.freeChatSubAgentIds.length"
          class="flex items-center gap-1.5 text-xs text-theme-400"
        >
          <Icon
            icon="lucide:bot"
            class="w-3 h-3 text-accent-400"
          />
          {{ chatStore.freeChatSubAgentIds.length }} sub-agent{{ chatStore.freeChatSubAgentIds.length !== 1 ? 's' : '' }}
        </div>
        <div
          v-if="chatStore.freeChatMemorySpaceIds.length"
          class="flex items-center gap-1.5 text-xs text-theme-400"
        >
          <Icon
            icon="lucide:brain"
            class="w-3 h-3 text-purple-400"
          />
          {{ chatStore.freeChatMemorySpaceIds.length }} memory folder{{ chatStore.freeChatMemorySpaceIds.length !== 1 ? 's' : '' }}
        </div>
        <div
          v-if="chatStore.sessionSystemPrompt.trim()"
          class="flex items-center gap-1.5 text-xs text-theme-400"
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
          class="px-3 py-1.5 text-sm text-theme-400 hover:text-theme-200 transition-colors"
          @click="showModal = false"
        >
          Cancel
        </button>
        <button
          :disabled="!newAgentName.trim() || savingAgent"
          class="px-4 py-1.5 bg-accent-600 hover:bg-accent-500 text-white text-sm rounded-lg disabled:opacity-50 transition-colors flex items-center gap-1.5"
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
