<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { useAgentDefinitionsStore } from '../../stores/agent-definitions.store'
import { useProviderStore } from '../../stores/provider.store'
import { agentInternalName } from '../../utils/agent-memory'
import BaseCard from '../shared/BaseCard.vue'
import IconUpload from '../shared/IconUpload.vue'
import ProviderModelSelect from '../shared/ProviderModelSelect.vue'
import PromptSmartTagPicker from '../shared/PromptSmartTagPicker.vue'
import { NEW_AGENT_BEHAVIOR } from '../../utils/agent-defaults'

interface DraftState {
  hasDraft: boolean
  valid: boolean
}

const emit = defineEmits<{
  draftChange: [state: DraftState]
}>()

const agentDefs = useAgentDefinitionsStore()
const providerStore = useProviderStore()

const name = ref('')
const iconUrl = ref<string | null>(null)
const description = ref('')
const providerId = ref('')
const model = ref('')
const systemPrompt = ref('')
const systemPromptRef = ref<HTMLTextAreaElement | null>(null)
const creating = ref(false)
const error = ref('')

const internalName = computed(() => agentInternalName(name.value) || 'agent')
const hasDraft = computed(() => Boolean(
  name.value.trim()
  || iconUrl.value
  || description.value.trim()
  || systemPrompt.value.trim()
))
const valid = computed(() => !hasDraft.value || Boolean(name.value.trim()))

function insertSystemPromptTag(tag: string): void {
  const input = systemPromptRef.value
  if (!input) {
    systemPrompt.value += tag
    return
  }
  const start = input.selectionStart ?? systemPrompt.value.length
  const end = input.selectionEnd ?? systemPrompt.value.length
  systemPrompt.value = `${systemPrompt.value.slice(0, start)}${tag}${systemPrompt.value.slice(end)}`
  requestAnimationFrame(() => {
    input.focus()
    input.setSelectionRange(start + tag.length, start + tag.length)
  })
}

watch([hasDraft, valid], () => {
  emit('draftChange', { hasDraft: hasDraft.value, valid: valid.value })
}, { immediate: true })

onMounted(async () => {
  if (!providerStore.providers.length) {
    await providerStore.loadProviders()
  }
  const provider = providerStore.lastUsedProvider || providerStore.providers[0]
  providerId.value = provider?.id || ''
  model.value = provider?.defaultModel || ''
})

async function createAgent(): Promise<boolean> {
  if (!hasDraft.value) return true
  if (!valid.value || creating.value) return false

  creating.value = true
  error.value = ''

  try {
    await agentDefs.create({
      name: name.value.trim(),
      internalName: internalName.value,
      description: description.value.trim(),
      category: '',
      favorite: false,
      iconUrl: iconUrl.value,
      providerId: providerId.value,
      model: model.value,
      systemPrompt: systemPrompt.value.trim(),
      tools: [],
      ...NEW_AGENT_BEHAVIOR,
      // Omitted on purpose: the server then assigns the default memory folders,
      // while an empty list would switch retrieval off for this agent.
    })

    return true
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not create the agent'
    return false
  } finally {
    creating.value = false
  }
}

defineExpose({ createAgent })
</script>

<template>
  <div class="mx-auto w-full max-w-2xl px-4 py-6">
    <div class="mb-6">
      <div class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-accent-fg">
        <Icon
          icon="lucide:sparkles"
          class="h-3.5 w-3.5"
        />
        One last thing
      </div>
      <h2 class="text-xl font-bold text-theme-100">
        Create your First Agent <span class="font-normal text-ink-muted">(optional)</span>
      </h2>
      <p class="mt-1 max-w-2xl text-sm leading-relaxed text-ink-muted">
        Give your first agent a role and a few instructions. You can fine-tune its tools,
        memory, and behavior later.
      </p>
    </div>

    <BaseCard class="p-5">
      <div class="border-b border-theme-700/70 pb-5">
        <label
          for="onboarding-agent-name"
          class="mb-1.5 block text-sm font-medium text-theme-300"
        >
          Name <span class="text-status-danger">*</span>
        </label>
        <input
          id="onboarding-agent-name"
          v-model="name"
          type="text"
          autocomplete="off"
          placeholder="e.g. Research Assistant"
          class="w-full rounded-lg border border-theme-700 bg-theme-900 px-3 py-2.5 text-sm text-theme-200 placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent-500"
        >
        <p class="mt-1.5 text-[11px] text-ink-faint">
          Internal name: <span class="font-mono text-ink-muted">{{ internalName }}</span>
        </p>
      </div>

      <div class="border-b border-theme-700/70 py-5">
        <IconUpload
          :icon-url="iconUrl"
          fallback-icon="lucide:bot"
          @update="iconUrl = $event"
        >
          <template #description>
            Add an optional image so this agent is easy to spot.
          </template>
        </IconUpload>
      </div>

      <div class="border-b border-theme-700/70 py-5">
        <label
          for="onboarding-agent-description"
          class="mb-1.5 block text-sm font-medium text-theme-300"
        >Description</label>
        <textarea
          id="onboarding-agent-description"
          v-model="description"
          rows="3"
          placeholder="What is this agent best at?"
          class="w-full resize-none rounded-lg border border-theme-700 bg-theme-900 px-3 py-2.5 text-sm text-theme-200 placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent-500"
        />
      </div>

      <div class="border-b border-theme-700/70 py-5">
        <label class="mb-1.5 block text-sm font-medium text-theme-300">Provider / Model</label>
        <ProviderModelSelect
          :provider-id="providerId"
          :model-value="model"
          :providers="providerStore.providers"
          placeholder="Use provider default"
          @change="selection => { providerId = selection.providerId; model = selection.model }"
        />
      </div>

      <div class="border-b border-theme-700/70 py-5">
        <div class="mb-1.5 flex items-center justify-between gap-3">
          <label
            for="onboarding-agent-system-prompt"
            class="block text-sm font-medium text-theme-300"
          >System prompt</label>
          <PromptSmartTagPicker @insert="insertSystemPromptTag" />
        </div>
        <textarea
          id="onboarding-agent-system-prompt"
          ref="systemPromptRef"
          v-model="systemPrompt"
          rows="7"
          placeholder="Describe the role, tone, and boundaries for this agent…"
          class="w-full resize-y rounded-lg border border-theme-700 bg-theme-900 px-3 py-2.5 font-mono text-sm leading-relaxed text-theme-200 placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent-500"
        />
        <p class="mt-1.5 text-[11px] text-ink-faint">
          These instructions are added to Cynosure’s built-in agent behavior.
        </p>
      </div>
    </BaseCard>

    <div
      v-if="error"
      role="alert"
      class="mt-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
    >
      <Icon
        icon="lucide:circle-alert"
        class="mt-0.5 h-4 w-4 shrink-0"
      />
      <span>{{ error }}</span>
    </div>
  </div>
</template>
