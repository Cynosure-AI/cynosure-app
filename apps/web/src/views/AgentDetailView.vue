<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import type { Component } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useAgentHealthStore } from '../stores/agent-health.store'
import { useChatStore } from '../stores/chat.store'
import { useCynoStore } from '../stores/cyno.store'
import { Icon } from '@iconify/vue'
import type { AgentDefinition } from '../api/types'
import AgentGeneralTab from '../components/agent/AgentGeneralTab.vue'
import AgentToolsTab from '../components/agent/AgentToolsTab.vue'
import AgentMemoryTab from '../components/agent/AgentMemoryTab.vue'
import AgentSubAgentsTab from '../components/agent/AgentSubAgentsTab.vue'
import AgentAdvancedTab from '../components/agent/AgentAdvancedTab.vue'
import ModalDialog from '../components/shared/ModalDialog.vue'
import AgentAvatar from '../components/shared/AgentAvatar.vue'
import TabBar, { type TabDef } from '../components/shared/TabBar.vue'

type AgentSectionId = 'general' | 'tools' | 'sub-agents' | 'memory' | 'advanced'

interface AgentSection {
  id: AgentSectionId
  label: string
  description: string
  icon: string
  component: Component
}

const route = useRoute()
const router = useRouter()
const agentDefs = useAgentDefinitionsStore()
const agentHealth = useAgentHealthStore()
const chatStore = useChatStore()
const cyno = useCynoStore()

const activeSectionId = ref<AgentSectionId>('general')

/** The same editor configures Cyno, the default assistant, whose settings live in its profile. */
const isCyno = computed(() => route.name === 'cyno')
const agentId = computed(() => route.params.id as string)

/** Cyno's profile in agent shape, so the agent tabs can edit it. */
const cynoAgent = computed<AgentDefinition | null>(() => {
  const profile = cyno.profile
  if (!profile) return null
  return {
    id: 'cyno', name: profile.name, internalName: 'cyno', description: '', category: '',
    iconUrl: cyno.displayIconUrl, imageUrl: profile.iconUrl, avatar: profile.avatar, avatarSource: profile.avatarSource, providerId: profile.providerId, model: profile.model, systemPrompt: profile.systemPrompt,
    tools: profile.effective.tools,
    subAgents: profile.subAgents,
    memoryFolders: profile.effective.memoryFolders,
    autoApproveTools: false, autoToolRouting: profile.autoToolRouting, autoMemory: profile.autoMemory,
    dreamingEnabled: profile.dreamingEnabled, autoRouterProviderId: '', autoRouterModel: '', generateTitle: true,
    thinkingEnabled: profile.thinkingEnabled, reasoningEffort: profile.reasoningEffort, maxContextTokens: null,
    sortOrder: 0, favorite: false, createdAt: 0, updatedAt: profile.updatedAt,
  }
})
const savedAgent = computed(() => isCyno.value ? cynoAgent.value : agentDefs.get(agentId.value))
const draft = ref<Partial<AgentDefinition>>({})
const agent = computed(() => savedAgent.value ? { ...savedAgent.value, ...draft.value } : null)
const changes = computed(() => Object.fromEntries(Object.entries(draft.value)
  .filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(savedAgent.value?.[field as keyof AgentDefinition]))) as Partial<AgentDefinition>)
const isDirty = computed(() => Object.keys(changes.value).length > 0)
const saving = ref(false)
const saveError = ref('')
const validationError = computed(() => {
  if (!agent.value?.name.trim()) return 'Name is required.'
  const limit = agent.value.maxContextTokens
  if (!isCyno.value && limit != null && (!Number.isSafeInteger(limit) || limit < 2048)) return 'Context limit must be at least 2,048 whole tokens.'
  return ''
})
const canSave = computed(() => isDirty.value && !validationError.value && !saving.value)
const showUnsavedDialog = ref(false)
let resolveLeave: ((leave: boolean) => void) | null = null

watch(() => [isCyno.value, agentId.value], () => {
  draft.value = {}
  saveError.value = ''
  activeSectionId.value = 'general'
})
const CYNO_FIELDS = new Set(['name', 'imageUrl', 'avatar', 'avatarSource', 'systemPrompt', 'providerId', 'model', 'tools', 'subAgents', 'memoryFolders', 'autoToolRouting', 'autoMemory', 'dreamingEnabled', 'thinkingEnabled', 'reasoningEffort'])
/** The face the draft would show, so switching tabs or uploading previews before saving. */
const headerIconUrl = computed(() => agent.value?.avatarSource === 'image' ? agent.value.imageUrl : null)
const activeSection = computed(() => sections.find(section => section.id === activeSectionId.value) || sections[0])
const returnToChat = computed(() => {
  const target = route.query.returnTo
  if (typeof target !== 'string' || !target.startsWith('/chat')) return null
  const destination = router.resolve(target)
  return destination.name === 'triggers-chat' || destination.name === 'conversation'
    ? target
    : null
})

