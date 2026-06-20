<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { api } from '../../api/client'
import type { AgentDefinition, ChannelDefinition, ChannelType } from '../../api/types'
import AgentSelect from '../../components/shared/AgentSelect.vue'
import MultiSelect from '../../components/shared/MultiSelect.vue'
import type { MultiSelectOption } from '../../components/shared/MultiSelect.vue'
import ToggleSwitch from '../../components/shared/ToggleSwitch.vue'
import BaseCard from '../../components/shared/BaseCard.vue'

const route = useRoute()
const router = useRouter()

const channel = ref<ChannelDefinition | null>(null)
const allAgents = ref<AgentDefinition[]>([])
const loading = ref(true)
const saving = ref(false)
const testing = ref(false)
const saveMessage = ref('')
const testResult = ref<{ success: boolean; username?: string; error?: string } | null>(null)

const dlgName = ref('')
const dlgAgentId = ref('')
const dlgBotToken = ref('')
const dlgAppToken = ref('')
const dlgEnabled = ref(true)
const dlgAllowedAgentIds = ref<string[]>([])

const channelId = computed(() => route.params.id as string)
const agentOptions = computed<MultiSelectOption[]>(() =>
  allAgents.value.map(a => ({ value: a.id, label: a.name }))
)

const channelTypeOptions = [
  { value: 'telegram' as ChannelType, label: 'Telegram', icon: 'mdi:telegram', color: 'sky' },
  { value: 'discord' as ChannelType, label: 'Discord', icon: 'ic:baseline-discord', color: 'indigo' },
  { value: 'slack' as ChannelType, label: 'Slack', icon: 'mdi:slack', color: 'purple' }
]

const channelTypeMeta = computed(() => {
  const type = channel.value?.type
  return channelTypeOptions.find(opt => opt.value === type) || channelTypeOptions[0]
})

const selectedAgent = computed(() =>
  allAgents.value.find(a => a.id === dlgAgentId.value)
)

const stateMeta = computed(() => {
  if (!dlgEnabled.value) {
    return {
      label: 'Disabled',
      description: 'This channel is disabled and will not listen for messages.',
      icon: 'lucide:pause-circle',
      color: 'text-theme-500',
      bg: 'bg-theme-800',
      border: 'border-theme-700',
      spin: false,
    }
  }
  if (channel.value?.status?.connected) {
    return {
      label: 'Connected',
      description: 'This channel is online and listening for messages.',
      icon: 'lucide:radio',
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10',
      border: 'border-emerald-500/25',
      spin: false,
    }
  }
  if (channel.value?.status?.error) {
    return {
      label: 'Error',
      description: channel.value.status.error,
      icon: 'lucide:circle-alert',
      color: 'text-red-400',
      bg: 'bg-red-500/10',
      border: 'border-red-500/25',
      spin: false,
    }
  }
  return {
    label: 'Starting',
    description: 'This channel is enabled and waiting for a connection.',
    icon: 'lucide:loader-2',
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/25',
    spin: true,
  }
})

const canSave = computed(() => {
  if (!dlgAgentId.value || !dlgName.value.trim()) return false
  if (channel.value?.type === 'slack') {
    return !!dlgBotToken.value.trim() && !!dlgAppToken.value.trim()
  }
  return !!dlgBotToken.value.trim()
})

function populateFields(ch: ChannelDefinition) {
  dlgName.value = ch.name || ''
  dlgAgentId.value = ch.agentId
  dlgBotToken.value = (ch.config.botToken as string) || ''
  dlgAppToken.value = (ch.config.appToken as string) || ''
  dlgAllowedAgentIds.value = (ch.config.allowedAgentIds as string[]) || []
  dlgEnabled.value = ch.enabled
  testResult.value = null
}

function buildConfig(): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  if (!channel.value) return config

  if (channel.value.type === 'telegram' || channel.value.type === 'discord') {
    config.botToken = dlgBotToken.value.trim()
  }
  if (channel.value.type === 'slack') {
    config.botToken = dlgBotToken.value.trim()
    config.appToken = dlgAppToken.value.trim()
  }
  if (dlgAllowedAgentIds.value.length > 0) {
    config.allowedAgentIds = dlgAllowedAgentIds.value
  }
  return config
}

async function loadChannel() {
  loading.value = true
  try {
    const [found, agents] = await Promise.all([
      api.channels.get(channelId.value),
      api.agents.list(),
    ])
    allAgents.value = agents
    channel.value = found
    populateFields(found)
  } catch {
    router.push('/settings/channels')
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!channel.value || !canSave.value) return
  saving.value = true
  try {
    const updated = await api.channels.update(channelId.value, {
      name: dlgName.value.trim(),
      agentId: dlgAgentId.value,
      config: buildConfig(),
      enabled: dlgEnabled.value,
    })
    channel.value = updated
    populateFields(updated)
    saveMessage.value = 'Saved'
    setTimeout(() => saveMessage.value = '', 2000)
  } finally {
    saving.value = false
  }
}

