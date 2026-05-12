<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TabBar, { type TabDef } from '../../components/shared/TabBar.vue'
import ProviderSettings from '../../components/settings/ProviderSettings.vue'
import MemorySettings from '../../components/settings/MemorySettings.vue'
import SpeechToTextSettings from '../../components/settings/SpeechToTextSettings.vue'
import ChatSettings from '../../components/settings/ChatSettings.vue'

type AISettingsTab = 'providers' | 'memory' | 'speech-to-text' | 'chat'

const route = useRoute()
const router = useRouter()

const tabs: TabDef<AISettingsTab>[] = [
  { value: 'providers', label: 'Providers', icon: 'lucide:cpu' },
  { value: 'memory', label: 'Memory', icon: 'lucide:brain' },
  { value: 'chat', label: 'Chat', icon: 'lucide:message-square' },
  { value: 'speech-to-text', label: 'Speech to Text', icon: 'lucide:mic' },
]

function tabFromQuery(value: unknown): AISettingsTab {
  if (value === 'memory' || value === 'speech-to-text' || value === 'chat') return value
  return 'providers'
}

const activeTab = ref<AISettingsTab>(tabFromQuery(route.query.tab))

watch(() => route.query.tab, (tab) => {
  activeTab.value = tabFromQuery(tab)
})

watch(activeTab, (tab) => {
  if (route.query.tab === tab) return
  router.replace({ query: { ...route.query, tab } })
})
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-4xl mx-auto py-8 px-6">
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-theme-100">
          AI Settings
        </h1>
        <p class="text-sm text-theme-500 mt-1">
          Configure providers, memory, voice input, and chat behavior
        </p>
      </div>

      <TabBar
        v-model="activeTab"
        :tabs="tabs"
        class="mb-6"
      />

      <ProviderSettings v-if="activeTab === 'providers'" />
      <MemorySettings v-else-if="activeTab === 'memory'" />
      <SpeechToTextSettings v-else-if="activeTab === 'speech-to-text'" />
      <ChatSettings v-else />
    </div>
  </div>
</template>
