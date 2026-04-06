<script setup lang="ts">
import ProviderSettings from '../components/settings/ProviderSettings.vue'
import McpSettings from '../components/settings/McpSettings.vue'
import ToggleSwitch from '../components/shared/ToggleSwitch.vue'
import { usePreferencesStore } from '../stores/preferences.store'

const prefs = usePreferencesStore()
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-3xl mx-auto py-8 px-4">
      <h1 class="text-2xl font-bold text-zinc-100 mb-6">
        Settings
      </h1>

      <!-- Agent Settings -->
      <section class="mb-8">
        <h2 class="text-lg font-semibold text-zinc-200 mb-4">
          Agent
        </h2>
        <div class="rounded-lg border border-zinc-700 bg-zinc-800 p-4 space-y-4">
          <div>
            <label class="block text-sm font-medium text-zinc-300 mb-2">
              Tool Approvals
            </label>
            <p class="text-xs text-zinc-500">
              Configure which tools run automatically and which require your confirmation.
              Manage approvals per tool in the tool selector (status bar).
            </p>
          </div>

          <div class="flex items-center justify-between">
            <div>
              <label class="block text-sm font-medium text-zinc-300">Auto-expand Thinking</label>
              <p class="text-xs text-zinc-500 mt-0.5">
                Automatically expand thinking / reasoning blocks.
              </p>
            </div>
            <ToggleSwitch v-model="prefs.autoExpandSteps" />
          </div>
        </div>
      </section>

      <!-- Provider Settings -->
      <section class="mb-8">
        <ProviderSettings />
      </section>

      <!-- MCP Servers -->
      <section class="mb-8">
        <McpSettings />
      </section>
    </div>
  </div>
</template>