function goBack(): void {
  void router.push(returnToChat.value ?? '/agents')
}

onMounted(async () => {
  void agentHealth.loadMemoryFolders()
  await agentDefs.load()
  if (isCyno.value) {
    if (!chatStore.memoryFolders.length) void chatStore.loadMemoryFolders()
    if (!cyno.profile) await cyno.load()
  }
  if (!agent.value) {
    router.push('/agents')
  }
})

function updateField(field: string, value: unknown): void {
  if (saving.value || !agent.value || (isCyno.value && !CYNO_FIELDS.has(field))) return
  draft.value = { ...draft.value, [field]: value }
  saveError.value = ''
}

function updateReasoning(enabled: boolean, effort: AgentDefinition['reasoningEffort']): void {
  updateField('thinkingEnabled', enabled)
  updateField('reasoningEffort', effort)
}

async function save(): Promise<boolean> {
  if (!canSave.value || !agent.value) return false
  saving.value = true
  saveError.value = ''
  try {
    const payload = { ...changes.value }
    if (payload.name !== undefined) payload.name = payload.name.trim()
    if (isCyno.value) {
      // Cyno's profile stores its image as iconUrl.
      const { imageUrl, ...profileChanges } = payload
      await cyno.update(imageUrl === undefined ? profileChanges : { ...profileChanges, iconUrl: imageUrl })
    }
    else await agentDefs.update(agentId.value, payload)
    draft.value = {}
    return true
  } catch (error) {
    saveError.value = `Changes were not saved: ${error instanceof Error ? error.message : String(error)}`
    return false
  } finally {
    saving.value = false
  }
}

function confirmLeave(): boolean | Promise<boolean> {
  if (saving.value) return false
  if (!isDirty.value) return true
  resolveLeave?.(false)
  showUnsavedDialog.value = true
  return new Promise((resolve) => { resolveLeave = resolve })
}

function finishLeave(leave: boolean): void {
  if (saving.value) return
  showUnsavedDialog.value = false
  const resolve = resolveLeave
  resolveLeave = null
  resolve?.(leave)
}

function discardAndLeave(): void {
  if (saving.value) return
  draft.value = {}
  saveError.value = ''
  finishLeave(true)
}

onBeforeRouteLeave(() => confirmLeave())
onBeforeRouteUpdate((to, from) => {
  if (to.name !== from.name || to.params.id !== from.params.id) return confirmLeave()
  return true
})

function beforeUnload(event: BeforeUnloadEvent): void {
  if (!isDirty.value && !saving.value) return
  event.preventDefault()
  event.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload)
  resolveLeave?.(false)
})

async function goToChat() {
  if (!await confirmLeave()) return
  await chatStore.setActiveAgent(isCyno.value ? null : agentId.value)
  await router.push({ name: 'triggers-chat' })
}

const sections: AgentSection[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Edit the agent identity, instructions, model, and core behavior.',
    icon: 'lucide:settings',
    component: AgentGeneralTab
  },
  {
    id: 'tools',
    label: 'Tools',
    description: 'Choose which tools this agent can use during conversations.',
    icon: 'lucide:wrench',
    component: AgentToolsTab
  },
  {
    id: 'memory',
    label: 'Memory',
    description: 'Control memory folders and retrieval behavior for this agent.',
    icon: 'lucide:database',
    component: AgentMemoryTab
  },
  {
    id: 'sub-agents',
    label: 'Sub-Agents',
    description: 'Configure delegated agents and collaboration behavior.',
    icon: 'lucide:users',
    component: AgentSubAgentsTab
  },
  {
    id: 'advanced',
    label: 'Advanced',
    description: 'Tune advanced execution, approval, and automation settings.',
    icon: 'lucide:sliders-horizontal',
    component: AgentAdvancedTab
  }
]

const health = computed(() => agent.value ? agentHealth.validate(agent.value) : null)
const missingTools = computed(() => health.value?.tools ?? [])
const missingMemoryFolders = computed(() => health.value?.memoryFolders ?? [])
const missingSubAgents = computed(() => health.value?.subAgents ?? [])

const tabs = computed<TabDef<AgentSectionId>[]>(() => {
  const warnings: Partial<Record<AgentSectionId, string>> = {
    tools: missingTools.value.length ? `Unavailable tools: ${missingTools.value.join(', ')}` : '',
    memory: missingMemoryFolders.value.length ? `Unavailable memory folders: ${missingMemoryFolders.value.join(', ')}` : '',
    'sub-agents': missingSubAgents.value.length ? `Unavailable sub-agents: ${missingSubAgents.value.join(', ')}` : '',
  }
  return sections.map(section => ({
    value: section.id,
    label: section.label,
    icon: section.icon,
    warning: warnings[section.id],
  }))
})


