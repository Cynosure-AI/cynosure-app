<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { useChatStore } from '../../stores/chat.store'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { useProviderStore } from '../../stores/provider.store'
import ModalDialog from '../shared/ModalDialog.vue'

const chatStore = useChatStore()
const agentDefs = useAgentDefinitionsStore()
const providerStore = useProviderStore()
const router = useRouter()

const menuOpen = ref(false)
const saveModalOpen = ref(false)
const newAgentName = ref('')
const newAgentDescription = ref('')
const savingAgent = ref(false)

const hasOverrides = computed(() => chatStore.hasAgentOverrides)
const canSaveAsAgent = computed(() => (
  chatStore.selectedToolNames.length > 0 ||
  chatStore.freeChatSubAgentIds.length > 0 ||
  chatStore.hasFreeChatOverrides ||
  chatStore.sessionSystemPrompt.trim().length > 0
))
const hasCustomConfig = computed(() => hasOverrides.value || (
  !chatStore.activeAgentId && (chatStore.hasFreeChatOverrides || canSaveAsAgent.value)
))
const canShowSaveAction = computed(() => hasOverrides.value || (
  !chatStore.activeAgentId && canSaveAsAgent.value
))
const activeConversation = computed(() => chatStore.activeConversation)
const hasActiveChat = computed(() => Boolean(chatStore.activeConversationId))
const activeConversationPinned = computed(() => activeConversation.value?.pinned === true)
const hasAgentActions = computed(() => hasCustomConfig.value || canShowSaveAction.value)

async function togglePin(): Promise<void> {
  const conversationId = chatStore.activeConversationId
  if (!conversationId) return
  if (!activeConversation.value) await chatStore.loadConversations()
  const pinned = chatStore.activeConversation?.pinned === true
  await chatStore.pinConversation(conversationId, !pinned)
  await chatStore.loadConversations()
  menuOpen.value = false
}

function resetConfig(): void {
  if (chatStore.activeAgentId) chatStore.resetAgentOverrides()
  else chatStore.resetToDefaults()
  menuOpen.value = false
}

async function applyChanges(): Promise<void> {
  await chatStore.applyOverridesToAgent()
  menuOpen.value = false
}

function openSaveModal(): void {
  const currentAgent = chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null
  newAgentName.value = currentAgent ? `${currentAgent.name} (copy)` : ''
  newAgentDescription.value = currentAgent?.description || ''
  saveModalOpen.value = true
  menuOpen.value = false
}

