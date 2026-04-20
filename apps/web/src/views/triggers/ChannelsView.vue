<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { api } from '../../api/client'
import type { AgentDefinition, ChannelDefinition, ChannelType } from '../../api/types'
import { Icon } from '@iconify/vue'
import ModalDialog from '../../components/shared/ModalDialog.vue'
import ToggleSwitch from '../../components/shared/ToggleSwitch.vue'
import BaseCard from '../../components/shared/BaseCard.vue'

const channels = ref<ChannelDefinition[]>([])
const allAgents = ref<AgentDefinition[]>([])
const loading = ref(true)
let pollTimer: ReturnType<typeof setInterval> | undefined

// Dialog state
const showAddDialog = ref(false)
const editingId = ref<string | null>(null)
const dlgName = ref('')
const dlgType = ref<ChannelType>('telegram')
const dlgAgentId = ref('')
const dlgBotToken = ref('')
const dlgAppToken = ref('')
const dlgEnabled = ref(true)
const dlgSaving = ref(false)
const dlgTesting = ref(false)
const dlgTestResult = ref<{ success: boolean; username?: string; error?: string } | null>(null)

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

function resetDialog() {
  dlgName.value = ''
  dlgType.value = 'telegram'
  dlgAgentId.value = ''
  dlgBotToken.value = ''
  dlgAppToken.value = ''
  dlgEnabled.value = true
  dlgTestResult.value = null
  editingId.value = null
}

async function openAddDialog() {
  allAgents.value = await api.agents.list()
  resetDialog()
  showAddDialog.value = true
}

async function openEditDialog(ch: ChannelDefinition) {
  allAgents.value = await api.agents.list()
  resetDialog()
  editingId.value = ch.id
  dlgName.value = ch.name
  dlgType.value = ch.type
  dlgAgentId.value = ch.agentId
  dlgBotToken.value = (ch.config.botToken as string) || ''
  dlgAppToken.value = (ch.config.appToken as string) || ''
  dlgEnabled.value = ch.enabled
  showAddDialog.value = true
}

function buildConfig(): Record<string, unknown> {
  if (dlgType.value === 'telegram' || dlgType.value === 'discord') {
    return { botToken: dlgBotToken.value.trim() }
  }
  if (dlgType.value === 'slack') {
    return { botToken: dlgBotToken.value.trim(), appToken: dlgAppToken.value.trim() }
  }
  return {}
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
  try {
    if (editingId.value) {
      await api.channels.update(editingId.value, {
        name: dlgName.value.trim(),
        agentId: dlgAgentId.value,
        config: buildConfig(),
        enabled: dlgEnabled.value
      })
    } else {
      if (!dlgAgentId.value) return
      await api.channels.create({
        name: dlgName.value.trim() || `${dlgType.value} channel`,
        type: dlgType.value,
        agentId: dlgAgentId.value,
        config: buildConfig(),
        enabled: dlgEnabled.value
      })
    }
    showAddDialog.value = false
    await loadChannels()
  } finally {
    dlgSaving.value = false
  }
}

