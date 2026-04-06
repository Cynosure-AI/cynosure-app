<script setup lang="ts">
import { useProviderStore } from '../../stores/provider.store'
import { useRouter, useRoute } from 'vue-router'

const providerStore = useProviderStore()
const router = useRouter()
const route = useRoute()

function goToSettings(): void {
  router.push('/settings')
}

function goToChat(): void {
  router.push('/chat')
}
</script>

<template>
  <header class="h-12 bg-zinc-900 border-b border-zinc-800 flex items-center px-4 gap-4 shrink-0">
    <!-- Navigation Tabs -->
    <nav class="flex gap-1">
      <button
        class="px-3 py-1.5 text-sm rounded-md transition-colors"
        :class="
          route.path === '/chat' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
        "
        @click="goToChat"
      >
        Chat
      </button>
    </nav>

    <div class="flex-1" />

    <!-- Provider Selector -->
    <div class="flex items-center gap-2">
      <select
        v-if="providerStore.providers.length > 0"
        :value="providerStore.activeProviderId"
        class="bg-zinc-800 border border-zinc-700 text-zinc-300 text-sm rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
        @change="providerStore.setActive(($event.target as HTMLSelectElement).value)"
      >
        <option
          v-for="p in providerStore.providers"
          :key="p.id"
          :value="p.id"
        >
          {{ p.name }} ({{ p.defaultModel }})
        </option>
      </select>
      <span
        v-else
        class="text-sm text-zinc-500"
      >No providers configured</span>
    </div>

    <!-- Settings -->
    <button
      class="p-1.5 text-zinc-400 hover:text-zinc-200 rounded-md transition-colors"
      :class="{ 'text-zinc-100 bg-zinc-700': route.path === '/settings' }"
      @click="goToSettings"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-5 w-5"
        viewBox="0 0 20 20"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
          clip-rule="evenodd"
        />
      </svg>
    </button>
  </header>
</template>
