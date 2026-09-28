<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'

export type SettingsPersistenceMode = 'auto' | 'manual'
export type SettingsPersistenceState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

const props = withDefaults(defineProps<{
  mode: SettingsPersistenceMode
  state?: SettingsPersistenceState
  message?: string
}>(), {
  state: 'idle',
  message: '',
})

const content = computed(() => {
  if (props.message) return props.message
  if (props.state === 'saving') return 'Saving…'
  if (props.state === 'dirty') return 'Unsaved changes'
  if (props.state === 'error') return 'Could not save. Try again.'
  return ''
})

const visible = computed(() => ['dirty', 'saving', 'error'].includes(props.state))

const icon = computed(() => ({
  idle: props.mode === 'auto' ? 'lucide:cloud-check' : 'lucide:save',
  dirty: 'lucide:circle-dot',
  saving: 'lucide:loader-2',
  saved: 'lucide:check-circle-2',
  error: 'lucide:circle-alert',
}[props.state]))
</script>

<template>
  <span
    v-if="visible"
    class="inline-flex items-center gap-1.5 text-[11px]"
    :class="{
      'text-ink-muted': state === 'idle',
      'text-status-warning': state === 'dirty',
      'text-ink-secondary': state === 'saving',
      'text-status-success': state === 'saved',
      'text-status-danger': state === 'error',
    }"
    role="status"
    aria-live="polite"
  >
    <Icon
      :icon="icon"
      class="h-3.5 w-3.5 shrink-0"
      :class="{ 'animate-spin': state === 'saving' }"
    />
    {{ content }}
  </span>
</template>