async function testConnection() {
  if (!channel.value) return
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await api.channels.testConfig({
      type: channel.value.type,
      agentId: dlgAgentId.value || channel.value.agentId,
      config: buildConfig(),
    })
  } catch (err) {
    testResult.value = { success: false, error: (err as Error).message }
  } finally {
    testing.value = false
  }
}

onMounted(loadChannel)
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-3xl mx-auto py-8 px-6">
      <div
        v-if="loading"
        class="text-center py-12 text-theme-400"
      >
        Loading...
      </div>

      <template v-else-if="channel">
        <!-- Back + Title -->
        <div class="flex items-center justify-between mb-6">
          <div class="flex items-center gap-3">
            <button
              class="p-1.5 text-theme-500 hover:text-theme-300 transition-colors"
              @click="router.push('/settings/channels')"
            >
              <Icon
                icon="lucide:arrow-left"
                class="w-5 h-5"
              />
            </button>
            <div
              class="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              :class="channel.type === 'telegram' ? 'bg-sky-500/20' : channel.type === 'discord' ? 'bg-indigo-500/20' : 'bg-purple-500/20'"
            >
              <Icon
                :icon="channelTypeMeta.icon"
                class="w-5 h-5"
                :class="channel.type === 'telegram' ? 'text-sky-400' : channel.type === 'discord' ? 'text-indigo-400' : 'text-purple-400'"
              />
            </div>
            <div>
              <h1 class="text-2xl font-bold text-theme-100">
                {{ channel.name || 'Unnamed channel' }}
              </h1>
              <p class="text-sm text-theme-400 mt-0.5">
                Agent: {{ selectedAgent?.name || channel.agentId }}
              </p>
            </div>
          </div>

          <div class="flex items-center gap-3">
            <span
              v-if="saveMessage"
              class="text-sm text-green-400"
            >{{ saveMessage }}</span>
            <button
              class="px-4 py-2 bg-accent-600 hover:bg-accent-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              :disabled="saving || !canSave"
              @click="save"
            >
              {{ saving ? 'Saving...' : 'Save Changes' }}
            </button>
          </div>
        </div>

        <div class="space-y-4">
          <!-- Identity: Name + Agent -->
          <BaseCard class="p-5 space-y-4">
            <div class="flex items-center gap-2">
              <Icon
                icon="lucide:tag"
                class="w-4 h-4 text-sky-400"
              />
              <h3 class="text-sm font-medium text-theme-200">
                Identity
              </h3>
            </div>
            <div>
              <label class="block text-xs text-theme-400 mb-1.5">Name</label>
              <input
                v-model="dlgName"
                type="text"
                placeholder="e.g. Support Bot"
                class="w-full bg-theme-900 border border-theme-700 text-theme-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500"
              >
            </div>
            <div>
              <label class="block text-xs text-theme-400 mb-1.5">Agent</label>
              <AgentSelect
                v-model="dlgAgentId"
                :agents="allAgents"
                placeholder="Select an agent..."
              />
            </div>
          </BaseCard>

          <!-- Platform (read-only) -->
          <BaseCard class="p-5">
            <div class="flex items-center gap-2 mb-1">
              <Icon
                icon="lucide:plug"
                class="w-4 h-4 text-violet-400"
              />
              <h3 class="text-sm font-medium text-theme-200">
                Platform
              </h3>
            </div>
            <p class="text-xs text-theme-500 leading-relaxed mb-4">
              The messaging platform for this channel. Cannot be changed after creation.
            </p>
            <div class="flex gap-2">
              <button
                v-for="opt in channelTypeOptions"
                :key="opt.value"
                type="button"
                disabled
                class="flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm transition-colors"
                :class="channel.type === opt.value
                  ? 'border-accent-500 bg-accent-500/10 text-accent-400'
                  : 'border-theme-700 bg-theme-900 text-theme-500 opacity-40'"
              >
                <Icon
                  :icon="opt.icon"
                  class="w-5 h-5"
                />
                {{ opt.label }}
              </button>
            </div>
          </BaseCard>

          <!-- Credentials -->
          <BaseCard class="p-5 space-y-4">
            <div class="flex items-center gap-2">
              <Icon
                icon="lucide:key-round"
                class="w-4 h-4 text-amber-400"
              />
              <h3 class="text-sm font-medium text-theme-200">
                Credentials
              </h3>
            </div>

            <template v-if="channel.type === 'telegram'">
              <div>
                <label class="block text-xs text-theme-400 mb-1.5">Bot Token</label>
                <input
                  v-model="dlgBotToken"
                  type="password"
                  placeholder="123456:ABC-DEF..."
                  class="w-full bg-theme-900 border border-theme-700 text-theme-100 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                <p class="text-[11px] text-theme-600 mt-1.5">
                  Get your bot token from <span class="text-theme-400">@BotFather</span> on Telegram.
                </p>
              </div>
            </template>

            <template v-else-if="channel.type === 'discord'">
              <div>
                <label class="block text-xs text-theme-400 mb-1.5">Bot Token</label>
                <input
                  v-model="dlgBotToken"
                  type="password"
                  placeholder="MTIz...abc"
                  class="w-full bg-theme-900 border border-theme-700 text-theme-100 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                <p class="text-[11px] text-theme-600 mt-1.5">
                  Ensure the Message Content intent is enabled in the Discord Developer Portal.
                </p>
              </div>
            </template>

            <template v-else-if="channel.type === 'slack'">
              <div>
                <label class="block text-xs text-theme-400 mb-1.5">Bot Token</label>
                <input
                  v-model="dlgBotToken"
                  type="password"
                  placeholder="xoxb-..."
                  class="w-full bg-theme-900 border border-theme-700 text-theme-100 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
              </div>
              <div>
                <label class="block text-xs text-theme-400 mb-1.5">App Token</label>
                <input
                  v-model="dlgAppToken"
                  type="password"
                  placeholder="xapp-..."
                  class="w-full bg-theme-900 border border-theme-700 text-theme-100 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent-500"
                >
                <p class="text-[11px] text-theme-600 mt-1.5">
                  Enable Socket Mode and generate an app-level token with <span class="text-theme-400">connections:write</span> scope.
                </p>
              </div>
            </template>
          </BaseCard>

          <!-- Allowed Agents -->
          <BaseCard class="p-5">
            <div class="flex items-center gap-2 mb-1">
              <Icon
                icon="lucide:users"
                class="w-4 h-4 text-emerald-400"
              />
              <h3 class="text-sm font-medium text-theme-200">
                Allowed Agents
              </h3>
            </div>
            <p class="text-xs text-theme-500 leading-relaxed mb-4">
              Restrict which agents users can switch to via commands. Leave empty to allow all agents.
            </p>
            <MultiSelect
              v-model="dlgAllowedAgentIds"
              :options="agentOptions"
              placeholder="All agents"
            />
          </BaseCard>

          <!-- Status & Connection -->
          <BaseCard class="p-5">
            <div class="flex items-center gap-2 mb-1">
              <Icon
                icon="lucide:radio"
                class="w-4 h-4 text-emerald-400"
              />
              <h3 class="text-sm font-medium text-theme-200">
                Status
              </h3>
            </div>
            <p class="text-xs text-theme-500 leading-relaxed mb-4">
              Enable or disable this channel, and test the connection with the current credentials.
            </p>

            <div class="space-y-3">
              <div class="flex items-start justify-between gap-4">
                <div class="min-w-0">
                  <p class="text-sm font-medium text-theme-200">
                    Enabled / State
                  </p>
                  <p class="text-xs text-theme-500">
                    Start listening for messages on this channel.
                  </p>
                </div>
                <ToggleSwitch
                  v-model="dlgEnabled"
                  size="md"
                  color="emerald"
                  class="mt-0.5 shrink-0"
                />
              </div>
              <div
                class="flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2"
                :class="[stateMeta.border, stateMeta.bg]"
              >
                <Icon
                  :icon="stateMeta.icon"
                  class="w-4 h-4 shrink-0"
                  :class="[stateMeta.color, { 'animate-spin': stateMeta.spin }]"
                />
                <div class="min-w-0">
                  <p
                    class="text-sm font-medium leading-tight"
                    :class="stateMeta.color"
                  >
                    {{ stateMeta.label }}
                  </p>
                  <p class="truncate text-[11px] text-theme-500 leading-tight">
                    {{ stateMeta.description }}
                  </p>
                </div>
              </div>
            </div>

            <div class="mt-4 pt-4 border-t border-theme-700 flex items-center justify-between gap-4">
              <p class="text-xs text-theme-500">
                Verify that the bot token(s) are valid and the bot can connect.
              </p>
              <button
                :disabled="testing || !canSave"
                class="flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors disabled:opacity-40 shrink-0"
                :class="testResult?.success
                  ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400'
                  : testResult && !testResult.success
                    ? 'border-red-500/30 bg-red-500/5 text-red-400'
                    : 'border-theme-700 bg-theme-900 text-theme-400 hover:text-theme-200 hover:border-theme-600'"
                @click="testConnection"
              >
                <Icon
                  :icon="testing ? 'lucide:loader-2' : testResult?.success ? 'lucide:check-circle' : 'lucide:zap'"
                  class="w-4 h-4"
                  :class="{ 'animate-spin': testing }"
                />
                <template v-if="testing">
                  Testing...
                </template>
                <template v-else-if="testResult?.success">
                  Connected as @{{ testResult.username }}
                </template>
                <template v-else-if="testResult && !testResult.success">
                  {{ testResult.error }}
                </template>
                <template v-else>
                  Test Connection
                </template>
              </button>
            </div>

            <div
              v-if="channel.status?.error"
              class="mt-3 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-300"
            >
              {{ channel.status.error }}
            </div>
          </BaseCard>
        </div>
      </template>
    </div>
  </div>
</template>
