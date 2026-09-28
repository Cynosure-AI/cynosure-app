<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../../api/client'
import type { AgentDefinition, ChannelDefinition, ChannelType } from '../../api/types'
import { Icon } from '@iconify/vue'
import ModalDialog from '../../components/shared/ModalDialog.vue'
import ToggleSwitch from '../../components/shared/ToggleSwitch.vue'
import BaseCard from '../../components/shared/BaseCard.vue'
import AgentSelect from '../../components/shared/AgentSelect.vue'
import MultiSelect from '../../components/shared/MultiSelect.vue'
import SettingsSubheading from '../../components/settings/SettingsSubheading.vue'
import SettingsPersistenceStatus, { type SettingsPersistenceState } from '../../components/settings/SettingsPersistenceStatus.vue'
import type { MultiSelectOption } from '../../components/shared/MultiSelect.vue'
import ChannelDetailView from './ChannelDetailView.vue'

const route = useRoute()
const router = useRouter()
const props = withDefaults(defineProps<{
  embedded?: boolean
  visibleSections?: string[]
}>(), {
  embedded: false,
  visibleSections: () => []
})
const emit = defineEmits<{ 'dirty-change': [dirty: boolean] }>()
const channels = ref<ChannelDefinition[]>([])
const allAgents = ref<AgentDefinition[]>([])
const loading = ref(true)
const selectedChannelId = ref<string | null>(null)
let pollTimer: ReturnType<typeof setInterval> | undefined

// Add dialog state
const showAddDialog = ref(false)
const dlgName = ref('')
const dlgType = ref<ChannelType>('telegram')
const dlgAgentId = ref('')
const dlgBotToken = ref('')
const dlgAppToken = ref('')
const dlgEnabled = ref(true)
const dlgSaving = ref(false)
const dlgTesting = ref(false)
const dlgTestResult = ref<{ success: boolean; username?: string; error?: string } | null>(null)
const dlgAllowedAgentIds = ref<string[]>([])
const dlgAllowedTelegramUserIds = ref('')
const addDraftBaseline = ref('')
const addSaveStatus = ref<SettingsPersistenceState>('idle')
const showAddDiscardConfirm = ref(false)
const detailDirty = ref(false)
const togglingIds = ref<Set<string>>(new Set())
const toggleError = ref('')
const channelToggleStatus = ref<SettingsPersistenceState>('idle')

const serializedAddDraft = computed(() => JSON.stringify({
  name: dlgName.value,
  type: dlgType.value,
  agentId: dlgAgentId.value,
  botToken: dlgBotToken.value,
  appToken: dlgAppToken.value,
  enabled: dlgEnabled.value,
  allowedAgentIds: dlgAllowedAgentIds.value,
  allowedTelegramUserIds: dlgAllowedTelegramUserIds.value,
}))
const addDraftDirty = computed(() => showAddDialog.value && serializedAddDraft.value !== addDraftBaseline.value)
const hasManualChanges = computed(() => addDraftDirty.value || detailDirty.value)

watch(hasManualChanges, (dirty) => emit('dirty-change', dirty), { immediate: true })

const agentOptions = computed<MultiSelectOption[]>(() =>
  allAgents.value.map(a => ({ value: a.id, label: a.name }))
)

function parseTelegramUserIds(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map(id => id.trim()).filter(id => /^\d+$/.test(id) && id !== '0'))]
}

const canSaveChannel = computed(() => {
  if (!dlgAgentId.value || !dlgBotToken.value.trim() || dlgSaving.value) return false
  if (dlgType.value === 'slack' && !dlgAppToken.value.trim()) return false
  if (dlgType.value === 'telegram' && parseTelegramUserIds(dlgAllowedTelegramUserIds.value).length === 0) return false
  return true
})

// Delete confirm
const showDeleteConfirm = ref(false)
const pendingDeleteId = ref<string | null>(null)
const pendingDeleteName = ref('')

const channelTypeOptions = [
  { value: 'telegram' as ChannelType, label: 'Telegram', icon: 'mdi:telegram' },
  { value: 'discord' as ChannelType, label: 'Discord', icon: 'ic:baseline-discord' },
  { value: 'slack' as ChannelType, label: 'Slack', icon: 'mdi:slack' }
]

function agentNameById(id: string): string {
  return allAgents.value.find(a => a.id === id)?.name || id
}