async function saveAsNewAgent(): Promise<void> {
  if (!newAgentName.value.trim() || savingAgent.value) return
  savingAgent.value = true
  try {
    const lastUsedProvider = providerStore.lastUsedProvider
    const currentAgent = chatStore.activeAgentId ? agentDefs.get(chatStore.activeAgentId) : null
    const providerId = chatStore.sessionProviderOverride || currentAgent?.providerId || lastUsedProvider?.id || ''
    const model = chatStore.sessionProviderOverride && !chatStore.sessionModelOverride
      ? ''
      : chatStore.sessionModelOverride || currentAgent?.model || lastUsedProvider?.defaultModel || ''
    const subAgents = chatStore.freeChatSubAgentIds.map((id) => {
      const definition = agentDefs.get(id)
      const codename = definition
        ? `${definition.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}_agent`
        : id
      return { agentId: id, codename, role: definition?.description || '' }
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
    saveModalOpen.value = false
    newAgentName.value = ''
    newAgentDescription.value = ''
    await router.push(`/agents/${agent.id}`)
  } catch {
    // The agent store surfaces request failures globally.
  } finally {
    savingAgent.value = false
  }
}
</script>

<template>
  <div class="relative shrink-0">
    <button
      type="button"
      class="relative flex h-7 w-8 items-center justify-center rounded-lg text-theme-400 transition-colors hover:bg-theme-800 hover:text-theme-200"
      title="Chat / Agent Settings"
      aria-label="Chat / Agent Settings"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      @click.stop="menuOpen = !menuOpen"
    >
      <Icon
        icon="lucide:ellipsis"
        class="h-4 w-4"
      />
      <span
        v-if="hasCustomConfig"
        class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-400"
        aria-label="Unsaved configuration changes"
      />
    </button>

    <div
      v-if="menuOpen"
      role="menu"
      aria-label="Chat / Agent Settings"
      class="absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-xl border border-theme-700 bg-theme-950 py-1.5 shadow-2xl shadow-black/40"
      @click.stop
    >
      <div class="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-theme-500">
        Chat
      </div>
      <button
        v-if="hasActiveChat"
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
        @click="togglePin"
      >
        <Icon
          :icon="activeConversationPinned ? 'lucide:pin-off' : 'lucide:pin'"
          class="h-3.5 w-3.5 text-amber-400"
        />
        {{ activeConversationPinned ? 'Unpin Chat' : 'Pin Chat' }}
      </button>
      <p
        v-else
        class="px-3 py-2 text-xs text-theme-600"
      >
        No chat selected
      </p>

      <div
        class="mx-3 my-1 border-t border-theme-800"
      />
      <div class="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-theme-500">
        Agent
      </div>
      <div
        v-if="hasCustomConfig"
        class="px-3 py-1.5"
      >
        <p class="text-[11px] font-medium text-theme-300">
          {{ hasOverrides ? 'Agent configuration modified' : 'Custom Free Chat configuration' }}
        </p>
        <p
          v-if="hasOverrides && chatStore.agentOverrideFields.length"
          class="mt-0.5 text-[10px] leading-relaxed text-theme-500"
        >
          Changed: {{ chatStore.agentOverrideFields.join(', ') }}
        </p>
      </div>
      <button
        v-if="hasOverrides"
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-amber-300 hover:bg-theme-800"
        @click="applyChanges"
      >
        <Icon
          icon="lucide:check"
          class="h-3.5 w-3.5"
        />
        Apply Changes
      </button>
      <button
        v-if="hasCustomConfig"
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
        @click="resetConfig"
      >
        <Icon
          icon="lucide:rotate-ccw"
          class="h-3.5 w-3.5 text-theme-500"
        />
        Reset to Defaults
      </button>
      <button
        v-if="canShowSaveAction"
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-theme-300 hover:bg-theme-800"
        @click="openSaveModal"
      >
        <Icon
          icon="lucide:bot"
          class="h-3.5 w-3.5 text-accent-400"
        />
        Save as New Agent
      </button>
      <p
        v-if="!hasAgentActions"
        class="px-3 py-2 text-xs text-theme-600"
      >
        No agent changes
      </p>
    </div>

    <div
      v-if="menuOpen"
      class="fixed inset-0 z-40"
      aria-hidden="true"
      @click="menuOpen = false"
    />
  </div>

  <ModalDialog
    :show="saveModalOpen"
    title="Save as New Agent"
    icon="lucide:bot"
    icon-color="accent"
    @close="saveModalOpen = false"
  >
    <p class="mb-4 text-sm text-theme-400">
      Create a new agent from the current session configuration, including tools, sub-agents, memory folders, and system prompt.
    </p>
    <div class="space-y-3">
      <div>
        <label class="mb-1 block text-xs text-theme-400">Agent Name</label>
        <input
          v-model="newAgentName"
          type="text"
          class="w-full rounded-lg border border-theme-700 bg-theme-800 px-3 py-2 text-sm text-theme-200 outline-none transition-colors placeholder-theme-500 focus:border-accent-500"
          placeholder="e.g. Research Assistant"
          @keydown.enter="saveAsNewAgent"
        >
      </div>
      <div>
        <label class="mb-1 block text-xs text-theme-400">Description (optional)</label>
        <input
          v-model="newAgentDescription"
          type="text"
          class="w-full rounded-lg border border-theme-700 bg-theme-800 px-3 py-2 text-sm text-theme-200 outline-none transition-colors placeholder-theme-500 focus:border-accent-500"
          placeholder="What does this agent do?"
        >
      </div>
      <div class="space-y-1.5 rounded-lg border border-theme-800 bg-theme-900/50 p-3 text-xs text-theme-400">
        <p class="mb-1 text-[11px] font-medium uppercase tracking-wider text-theme-500">
          Configuration
        </p>
        <p v-if="chatStore.selectedToolNames.length">
          {{ chatStore.selectedToolNames.length }} tool{{ chatStore.selectedToolNames.length === 1 ? '' : 's' }}
        </p>
        <p v-if="chatStore.freeChatSubAgentIds.length">
          {{ chatStore.freeChatSubAgentIds.length }} sub-agent{{ chatStore.freeChatSubAgentIds.length === 1 ? '' : 's' }}
        </p>
        <p v-if="chatStore.freeChatMemorySpaceIds.length">
          {{ chatStore.freeChatMemorySpaceIds.length }} memory folder{{ chatStore.freeChatMemorySpaceIds.length === 1 ? '' : 's' }}
        </p>
        <p v-if="chatStore.sessionSystemPrompt.trim()">
          Custom system prompt
        </p>
      </div>
    </div>
    <template #actions>
      <div class="flex justify-end gap-2">
        <button
          class="px-3 py-1.5 text-sm text-theme-400 transition-colors hover:text-theme-200"
          @click="saveModalOpen = false"
        >
          Cancel
        </button>
        <button
          :disabled="!newAgentName.trim() || savingAgent"
          class="flex items-center gap-1.5 rounded-lg bg-accent-600 px-4 py-1.5 text-sm text-white transition-colors hover:bg-accent-500 disabled:opacity-50"
          @click="saveAsNewAgent"
        >
          <Icon
            v-if="savingAgent"
            icon="lucide:loader-2"
            class="h-3.5 w-3.5 animate-spin"
          />
          Create Agent
        </button>
      </div>
    </template>
  </ModalDialog>
</template>
