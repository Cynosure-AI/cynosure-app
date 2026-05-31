<script setup lang="ts">
import { ref } from 'vue'
import { api } from '../../api/client'
import { Icon } from '@iconify/vue'
import ModalDialog from '../shared/ModalDialog.vue'

const showResetConfirm = ref(false)
const resetConfirmText = ref('')
const resetting = ref(false)
const resetError = ref('')

async function doReset(): Promise<void> {
  resetting.value = true
  resetError.value = ''
  try {
    await api.backup.resetApp()
    window.location.reload()
  } catch (e) {
    resetError.value = (e as Error).message
  } finally {
    resetting.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-xs text-theme-400">
      Permanently delete all data and reset Cynosure to a clean state. This removes all agents, providers,
      conversations, memory spaces, MCP servers, channels, and settings.
    </p>

    <div class="flex items-center gap-2 p-2.5 rounded-lg bg-red-500/10 border border-red-500/20">
      <Icon
        icon="lucide:alert-triangle"
        class="w-4 h-4 text-red-400 shrink-0"
      />
      <p class="text-xs text-red-400/90">
        This action is irreversible. Consider exporting a backup first.
      </p>
    </div>

    <div
      v-if="resetError"
      class="text-xs text-red-400"
    >
      {{ resetError }}
    </div>

    <button
      class="w-full px-4 py-2.5 bg-red-600 hover:bg-red-500 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
      @click="showResetConfirm = true"
    >
      <Icon
        icon="lucide:trash-2"
        class="w-4 h-4"
      />
      Reset to Clean State
    </button>
  </div>

  <!-- Reset confirmation modal -->
  <ModalDialog
    :show="showResetConfirm"
    title="Reset Application"
    icon="lucide:alert-triangle"
    icon-color="red"
    @close="showResetConfirm = false; resetConfirmText = ''"
  >
    <p class="text-sm text-theme-400 mb-4">
      This will permanently delete <strong class="text-theme-200">all data</strong> including agents, providers,
      conversations, memory, and settings. This cannot be undone.
    </p>
    <p class="text-sm text-theme-400 mb-2">
      Type <strong class="text-red-400">RESET</strong> to confirm:
    </p>
    <input
      v-model="resetConfirmText"
      type="text"
      placeholder="Type RESET"
      class="w-full px-3 py-2 bg-theme-800 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder-theme-600 focus:outline-none focus:border-red-500/50"
    >
    <template #actions>
      <button
        :disabled="resetConfirmText !== 'RESET' || resetting"
        class="w-full px-4 py-2.5 bg-red-600 hover:bg-red-500 disabled:bg-theme-700 disabled:text-theme-500 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
        @click="doReset"
      >
        <Icon
          v-if="resetting"
          icon="lucide:loader-2"
          class="w-4 h-4 animate-spin"
        />
        <Icon
          v-else
          icon="lucide:trash-2"
          class="w-4 h-4"
        />
        {{ resetting ? 'Resetting...' : 'Confirm Reset' }}
      </button>
      <button
        class="w-full px-4 py-2 text-theme-400 hover:text-theme-200 text-sm transition-colors"
        @click="showResetConfirm = false; resetConfirmText = ''"
      >
        Cancel
      </button>
    </template>
  </ModalDialog>
</template>