async function toggleChannel(id: string) {
  await api.channels.toggle(id)
  await loadChannels()
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

onUnmounted(() => {
  clearInterval(pollTimer)
})
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-3xl mx-auto py-8 px-6">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-zinc-100">
            Channels
          </h1>
          <p class="text-sm text-zinc-500 mt-1">
            Connect messaging platforms to interact with agents
          </p>
        </div>
        <button
          class="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-medium text-white transition-colors"
          @click="openAddDialog"
        >
          <Icon
            icon="lucide:plus"
            class="w-4 h-4"
          />
          Add Channel
        </button>
      </div>

      <!-- Loading -->
      <BaseCard
        v-if="loading"
        class="p-12 text-center"
      >
        <Icon
          icon="lucide:loader-2"
          class="w-8 h-8 text-zinc-500 animate-spin mx-auto mb-3"
        />
        <p class="text-sm text-zinc-500">
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
        <h3 class="text-lg font-medium text-zinc-200 mb-2">
          No channels configured
        </h3>
        <p class="text-sm text-zinc-500 max-w-md mx-auto mb-4">
          Connect a messaging platform like Telegram so users can interact with your agents via chat.
        </p>
        <button
          class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-medium text-white transition-colors"
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
          class="flex items-center gap-4 px-5 py-4 rounded-xl border bg-zinc-800/60 group"
          :class="ch.enabled ? 'border-zinc-700' : 'border-zinc-700/50 opacity-60'"
        >
          <!-- Channel type icon -->
          <div class="shrink-0">
            <div
              class="w-10 h-10 rounded-xl flex items-center justify-center"
              :class="ch.type === 'telegram' ? 'bg-sky-500/10' : ch.type === 'discord' ? 'bg-indigo-500/10' : ch.type === 'slack' ? 'bg-purple-500/10' : 'bg-zinc-800'"
            >
              <Icon
                :icon="ch.type === 'telegram' ? 'mdi:telegram' : ch.type === 'discord' ? 'ic:baseline-discord' : ch.type === 'slack' ? 'mdi:slack' : 'lucide:radio'"
                class="w-5 h-5"
                :class="ch.type === 'telegram' ? 'text-sky-400' : ch.type === 'discord' ? 'text-indigo-400' : ch.type === 'slack' ? 'text-purple-400' : 'text-zinc-500'"
              />
            </div>
          </div>

          <!-- Info -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-0.5">
              <span class="text-sm font-medium text-zinc-200 truncate">
                {{ ch.name }}
              </span>
              <span class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 shrink-0 uppercase">
                {{ ch.type }}
              </span>
            </div>
            <div class="flex items-center gap-2 text-xs text-zinc-500">
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
                <span class="text-zinc-700">·</span>
                <span class="font-mono">
                  @{{ ch.status.username }}
                </span>
              </template>
            </div>
            <div
              v-if="ch.status?.error"
              class="text-xs text-red-400 mt-0.5 truncate max-w-sm"
            >
              {{ ch.status.error }}
            </div>
          </div>

          <!-- Actions -->
          <div class="shrink-0 flex items-center gap-3">
            <!-- Edit / Delete (hover) -->
            <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                class="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition-colors"
                title="Edit"
                @click="openEditDialog(ch)"
              >
                <Icon
                  icon="lucide:pencil"
                  class="w-3.5 h-3.5"
                />
              </button>
              <button
                class="p-1.5 rounded-lg hover:bg-red-500/10 text-zinc-500 hover:text-red-400 transition-colors"
                title="Delete"
                @click="confirmDelete(ch)"
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
              size="sm"
              color="emerald"
              :title="ch.enabled ? 'Disable channel' : 'Enable channel'"
              @update:model-value="toggleChannel(ch.id)"
            />

            <!-- Status -->
            <template v-if="ch.status?.connected">
              <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span class="text-xs text-emerald-400">Connected</span>
            </template>
            <template v-else-if="ch.enabled && ch.status?.error">
              <span class="w-2 h-2 rounded-full bg-red-500" />
              <span class="text-xs text-red-400">Error</span>
            </template>
            <template v-else-if="ch.enabled">
              <span class="w-2 h-2 rounded-full bg-amber-500" />
              <span class="text-xs text-amber-400">Starting</span>
            </template>
            <template v-else>
              <span class="w-2 h-2 rounded-full bg-zinc-600" />
              <span class="text-xs text-zinc-500">Disabled</span>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- Add / Edit Channel Dialog -->
    <Teleport to="body">
      <div
        v-if="showAddDialog"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        @click.self="showAddDialog = false"
      >
        <div class="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl p-6 max-h-[85vh] overflow-y-auto">
          <h2 class="text-lg font-semibold text-zinc-100 mb-4">
            {{ editingId ? 'Edit Channel' : 'Add Channel' }}
          </h2>

          <!-- Channel name -->
          <label class="block text-sm text-zinc-400 mb-1">
            Name
          </label>
          <input
            v-model="dlgName"
            type="text"
            placeholder="e.g. Support Bot"
            class="w-full px-3 py-2 mb-4 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >

          <!-- Channel type -->
          <label class="block text-sm text-zinc-400 mb-1">
            Platform
          </label>
          <div class="flex gap-2 mb-4">
            <button
              v-for="opt in channelTypeOptions"
              :key="opt.value"
              type="button"
              :disabled="!!editingId"
              class="flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm transition-colors"
              :class="dlgType === opt.value
                ? 'border-blue-500 bg-blue-500/10 text-blue-400'
                : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 disabled:opacity-50'"
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
          <label class="block text-sm text-zinc-400 mb-1">
            Agent
          </label>
          <select
            v-model="dlgAgentId"
            class="w-full px-3 py-2 mb-4 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option
              value=""
              disabled
            >
              Select an agent…
            </option>
            <option
              v-for="a in allAgents"
              :key="a.id"
              :value="a.id"
            >
              {{ a.name }}
            </option>
          </select>

          <!-- Telegram-specific config -->
          <template v-if="dlgType === 'telegram'">
            <label class="block text-sm text-zinc-400 mb-1">
              Bot Token
            </label>
            <div class="relative mb-1">
              <input
                v-model="dlgBotToken"
                type="password"
                placeholder="123456:ABC-DEF..."
                class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono pr-10"
              >
            </div>
            <p class="text-[11px] text-zinc-600 mb-4">
              Get your bot token from
              <span class="text-zinc-400">@BotFather</span>
              on Telegram
            </p>
          </template>

          <!-- Discord-specific config -->
          <template v-if="dlgType === 'discord'">
            <label class="block text-sm text-zinc-400 mb-1">
              Bot Token
            </label>
            <div class="relative mb-1">
              <input
                v-model="dlgBotToken"
                type="password"
                placeholder="MTIz...abc"
                class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono pr-10"
              >
            </div>
            <p class="text-[11px] text-zinc-600 mb-4">
              Get your bot token from the
              <span class="text-zinc-400">Discord Developer Portal</span>
              — ensure Message Content intent is enabled
            </p>
          </template>

          <!-- Slack-specific config -->
          <template v-if="dlgType === 'slack'">
            <label class="block text-sm text-zinc-400 mb-1">
              Bot Token
            </label>
            <div class="relative mb-1">
              <input
                v-model="dlgBotToken"
                type="password"
                placeholder="xoxb-..."
                class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono pr-10"
              >
            </div>
            <p class="text-[11px] text-zinc-600 mb-2">
              The Bot User OAuth Token from your Slack app's OAuth settings
            </p>

            <label class="block text-sm text-zinc-400 mb-1">
              App Token
            </label>
            <div class="relative mb-1">
              <input
                v-model="dlgAppToken"
                type="password"
                placeholder="xapp-..."
                class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono pr-10"
              >
            </div>
            <p class="text-[11px] text-zinc-600 mb-4">
              Enable Socket Mode in your Slack app and generate an App-Level Token with
              <span class="text-zinc-400">connections:write</span>
              scope
            </p>
          </template>

          <!-- Test Connection -->
          <button
            :disabled="dlgTesting || (!dlgBotToken.trim() && dlgType !== 'slack') || (dlgType === 'slack' && (!dlgBotToken.trim() || !dlgAppToken.trim()))"
            class="flex items-center gap-2 px-3 py-2 mb-4 rounded-lg border text-sm transition-colors"
            :class="dlgTestResult?.success
              ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400'
              : dlgTestResult && !dlgTestResult.success
                ? 'border-red-500/30 bg-red-500/5 text-red-400'
                : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 disabled:opacity-40'"
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
              size="md"
              color="emerald"
            />
            <span class="text-sm text-zinc-300">
              Enable on save
            </span>
          </label>

          <!-- Actions -->
          <div class="flex justify-end gap-3">
            <button
              class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
              @click="showAddDialog = false"
            >
              Cancel
            </button>
            <button
              :disabled="!dlgAgentId || !dlgBotToken.trim() || dlgSaving"
              class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
              @click="saveChannel"
            >
              {{ dlgSaving ? 'Saving…' : editingId ? 'Save Changes' : 'Create Channel' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Delete Confirmation -->
    <ModalDialog
      :show="showDeleteConfirm"
      title="Delete Channel"
      icon="lucide:trash-2"
      icon-color="red"
      @close="showDeleteConfirm = false"
    >
      <p class="text-zinc-400 leading-relaxed">
        Are you sure you want to delete the channel
        <strong class="text-zinc-200">
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
          class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          @click="showDeleteConfirm = false"
        >
          Cancel
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
