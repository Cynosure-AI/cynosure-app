<script setup lang="ts">
import { Icon } from '@iconify/vue'

export type ApprovalMode = 'allow' | 'default' | 'ask'

const props = defineProps<{
  /** Current mode; 'mixed' highlights no segment. */
  mode: ApprovalMode | 'mixed'
  /** Effective result while following defaults (shown as an icon on the Default segment). */
  defaultAllows?: boolean
  disabled?: boolean
  /** Accessible name for the radio group. */
  label?: string
}>()

const emit = defineEmits<{
  change: [mode: ApprovalMode]
}>()

const options: { mode: ApprovalMode; label: string; title: string; activeClass: string }[] = [
  {
    mode: 'allow',
    label: 'Allow',
    title: 'Run without asking',
    activeClass: 'bg-green-500/20 text-status-green',
  },
  {
    mode: 'default',
    label: 'Default',
    title: 'Follow behavior annotations: read-only tools are allowed; write, destructive, and unannotated tools ask',
    activeClass: 'bg-sky-500/20 text-status-info',
  },
  {
    mode: 'ask',
    label: 'Ask',
    title: 'Pause for your approval before each call',
    activeClass: 'bg-amber-500/15 text-status-warning',
  },
]

function select(mode: ApprovalMode): void {
  if (props.disabled || mode === props.mode) return
  emit('change', mode)
}

function defaultTitle(): string {
  if (props.mode !== 'default' || props.defaultAllows === undefined) return options[1].title
  return props.defaultAllows ? 'Following defaults: currently allowed' : 'Following defaults: currently asks'
}
</script>

<template>
  <div
    role="radiogroup"
    :aria-label="label"
    class="inline-flex shrink-0 items-center rounded-md border border-theme-700/80 bg-theme-950/70 p-0.5"
    :class="disabled ? 'opacity-60' : undefined"
    @click.stop
  >
    <button
      v-for="option in options"
      :key="option.mode"
      type="button"
      role="radio"
      :aria-checked="mode === option.mode"
      :disabled="disabled"
      :title="option.mode === 'default' ? defaultTitle() : option.title"
      class="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed"
      :class="mode === option.mode ? option.activeClass : 'text-ink-muted hover:bg-theme-800 hover:text-theme-200'"
      @click="select(option.mode)"
    >
      <Icon
        v-if="option.mode === 'default' && mode === 'default' && defaultAllows !== undefined"
        :icon="defaultAllows ? 'lucide:shield-check' : 'lucide:shield-alert'"
        class="h-3 w-3"
        :class="defaultAllows ? 'text-status-green' : 'text-status-warning'"
      />
      {{ option.label }}
    </button>
  </div>
</template>
