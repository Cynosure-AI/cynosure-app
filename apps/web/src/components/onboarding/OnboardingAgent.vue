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
import OnboardingStepHeader from './OnboardingStepHeader.vue'

interface DraftState {
  hasDraft: boolean
  valid: boolean
}

const emit = defineEmits<{
  draftChange: [state: DraftState]
  created: [name: string]
}>()

interface AgentTemplate {
  icon: string
  name: string
  description: string
  systemPrompt: string
}

const templates: AgentTemplate[] = [
  {
    icon: 'lucide:search',
    name: 'Research Assistant',
    description: 'Finds, compares, and summarises reliable sources.',
    systemPrompt: 'You are a careful research assistant. Look for reliable sources, compare them, and say where each fact comes from. Point out where sources disagree or the evidence is thin. Finish with a short summary and suggested next steps.',
  },
  {
    icon: 'lucide:pen-line',
    name: 'Writing Partner',
    description: 'Drafts, edits, and polishes your writing.',
    systemPrompt: 'You are a thoughtful writing partner. Help draft, restructure, and polish text while keeping the author\'s voice. Ask about audience and tone when they are unclear, and briefly explain significant edits.',
  },
  {
    icon: 'lucide:code-xml',
    name: 'Coding Helper',
    description: 'Explains, writes, and reviews code.',
    systemPrompt: 'You are a pragmatic senior software engineer. Write clear, working code that matches the existing style, explain trade-offs briefly, and call out bugs, edge cases, and security issues you notice.',
  },
  {
    icon: 'lucide:calendar-check',
    name: 'Daily Planner',
    description: 'Turns goals into clear, realistic plans.',
    systemPrompt: 'You are an organised personal planner. Break goals into concrete, realistic steps, help prioritise what matters most, and keep plans short and actionable.',
  },
]

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
const activeTemplate = computed(() => templates.find(t => t.name === name.value && t.systemPrompt === systemPrompt.value))

function applyTemplate(template: AgentTemplate): void {
  if (activeTemplate.value === template) {
    name.value = ''
    description.value = ''
    systemPrompt.value = ''
    return
  }
  name.value = template.name
  description.value = template.description
  systemPrompt.value = template.systemPrompt
}

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
  const provider = providerStore.lastUsedProvider || providerStore.enabledProviders[0]
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

    emit('created', name.value.trim())
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
  <div class="mx-auto w-full max-w-2xl px-4 py-8">
    <OnboardingStepHeader
      icon="lucide:bot"
      title="Create your First Agent"
      optional
    >
      Pick a template to start in one click, or describe your own. You can fine-tune its tools,
      memory, and behavior later.
    </OnboardingStepHeader>

    <div class="mb-2 text-xs font-medium uppercase tracking-wider text-ink-muted">
      Start from a template
    </div>
    <div class="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <button
        v-for="template in templates"
        :key="template.name"
        type="button"
        class="agent-template"
        :class="{ 'agent-template--active': activeTemplate === template }"
        :aria-pressed="activeTemplate === template"
        @click="applyTemplate(template)"
      >
        <span class="agent-template-icon">
          <Icon
            :icon="activeTemplate === template ? 'lucide:check' : template.icon"
            class="h-4 w-4"
          />
        </span>
        <span class="text-sm font-medium text-theme-100">{{ template.name }}</span>
        <span class="text-[11px] leading-4 text-ink-faint">{{ template.description }}</span>
      </button>
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
        <label
          for="onboarding-agent-description"
          class="mb-1.5 block text-sm font-medium text-theme-300"
        >Description</label>
        <textarea
          id="onboarding-agent-description"
          v-model="description"
          rows="2"
          placeholder="What is this agent best at?"
          class="w-full resize-none rounded-lg border border-theme-700 bg-theme-900 px-3 py-2.5 text-sm text-theme-200 placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent-500"
        />
      </div>

      <div class="border-b border-theme-700/70 py-5">
        <div class="mb-1.5 flex items-center justify-between gap-3">
          <label
            for="onboarding-agent-system-prompt"
            class="block text-sm font-medium text-theme-300"
          >Instructions</label>
          <PromptSmartTagPicker @insert="insertSystemPromptTag" />
        </div>
        <textarea
          id="onboarding-agent-system-prompt"
          ref="systemPromptRef"
          v-model="systemPrompt"
          rows="5"
          placeholder="Describe the role, tone, and boundaries for this agent…"
          class="w-full resize-y rounded-lg border border-theme-700 bg-theme-900 px-3 py-2.5 text-sm leading-relaxed text-theme-200 placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent-500"
        />
        <p class="mt-1.5 text-[11px] text-ink-faint">
          These instructions are added to Cynosure’s built-in agent behavior.
        </p>
      </div>

      <details class="group pt-4">
        <summary class="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-ink-secondary transition-colors hover:text-theme-200">
          <Icon
            icon="lucide:chevron-right"
            class="h-4 w-4 transition-transform group-open:rotate-90"
          />
          More options
          <span class="font-normal text-ink-faint">· icon and model</span>
        </summary>

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

        <div class="pt-5">
          <label class="mb-1.5 block text-sm font-medium text-theme-300">Provider / Model</label>
          <ProviderModelSelect
            :provider-id="providerId"
            :model-value="model"
            :providers="providerStore.providers"
            placeholder="Use provider default"
            @change="selection => { providerId = selection.providerId; model = selection.model }"
          />
        </div>
      </details>
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

<style scoped>
.agent-template {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: .375rem;
  padding: .875rem;
  text-align: left;
  border: 1px solid color-mix(in srgb, var(--color-theme-600) 40%, transparent);
  border-radius: .875rem;
  background: color-mix(in srgb, var(--color-theme-800) 45%, transparent);
  transition: border-color 150ms ease, background-color 150ms ease, box-shadow 150ms ease, transform 150ms ease;
}

.agent-template:hover {
  border-color: color-mix(in srgb, var(--color-theme-500) 60%, transparent);
  background: color-mix(in srgb, var(--color-theme-800) 75%, transparent);
}

.agent-template:active {
  transform: scale(.98);
}

.agent-template-icon {
  display: grid;
  width: 2rem;
  height: 2rem;
  place-items: center;
  margin-bottom: .25rem;
  border-radius: .625rem;
  background: color-mix(in srgb, var(--color-accent-500) 12%, transparent);
  color: var(--color-accent-fg);
}

.agent-template--active,
.agent-template--active:hover {
  border-color: var(--color-accent-500);
  background: color-mix(in srgb, var(--color-accent-500) 10%, var(--color-theme-800));
  box-shadow: 0 0 0 1px var(--color-accent-500);
}

.agent-template--active .agent-template-icon {
  background: var(--color-accent-500);
  color: var(--color-accent-on);
}
</style>
