<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Icon } from '@iconify/vue'
import BaseCard from '../shared/BaseCard.vue'
import SettingsSubheading from './SettingsSubheading.vue'
import { SK_GLOBAL_HOTKEY } from '../../utils/storage-keys'
import { syncPrefsToElectron } from '../../utils/electron-prefs'

type HotkeyResult = { success: boolean; accelerator: string; error?: string }
type ElectronHotkeyApi = {
  getGlobalHotkey?: () => Promise<HotkeyResult>
  setGlobalHotkey?: (accelerator: string) => Promise<HotkeyResult>
}

const props = withDefaults(defineProps<{ visibleSections?: string[] }>(), {
  visibleSections: () => []
})

const electron = (window as unknown as { electron?: ElectronHotkeyApi }).electron
const isElectron = computed(() => typeof electron?.getGlobalHotkey === 'function' && typeof electron?.setGlobalHotkey === 'function')
const accelerator = ref('Control+Space')
const recording = ref(false)
const saving = ref(false)
const error = ref('')

const visible = computed(() => props.visibleSections.length === 0 || props.visibleSections.includes('global-hotkey'))
const displayAccelerator = computed(() => accelerator.value
  .replace(/CommandOrControl/g, 'Ctrl')
  .replace(/Control/g, 'Ctrl')
  .replace(/Command/g, 'Cmd')
  .replace(/Super/g, 'Meta')
  .split('+')
  .join(' + '))

onMounted(async () => {
  if (!isElectron.value) return
  const current = await electron!.getGlobalHotkey!()
  accelerator.value = current.accelerator
  if (!current.success) error.value = current.error || 'The shortcut could not be registered.'
})

function keyName(event: KeyboardEvent): string | null {
  if (event.code === 'Space') return 'Space'
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3)
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5)
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(event.key)) return event.key
  const names: Record<string, string> = {
    Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown'
  }
  return names[event.key] || null
}

async function save(next: string): Promise<void> {
  if (!electron?.setGlobalHotkey) return
  saving.value = true
  error.value = ''
  try {
    const result = await electron.setGlobalHotkey(next)
    accelerator.value = result.accelerator
    if (!result.success) {
      error.value = result.error || 'Could not register that shortcut.'
      return
    }
    localStorage.setItem(SK_GLOBAL_HOTKEY, result.accelerator)
    syncPrefsToElectron()
  } finally {
    saving.value = false
  }
}

function record(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') {
    recording.value = false
    return
  }
  const key = keyName(event)
  if (!key || ['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return
  const modifiers = [
    event.ctrlKey ? 'Control' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    event.metaKey ? 'Super' : ''
  ].filter(Boolean)
  if (modifiers.length === 0 && !key.startsWith('F')) {
    error.value = 'Use at least one modifier key (Ctrl, Alt, Shift, or Meta).'
    return
  }
  recording.value = false
  void save([...modifiers, key].join('+'))
}
</script>

<template>
  <div
    v-if="isElectron && visible"
    class="space-y-4"
  >
    <SettingsSubheading label="Global Shortcut" />
    <BaseCard class="p-5">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex items-start gap-3">
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-theme-900">
            <Icon
              icon="lucide:keyboard"
              class="h-5 w-5 text-theme-400"
            />
          </div>
          <div>
            <h3 class="text-sm font-medium text-theme-200">
              New chat shortcut
            </h3>
            <p class="mt-0.5 text-xs text-theme-500">
              Open a compact new chat beside the mouse cursor from anywhere.
            </p>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-2">
          <button
            type="button"
            class="min-w-36 rounded-lg border px-3 py-2 font-mono text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/70"
            :class="recording ? 'border-accent-500 bg-accent-500/10 text-accent-300' : 'border-theme-700 bg-theme-900 text-theme-200 hover:bg-theme-800'"
            :disabled="saving"
            @click="recording = true; error = ''"
            @keydown="record"
            @blur="recording = false"
          >
            {{ recording ? 'Press shortcut…' : displayAccelerator }}
          </button>
          <button
            type="button"
            class="rounded-lg border border-theme-700 bg-theme-800 px-3 py-2 text-xs font-medium text-theme-300 transition hover:bg-theme-700 disabled:opacity-50"
            :disabled="saving || accelerator === 'Control+Space'"
            @click="save('Control+Space')"
          >
            Reset
          </button>
        </div>
      </div>
      <p
        v-if="error"
        class="mt-3 text-xs text-red-400 sm:text-right"
      >
        {{ error }}
      </p>
    </BaseCard>
  </div>
</template>