function agentIconById(id: string): string | null {
  return allAgents.value.find(a => a.id === id)?.iconUrl || null
}

function showSection(id: string): boolean {
  return props.visibleSections.length === 0 || props.visibleSections.includes(id)
}

function openChannelEditor(channelId: string) {
  selectedChannelId.value = channelId
}

async function closeChannelEditor() {
  selectedChannelId.value = null
  detailDirty.value = false
  if (typeof route.query.channel === 'string') {
    await router.replace({
      query: {
        ...route.query,
        channel: undefined,
      },
    })
  }
  await loadChannels()
}

function resetDialog() {
  dlgName.value = ''
  dlgType.value = 'telegram'
  dlgAgentId.value = ''
  dlgBotToken.value = ''
  dlgAppToken.value = ''
  dlgEnabled.value = true
  dlgTestResult.value = null
  dlgAllowedAgentIds.value = []
  dlgAllowedTelegramUserIds.value = ''
}

async function openAddDialog() {
  allAgents.value = await api.agents.list()
  resetDialog()
  addDraftBaseline.value = serializedAddDraft.value
  addSaveStatus.value = 'idle'
  showAddDialog.value = true
}

function closeAddDialog(): void {
  if (addDraftDirty.value) {
    showAddDiscardConfirm.value = true
    return
  }
  showAddDialog.value = false
}

function discardAddDraft(): void {
  showAddDiscardConfirm.value = false
  showAddDialog.value = false
}

function buildConfig(): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  if (dlgType.value === 'telegram' || dlgType.value === 'discord') {
    config.botToken = dlgBotToken.value.trim()
  }
  if (dlgType.value === 'telegram') {
    config.allowedUserIds = parseTelegramUserIds(dlgAllowedTelegramUserIds.value)
  }
  if (dlgType.value === 'slack') {
    config.botToken = dlgBotToken.value.trim()
    config.appToken = dlgAppToken.value.trim()
  }
  if (dlgAllowedAgentIds.value.length > 0) {
    config.allowedAgentIds = dlgAllowedAgentIds.value
  }
  return config
}

async function testConnection() {
  dlgTesting.value = true
  dlgTestResult.value = null
  try {
    dlgTestResult.value = await api.channels.testConfig({
      type: dlgType.value,
      agentId: dlgAgentId.value || 'test',
      config: buildConfig()
    })
  } catch (err) {
    dlgTestResult.value = { success: false, error: (err as Error).message }
  } finally {
    dlgTesting.value = false
  }
}

async function saveChannel() {
  dlgSaving.value = true
  addSaveStatus.value = 'saving'
  try {
    if (!dlgAgentId.value) return
    await api.channels.create({
      name: dlgName.value.trim() || `${dlgType.value} channel`,
      type: dlgType.value,
      agentId: dlgAgentId.value,
      config: buildConfig(),
      enabled: dlgEnabled.value
    })
    showAddDialog.value = false
    addDraftBaseline.value = serializedAddDraft.value
    await loadChannels()
    addSaveStatus.value = 'saved'
  } catch {
    addSaveStatus.value = 'error'
  } finally {
    dlgSaving.value = false
  }
}

async function toggleChannel(id: string) {
  if (togglingIds.value.has(id)) return
  toggleError.value = ''
  channelToggleStatus.value = 'saving'
  togglingIds.value = new Set(togglingIds.value).add(id)
  try {
    await api.channels.toggle(id)
    await loadChannels()
    channelToggleStatus.value = 'saved'
  } catch {
    toggleError.value = 'Could not update the channel. Its previous state was restored.'
    channelToggleStatus.value = 'error'
  } finally {
    const next = new Set(togglingIds.value)
    next.delete(id)
    togglingIds.value = next
    if (next.size > 0 && channelToggleStatus.value !== 'error') channelToggleStatus.value = 'saving'
  }
}

function confirmDelete(ch: ChannelDefinition) {
  pendingDeleteId.value = ch.id
  pendingDeleteName.value = ch.name
  showDeleteConfirm.value = true
}

async function deleteConfirmed() {
  if (!pendingDeleteId.value) return
  await api.channels.remove(pendingDeleteId.value)
  showDeleteConfirm.value = false
  pendingDeleteId.value = null
  await loadChannels()
}