</script>

<template>
  <div
    v-if="agent"
    class="h-full overflow-y-auto"
  >
    <header class="page-header relative z-20 border-b border-theme-800/60 bg-theme-950/95 pt-4 backdrop-blur-sm sm:sticky sm:top-0 sm:pt-5">
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div class="flex items-start justify-between gap-3">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-ink-muted transition-colors hover:bg-theme-800 hover:text-theme-300"
            :aria-label="returnToChat ? 'Back to chat' : 'Back to agents'"
            @click="goBack"
          >
            <Icon
              icon="lucide:arrow-left"
              class="h-4 w-4"
            />
            <span>{{ returnToChat ? 'Chat' : 'Agents' }}</span>
          </button>

          <div class="flex items-center gap-2">
            <button
              type="button"
              data-testid="save-agent"
              :disabled="!canSave"
              class="inline-flex items-center gap-2 rounded-lg accent-action header-save-action bg-accent-500 px-3 py-2 text-sm font-semibold text-accent-on transition-colors enabled:hover:bg-accent-400 disabled:cursor-not-allowed"
              @click="save"
            >
              <Icon
                :icon="saving ? 'lucide:loader-2' : 'lucide:save'"
                class="h-4 w-4"
                :class="{ 'animate-spin': saving }"
              />
              {{ saving ? 'Saving…' : 'Save' }}
            </button>
            <button
              type="button"
              :disabled="saving"
              class="inline-flex shrink-0 items-center gap-2 rounded-lg bg-theme-800 px-3 py-2 text-sm font-semibold text-theme-200 transition-colors hover:bg-theme-700 disabled:opacity-40"
              @click="goToChat"
            >
              <Icon
                icon="lucide:message-circle"
                class="h-4 w-4"
              />
              <span>Go to chat</span>
            </button>
          </div>
        </div>

        <div class="mt-2 flex min-w-0 items-center gap-3">
          <div
            class="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg"
            :class="{ 'bg-linear-to-br from-accent-500/20 to-purple-500/20': headerIconUrl }"
          >
            <AgentAvatar
              :name="agent.name"
              :icon-url="headerIconUrl"
              :avatar="agent.avatar"
              animate="hover"
            />
          </div>
          <div class="min-w-0">
            <h1 class="break-words text-2xl font-bold leading-tight text-theme-100">
              {{ agent.name }}
            </h1>
            <p
              v-if="isCyno"
              class="mt-1 line-clamp-2 text-sm leading-relaxed text-ink-muted"
            >
              Your default assistant. New chats start with these settings.
            </p>
            <p
              v-else-if="agent.description"
              class="mt-1 line-clamp-2 text-sm leading-relaxed text-ink-muted"
            >
              {{ agent.description }}
            </p>
          </div>
        </div>

  

        <TabBar
          v-model="activeSectionId"
          :tabs="tabs"
          class="mt-4"
        />
      </div>
    </header>

    <main class="min-w-0">
      <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <section class="scroll-mt-4">
          <div class="mb-5 flex items-start gap-3">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-theme-900 text-ink-secondary ring-1 ring-theme-800">
              <Icon
                :icon="activeSection.icon"
                class="h-5 w-5"
              />
            </div>
            <div class="min-w-0">
              <h2 class="text-xl font-bold text-theme-100">
                {{ activeSection.label }}
              </h2>
              <p class="mt-1 text-sm leading-relaxed text-ink-muted">
                {{ activeSection.description }}
              </p>
            </div>
          </div>

          <p
            v-if="saveError"
            role="alert"
            class="mb-4 text-sm text-status-danger"
          >
            {{ saveError }}
          </p>
          <p
            v-else-if="isDirty && validationError"
            role="alert"
            class="mb-4 text-sm text-status-warning"
          >
            {{ validationError }}
          </p>
          <fieldset
            :disabled="saving"
            class="min-w-0"
          >
            <component
              :is="activeSection.component"
              :agent="agent"
              :cyno="isCyno"
              @update="updateField"
              @update-reasoning="updateReasoning"
            />
          </fieldset>
        </section>
      </div>
    </main>
    <ModalDialog
      :show="showUnsavedDialog"
      title="Discard unsaved changes?"
      icon="lucide:triangle-alert"
      icon-color="amber"
      @close="finishLeave(false)"
    >
      <p class="text-sm leading-relaxed text-ink-secondary">
        This agent has changes that have not been saved.
      </p>
      <template #actions>
        <button
          type="button"
          class="w-full rounded-xl bg-red-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-red-500"
          @click="discardAndLeave"
        >
          Discard
        </button>
        <button
          type="button"
          class="w-full rounded-xl bg-theme-800 px-4 py-3 text-sm font-medium text-theme-200 transition hover:bg-theme-700"
          @click="finishLeave(false)"
        >
          Continue editing
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
