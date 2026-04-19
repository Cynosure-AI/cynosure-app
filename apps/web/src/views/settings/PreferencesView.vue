<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { usePreferencesStore, type ContextStrategy } from '../../stores/preferences.store'
import type { ThemeId } from '../../stores/preferences.store'
import { useProviderStore } from '../../stores/provider.store'
import { useProviderLogos } from '../../composables/useProviderLogos'
import { Icon } from '@iconify/vue'
import ToggleSwitch from '../../components/shared/ToggleSwitch.vue'
import CustomSelect from '../../components/shared/CustomSelect.vue'
import type { SelectOptionGroup } from '../../components/shared/CustomSelect.vue'

const prefs = usePreferencesStore()
const providerStore = useProviderStore()
const { logoUrl } = useProviderLogos()

const themes: { id: ThemeId; label: string; icon: string; colors: { bg: string; surface: string; accent: string; text: string } }[] = [
  { id: 'dark', label: 'Dark', icon: 'lucide:moon', colors: { bg: '#09090b', surface: '#18181b', accent: '#3b82f6', text: '#f4f4f5' } },
  { id: 'light', label: 'Light', icon: 'lucide:sun', colors: { bg: '#ffffff', surface: '#f9fafb', accent: '#3b82f6', text: '#111827' } },
  { id: 'arasaka', label: 'Arasaka', icon: 'lucide:zap', colors: { bg: '#080405', surface: '#110a0d', accent: '#ff003c', text: '#f0dce2' } },
  { id: 'midnight-purple', label: 'Midnight', icon: 'lucide:sparkles', colors: { bg: '#08060e', surface: '#0f0a1c', accent: '#a855f7', text: '#ebe5f5' } },
  { id: 'cyberpunk', label: 'Cyberpunk', icon: 'lucide:cpu', colors: { bg: '#060608', surface: '#16161e', accent: '#f9f002', text: '#e8e8f0' } },
]

const contextStrategyOptions: { value: ContextStrategy; label: string; description: string }[] = [
  { value: 'sliding-window', label: 'Sliding Window', description: 'Keeps the most recent messages, trimming older ones' },
  { value: 'truncate-middle', label: 'Truncate Middle', description: 'Keeps the first and last messages, trimming the middle' },
  { value: 'none', label: 'No Trimming', description: 'Sends all messages — may fail if context is exceeded' },
]

// ── Title generation provider/model ───────────────────────────────────────────
const titleModels = ref<string[]>([])
const titleLoadingModels = ref(false)

const titleProviderGroups = computed((): SelectOptionGroup[] => [{
  options: [
    { value: '', label: 'Use chat provider', iconName: 'lucide:settings' },
    ...providerStore.providers.map(p => ({
      value: p.id,
      label: p.name,
      imgSrc: logoUrl(p.type),
    })),
  ],
}])

const titleModelGroups = computed((): SelectOptionGroup[] => [{
  options: [
    { value: '', label: 'Use provider default', iconName: 'lucide:settings' },
    ...titleModels.value.map(m => ({ value: m, label: m })),
  ],
}])

async function fetchTitleModels(providerId: string) {
  if (!providerId) { titleModels.value = []; return }
  titleLoadingModels.value = true
  try {
    titleModels.value = await providerStore.listModels(providerId, 'llm')
  } catch { titleModels.value = [] }
  titleLoadingModels.value = false
}