async function loadChannels() {
  try {
    channels.value = await api.channels.list()
  } catch {
    // silently ignore
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadChannels()
  pollTimer = setInterval(loadChannels, 5_000)
})

watch(() => route.query.channel, (channelId) => {
  if (typeof channelId === 'string' && channelId) {
    selectedChannelId.value = channelId
  }
}, { immediate: true })

onUnmounted(() => {
  clearInterval(pollTimer)
})
</script>

<template>
  <div :class="props.embedded ? '' : 'h-full overflow-y-auto'">
    <ChannelDetailView
      v-if="selectedChannelId"
      :channel-id="selectedChannelId"
      @close="closeChannelEditor"
      @saved="loadChannels"
      @dirty-change="detailDirty = $event"
    />

    <div
      v-else
      :class="props.embedded ? 'max-w-none' : 'mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8'"
    >
      <div
        v-if="!props.embedded"
        class="flex items-center justify-between mb-6"
      >
        <div>
          <h1 class="text-2xl font-bold text-theme-100">
            Channels
          </h1>
          <p class="text-sm text-theme-500 mt-1">
            Connect messaging platforms to interact with agents
          </p>
        </div>
        <button
          class="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-600 hover:bg-accent-500 text-sm font-medium text-accent-on transition-colors"
          @click="openAddDialog"
        >
          <Icon
            icon="lucide:plus"
            class="w-4 h-4"
          />
          Add Channel
        </button>
      </div>
      <div
        v-else
        class="flex justify-end mb-4"
      >
        <button
          class="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-600 hover:bg-accent-500 text-sm font-medium text-accent-on transition-colors"
          @click="openAddDialog"
        >
          <Icon
            icon="lucide:plus"
            class="w-4 h-4"
          />
          Add Channel
        </button>
      </div>

      <SettingsSubheading
        v-if="props.embedded && showSection('channel-management')"
        label="Channel Management"
      />
      <!-- Loading -->
      <BaseCard
        v-if="loading"
        class="p-12 text-center"
      >
        <Icon
          icon="lucide:loader-2"
          class="w-8 h-8 text-theme-500 animate-spin mx-auto mb-3"
        />
        <p class="text-sm text-theme-500">
          Loading channels…
        </p>
      </BaseCard>

      <!-- Empty state -->
      <BaseCard
        v-else-if="channels.length === 0"
        class="p-12 text-center"
      >
        <div class="w-16 h-16 rounded-2xl bg-purple-500/10 flex items-center justify-center mx-auto mb-4">
          <Icon
            icon="lucide:radio"
            class="w-8 h-8 text-purple-400"
          />
        </div>
        <h3 class="text-lg font-medium text-theme-200 mb-2">
          No channels configured
        </h3>
        <p class="text-sm text-theme-500 max-w-md mx-auto mb-4">
          Connect a messaging platform like Telegram so users can interact with your agents via chat.
        </p>
        <button
          class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-600 hover:bg-accent-500 text-sm font-medium text-accent-on transition-colors"
          @click="openAddDialog"
        >
          <Icon
            icon="lucide:plus"
            class="w-4 h-4"
          />
          Add Channel
        </button>
      </BaseCard>

      <!-- Channel list -->
      <div
        v-else
        class="space-y-2"
      >
        <div
          v-for="ch in channels"
          :key="ch.id"
          data-testid="channel-row"
          class="flex items-center gap-4 px-5 py-4 rounded-xl border bg-theme-800/60 group cursor-pointer hover:border-theme-600 transition-colors"
          :class="ch.enabled ? 'border-theme-700' : 'border-theme-700/50 opacity-60'"
          @click="openChannelEditor(ch.id)"
        >
          <!-- Channel type icon -->
          <div class="shrink-0">
            <div
              class="w-10 h-10 rounded-xl flex items-center justify-center"
              :class="ch.type === 'telegram' ? 'bg-sky-500/10' : ch.type === 'discord' ? 'bg-indigo-500/10' : ch.type === 'slack' ? 'bg-purple-500/10' : 'bg-theme-800'"
            >
              <Icon
                :icon="ch.type === 'telegram' ? 'mdi:telegram' : ch.type === 'discord' ? 'ic:baseline-discord' : ch.type === 'slack' ? 'mdi:slack' : 'lucide:radio'"
                class="w-5 h-5"
                :class="ch.type === 'telegram' ? 'text-status-info' : ch.type === 'discord' ? 'text-status-indigo' : ch.type === 'slack' ? 'text-purple-400' : 'text-theme-500'"
              />
            </div>
          </div>

          <!-- Info -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-0.5">
              <span class="text-sm font-medium text-theme-200 truncate">
                {{ ch.name }}
              </span>
              <span class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-theme-800 text-theme-400 shrink-0 uppercase">
                {{ ch.type }}
              </span>
            </div>
            <div class="flex items-center gap-2 text-xs text-theme-500">
              <img
                v-if="agentIconById(ch.agentId)"
                :src="agentIconById(ch.agentId)!"
                :alt="agentNameById(ch.agentId)"
                class="w-3.5 h-3.5 rounded-sm object-cover"
              >
              <Icon
                v-else
                icon="lucide:bot"
                class="w-3 h-3"
              />
              <span>{{ agentNameById(ch.agentId) }}</span>
              <template v-if="ch.status?.username">
                <span class="text-theme-700">·</span>
                <span class="font-mono">
                  @{{ ch.status.username }}
                </span>
              </template>
            </div>
            <div
              v-if="ch.status?.error"
              class="text-xs text-status-danger mt-0.5 truncate max-w-sm"
            >
              {{ ch.status.error }}
            </div>
          </div>

          <!-- Actions -->
          <div class="shrink-0 flex items-center gap-3">
            <!-- Edit / Delete (hover) -->
            <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                class="p-1.5 rounded-lg hover:bg-theme-800 text-theme-500 hover:text-theme-200 transition-colors"
                title="Edit"
                :aria-label="`Edit ${ch.name}`"
                @click.stop="openChannelEditor(ch.id)"
              >
                <Icon
                  icon="lucide:pencil"
                  class="w-3.5 h-3.5"
                />
              </button>
              <button
                class="p-1.5 rounded-lg hover:bg-red-500/10 text-theme-500 hover:text-status-danger transition-colors"
                title="Delete"
                @click.stop="confirmDelete(ch)"
              >
                <Icon
                  icon="lucide:trash-2"
                  class="w-3.5 h-3.5"
                />
              </button>
            </div>

            <!-- Toggle -->
            <ToggleSwitch
              :model-value="ch.enabled"
              :label="ch.enabled ? `Disable ${ch.name}` : `Enable ${ch.name}`"
              size="sm"
              color="emerald"
              :disabled="togglingIds.has(ch.id)"
              :title="ch.enabled ? 'Disable channel' : 'Enable channel'"
              @click.stop
              @update:model-value="toggleChannel(ch.id)"
            />

            <!-- Status -->
            <template v-if="ch.status?.connected">
              <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span class="text-xs text-status-success">Connected</span>
            </template>
            <template v-else-if="ch.enabled && ch.status?.error">
              <span class="w-2 h-2 rounded-full bg-red-500" />
              <span class="text-xs text-status-danger">Error</span>
            </template>
            <template v-else-if="ch.enabled">
              <span class="w-2 h-2 rounded-full bg-amber-500" />
              <span class="text-xs text-status-warning">Starting</span>
            </template>
            <template v-else>
              <span class="w-2 h-2 rounded-full bg-theme-600" />
              <span class="text-xs text-theme-500">Disabled</span>
            </template>
          </div>
        </div>
      </div>
      <div
        v-if="channelToggleStatus === 'saving' || channelToggleStatus === 'error'"
        class="mt-3 flex justify-end"
      >
        <SettingsPersistenceStatus
          mode="auto"
          :state="channelToggleStatus"
          :message="toggleError"
        />
      </div>
    </div>

    <!-- Add Channel Dialog -->
    <Teleport to="body">
      <div
        v-if="showAddDialog"
        class="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        :class="props.embedded ? 'z-200' : 'z-50'"
        @click.self="closeAddDialog"
      >
        <div class="w-full max-w-lg bg-theme-900 border border-theme-800 rounded-2xl shadow-2xl p-6 max-h-[85vh] overflow-y-auto">
          <div class="mb-4">
            <h2 class="text-lg font-semibold text-theme-100">
              Add Channel
            </h2>
          </div>

          <!-- Channel name -->
          <label class="block text-sm text-theme-400 mb-1">
            Name
          </label>
          <input
            v-model="dlgName"
            type="text"
            placeholder="e.g. Support Bot"
            class="w-full px-3 py-2 mb-4 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500"
          >

          <!-- Channel type -->
          <label class="block text-sm text-theme-400 mb-1">
            Platform
          </label>
          <div class="flex gap-2 mb-4">
            <button
              v-for="opt in channelTypeOptions"
              :key="opt.value"
              type="button"
              class="flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm transition-colors"
              :class="dlgType === opt.value
                ? 'border-accent-500 bg-accent-500/10 text-accent-fg'
                : 'border-theme-700 bg-theme-800 text-theme-400 hover:text-theme-200 hover:border-theme-600 disabled:opacity-50'"
              @click="dlgType = opt.value"
            >
              <Icon
                :icon="opt.icon"
                class="w-5 h-5"
              />
              {{ opt.label }}
            </button>
          </div>

          <!-- Agent picker -->
          <label class="block text-sm text-theme-400 mb-1">
            Agent
          </label>
          <div class="mb-4">
            <AgentSelect
              v-model="dlgAgentId"
              :agents="allAgents"
              placeholder="Select an agent…"
            />
          </div>

          <!-- Allowed agents -->
          <label class="block text-sm text-theme-400 mb-1">
            Allowed Agents
          </label>
          <p class="text-[11px] text-theme-600 mb-1.5">
            Restrict which agents can be switched to via commands. Leave empty to allow all.
          </p>
          <div class="mb-4">
            <MultiSelect
              v-model="dlgAllowedAgentIds"
              :options="agentOptions"
              placeholder="All agents"
            />
          </div>

          <!-- Telegram-specific config -->
          <template v-if="dlgType === 'telegram'">
            <label class="block text-sm text-theme-400 mb-1">
              Allowed Telegram User IDs
            </label>
            <input
              v-model="dlgAllowedTelegramUserIds"
              type="text"
              inputmode="numeric"
              placeholder="e.g. 123456789"
              class="w-full px-3 py-2 mb-1 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500 font-mono"
            >
            <p class="text-[11px] text-theme-600 mb-4">
              Required. Only these numeric Telegram user IDs can use the bot. Group chats are blocked.
            </p>

            <label class="block text-sm text-theme-400 mb-1">
              Bot Token
            </label>
            <div class="relative mb-1">
              <input
                v-model="dlgBotToken"
                type="password"
                placeholder="123456:ABC-DEF..."
                class="w-full px-3 py-2 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500 font-mono pr-10"
              >
            </div>
            <p class="text-[11px] text-theme-600 mb-4">
              Get your bot token from
              <span class="text-theme-400">@BotFather</span>
              on Telegram
            </p>
          </template>

          <!-- Discord-specific config -->
          <template v-if="dlgType === 'discord'">
            <label class="block text-sm text-theme-400 mb-1">
              Bot Token
            </label>
            <div class="relative mb-1">
              <input
                v-model="dlgBotToken"
                type="password"
                placeholder="MTIz...abc"
                class="w-full px-3 py-2 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500 font-mono pr-10"
              >
            </div>
            <p class="text-[11px] text-theme-600 mb-4">
              Get your bot token from the
              <span class="text-theme-400">Discord Developer Portal</span>
              — ensure Message Content intent is enabled
            </p>
          </template>

          <!-- Slack-specific config -->
          <template v-if="dlgType === 'slack'">
            <label class="block text-sm text-theme-400 mb-1">
              Bot Token
            </label>
            <div class="relative mb-1">
              <input
                v-model="dlgBotToken"
                type="password"
                placeholder="xoxb-..."
                class="w-full px-3 py-2 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500 font-mono pr-10"
              >
            </div>
            <p class="text-[11px] text-theme-600 mb-2">
              The Bot User OAuth Token from your Slack app's OAuth settings
            </p>

            <label class="block text-sm text-theme-400 mb-1">
              App Token
            </label>
            <div class="relative mb-1">
              <input
                v-model="dlgAppToken"
                type="password"
                placeholder="xapp-..."
                class="w-full px-3 py-2 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500 font-mono pr-10"
              >
            </div>
            <p class="text-[11px] text-theme-600 mb-4">
              Enable Socket Mode in your Slack app and generate an App-Level Token with
              <span class="text-theme-400">connections:write</span>
              scope
            </p>
          </template>

          <!-- Test Connection -->
          <button
            :disabled="dlgTesting || (!dlgBotToken.trim() && dlgType !== 'slack') || (dlgType === 'slack' && (!dlgBotToken.trim() || !dlgAppToken.trim()))"
            class="flex items-center gap-2 px-3 py-2 mb-4 rounded-lg border text-sm transition-colors"
            :class="dlgTestResult?.success
              ? 'border-emerald-500/30 bg-emerald-500/5 text-status-success'
              : dlgTestResult && !dlgTestResult.success
                ? 'border-red-500/30 bg-red-500/5 text-status-danger'
                : 'border-theme-700 bg-theme-800 text-theme-400 hover:text-theme-200 hover:border-theme-600 disabled:opacity-40'"
            @click="testConnection"
          >
            <Icon
              :icon="dlgTesting ? 'lucide:loader-2' : dlgTestResult?.success ? 'lucide:check-circle' : 'lucide:zap'"
              class="w-4 h-4"
              :class="{ 'animate-spin': dlgTesting }"
            />
            <template v-if="dlgTesting">
              Testing…
            </template>
            <template v-else-if="dlgTestResult?.success">
              Connected as @{{ dlgTestResult.username }}
            </template>
            <template v-else-if="dlgTestResult && !dlgTestResult.success">
              {{ dlgTestResult.error }}
            </template>
            <template v-else>
              Test Connection
            </template>
          </button>

          <!-- Enabled toggle -->
          <label class="flex items-center gap-2 mb-4 cursor-pointer select-none">
            <ToggleSwitch
              v-model="dlgEnabled"
              label="Enable channel on save"
              size="md"
              color="emerald"
            />
            <span class="text-sm text-theme-300">
              Enable on save
            </span>
          </label>

          <!-- Actions -->
          <div class="flex items-center justify-end gap-3">
            <SettingsPersistenceStatus
              mode="manual"
              :state="addSaveStatus === 'error' ? 'error' : dlgSaving ? 'saving' : addDraftDirty ? 'dirty' : addSaveStatus"
              class="mr-auto"
            />
            <button
              class="px-4 py-2 text-sm text-theme-400 hover:text-theme-200 transition-colors"
              @click="closeAddDialog"
            >
              Cancel
            </button>
            <button
              :disabled="!canSaveChannel || !addDraftDirty"
              class="px-4 py-2 rounded-lg bg-accent-600 hover:bg-accent-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-accent-on transition-colors"
              @click="saveChannel"
            >
              {{ dlgSaving ? 'Saving…' : 'Create Channel' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <ModalDialog
      :show="showAddDiscardConfirm"
      title="Discard channel changes?"
      icon="lucide:triangle-alert"
      icon-color="amber"
      :layer="props.embedded ? 'nested' : 'default'"
      @close="showAddDiscardConfirm = false"
    >
      <p class="text-sm leading-relaxed text-theme-400">
        The new channel has changes that have not been saved.
      </p>
      <template #actions>
        <button
          type="button"
          class="w-full rounded-xl bg-red-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-red-500"
          @click="discardAddDraft"
        >
          Discard changes
        </button>
        <button
          type="button"
          class="w-full rounded-xl bg-theme-800 px-4 py-3 text-sm font-medium text-theme-200 transition hover:bg-theme-700"
          @click="showAddDiscardConfirm = false"
        >
          Keep editing
        </button>
      </template>
    </ModalDialog>

    <!-- Delete Confirmation -->
    <ModalDialog
      :show="showDeleteConfirm"
      title="Delete Channel"
      icon="lucide:trash-2"
      icon-color="red"
      :layer="props.embedded ? 'nested' : 'default'"
      @close="showDeleteConfirm = false"
    >
      <p class="text-theme-400 leading-relaxed">
        Are you sure you want to delete the channel
        <strong class="text-theme-200">
          {{ pendingDeleteName }}
        </strong>?
        The bot will stop receiving messages.
      </p>
      <template #actions>
        <button
          class="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-sm font-medium text-white transition-colors"
          @click="deleteConfirmed()"
        >
          Delete
        </button>
        <button
          class="px-4 py-2 text-sm text-theme-400 hover:text-theme-200 transition-colors"
          @click="showDeleteConfirm = false"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
