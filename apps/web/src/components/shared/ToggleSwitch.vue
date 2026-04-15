<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    modelValue: boolean
    /** Track color when on. Default: 'blue' */
    color?: 'blue' | 'emerald' | 'green' | 'amber' | 'purple' | 'red' | 'indigo'
    /** Toggle size. 'sm' = compact list rows, 'md' = dialogs, 'lg' = settings cards */
    size?: 'sm' | 'md' | 'lg'
    disabled?: boolean
  }>(),
  { color: 'blue', size: 'lg', disabled: false },
)

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

function toggle(): void {
  if (!props.disabled) emit('update:modelValue', !props.modelValue)
}

const onColors: Record<string, string> = {
  blue: 'bg-blue-600',
  emerald: 'bg-emerald-500',
  green: 'bg-green-500',
  amber: 'bg-amber-500',
  purple: 'bg-purple-500',
  red: 'bg-red-500',
  indigo: 'bg-indigo-500',
}

const offColors: Record<string, string> = {
  sm: 'bg-zinc-700',
  md: 'bg-zinc-700',
  lg: 'bg-zinc-600',
}

/*
  Size presets:
  - sm:  w-9 h-5, knob w-4 h-4, travel translate-x-4 (absolute positioning)
  - md:  w-10 h-5, knob w-4 h-4, travel translate-x-5 (absolute positioning)
  - lg:  h-6 w-11, knob h-4 w-4, travel translate-x-6 (inline-flex positioning)
*/
</script>

<template>
  <!-- sm: compact for list rows -->
  <button
    v-if="size === 'sm'"
    type="button"
    :class="[
      'relative w-9 h-5 rounded-full transition-colors shrink-0',
      modelValue ? onColors[color] : offColors[size],
      disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
    ]"
    :disabled="disabled"
    @click="toggle"
  >
    <span
      :class="[
        'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform',
        modelValue ? 'translate-x-4' : 'translate-x-0',
      ]"
    />
  </button>

  <!-- md: for dialogs / forms -->
  <button
    v-else-if="size === 'md'"
    type="button"
    :class="[
      'relative w-10 h-5 rounded-full transition-colors shrink-0',
      modelValue ? onColors[color] : offColors[size],
      disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
    ]"
    :disabled="disabled"
    @click="toggle"
  >
    <span
      :class="[
        'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform',
        modelValue ? 'translate-x-5' : 'translate-x-0',
      ]"
    />
  </button>

  <!-- lg: settings cards (default) -->
  <button
    v-else
    type="button"
    :class="[
      'relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0',
      modelValue ? onColors[color] : offColors[size],
      disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
    ]"
    :disabled="disabled"
    @click="toggle"
  >
    <span
      :class="[
        'inline-block h-4 w-4 rounded-full bg-white transition-transform',
        modelValue ? 'translate-x-6' : 'translate-x-1',
      ]"
    />
  </button>
</template>