watch(() => prefs.titleProviderId, (id) => {
  prefs.titleModel = ''
  fetchTitleModels(id)
}, { immediate: true })
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-3xl mx-auto py-8 px-6">
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-zinc-100">
          Preferences
        </h1>
        <p class="text-sm text-zinc-500 mt-1">
          Customize your application experience
        </p>
      </div>

      <div class="space-y-4">
        <!-- Theme -->
        <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-4">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-zinc-800 flex items-center justify-center">
              <Icon
                icon="lucide:palette"
                class="w-5 h-5 text-zinc-400"
              />
            </div>
            <div>
              <h3 class="text-sm font-medium text-zinc-200">
                Theme
              </h3>
              <p class="text-xs text-zinc-500 mt-0.5">
                Choose your visual style
              </p>
            </div>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <button
              v-for="t in themes"
              :key="t.id"
              class="group relative rounded-lg border-2 p-3 transition-all duration-200 text-left"
              :class="prefs.theme === t.id
                ? 'border-blue-500 ring-1 ring-blue-500/30'
                : 'border-zinc-700 hover:border-zinc-600'"
              @click="prefs.setTheme(t.id)"
            >
              <!-- Mini preview -->
              <div
                class="rounded-md overflow-hidden mb-2.5 h-16 p-1.5 flex flex-col gap-1"
                :style="{ backgroundColor: t.colors.bg }"
              >
                <!-- Mock sidebar + content -->
                <div class="flex gap-1 flex-1">
                  <div
                    class="w-5 rounded-sm"
                    :style="{ backgroundColor: t.colors.surface }"
                  />
                  <div class="flex-1 flex flex-col gap-0.5">
                    <div
                      class="h-2 rounded-sm w-3/4"
                      :style="{ backgroundColor: t.colors.surface }"
                    />
                    <div
                      class="h-1.5 rounded-sm w-1/2 opacity-50"
                      :style="{ backgroundColor: t.colors.text }"
                    />
                    <div class="flex-1" />
                    <div
                      class="h-2 rounded-sm w-1/3"
                      :style="{ backgroundColor: t.colors.accent }"
                    />
                  </div>
                </div>
              </div>

              <div class="flex items-center gap-2">
                <Icon
                  :icon="t.icon"
                  class="w-3.5 h-3.5"
                  :style="{ color: t.colors.accent }"
                />
                <span class="text-xs font-medium text-zinc-200">{{ t.label }}</span>
              </div>

              <!-- Active indicator -->
              <div
                v-if="prefs.theme === t.id"
                class="absolute top-1.5 right-1.5"
              >
                <Icon
                  icon="lucide:check-circle-2"
                  class="w-4 h-4 text-blue-400"
                />
              </div>
            </button>
          </div>
        </div>

        <!-- Auto-expand Thinking -->
        <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-lg bg-zinc-800 flex items-center justify-center">
                <Icon
                  icon="lucide:list-tree"
                  class="w-5 h-5 text-zinc-400"
                />
              </div>
              <div>
                <h3 class="text-sm font-medium text-zinc-200">
                  Auto-expand Thinking
                </h3>
                <p class="text-xs text-zinc-500 mt-0.5">
                  Automatically expand thinking / reasoning blocks
                </p>
              </div>
            </div>
            <ToggleSwitch v-model="prefs.autoExpandSteps" />
          </div>
        </div>

        <!-- Auto-expand Tool Calls -->
        <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-lg bg-zinc-800 flex items-center justify-center">
                <Icon
                  icon="lucide:terminal"
                  class="w-5 h-5 text-zinc-400"
                />
              </div>
              <div>
                <h3 class="text-sm font-medium text-zinc-200">
                  Auto-expand Tool Calls
                </h3>
                <p class="text-xs text-zinc-500 mt-0.5">
                  Automatically expand tool call details in the chat
                </p>
              </div>
            </div>
            <ToggleSwitch v-model="prefs.autoExpandToolCalls" />
          </div>
        </div>

        <!-- Generate Chat Titles -->
        <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-lg bg-zinc-800 flex items-center justify-center">
                <Icon
                  icon="lucide:heading"
                  class="w-5 h-5 text-zinc-400"
                />
              </div>
              <div>
                <h3 class="text-sm font-medium text-zinc-200">
                  Generate Chat Titles
                </h3>
                <p class="text-xs text-zinc-500 mt-0.5">
                  Use AI to generate descriptive titles for chat conversations
                </p>
              </div>
            </div>
            <ToggleSwitch v-model="prefs.generateTitle" />
          </div>

          <div
            v-if="prefs.generateTitle"
            class="grid grid-cols-2 gap-3 pt-1 border-t border-zinc-800"
          >
            <div>
              <label class="block text-xs text-zinc-400 mb-1.5">Provider</label>
              <CustomSelect
                v-model="prefs.titleProviderId"
                :groups="titleProviderGroups"
                placeholder="Use chat provider"
                placeholder-icon="lucide:settings"
              />
            </div>
            <div>
              <label class="block text-xs text-zinc-400 mb-1.5">Model</label>
              <CustomSelect
                v-model="prefs.titleModel"
                :groups="titleModelGroups"
                placeholder="Use provider default"
                placeholder-icon="lucide:settings"
                filterable
              />
            </div>
          </div>
        </div>

        <!-- Context Strategy -->
        <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-3">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-zinc-800 flex items-center justify-center">
              <Icon
                icon="lucide:scissors"
                class="w-5 h-5 text-zinc-400"
              />
            </div>
            <div>
              <h3 class="text-sm font-medium text-zinc-200">
                Context Strategy
              </h3>
              <p class="text-xs text-zinc-500 mt-0.5">
                How to manage conversation history when it exceeds the model's context window
              </p>
            </div>
          </div>
          <select
            :value="prefs.contextStrategy"
            class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            @change="prefs.contextStrategy = ($event.target as HTMLSelectElement).value as ContextStrategy"
          >
            <option
              v-for="opt in contextStrategyOptions"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }} — {{ opt.description }}
            </option>
          </select>
        </div>
      </div>
    </div>
  </div>
</template>
