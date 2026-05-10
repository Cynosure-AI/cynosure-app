<script setup lang="ts" generic="T extends string">
import { Icon } from '@iconify/vue'

export interface TabDef<V extends string = string> {
  value: V
  label: string
  icon?: string
  badge?: string | number
}

const props = defineProps<{
  tabs: TabDef<T>[]
  modelValue: T
}>()

const emit = defineEmits<{
  'update:modelValue': [value: T]
}>()
</script>

<template>
  <div class="w-full flex gap-1 border-b border-zinc-800 overflow-x-auto overflow-y-hidden scrollbar-none">
    <button
      v-for="tab in props.tabs"
      :key="tab.value"
      class="shrink-0 whitespace-nowrap flex items-center gap-2 px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px"
      :class="modelValue === tab.value
        ? 'text-blue-400 border-blue-400'
        : 'text-zinc-500 border-transparent hover:text-zinc-300'"
      @click="emit('update:modelValue', tab.value)"
    >
      <Icon
        v-if="tab.icon"
        :icon="tab.icon"
        class="w-4 h-4"
      />
      <slot :name="`tab-icon-${tab.value}`" />
      {{ tab.label }}
      <span
        v-if="tab.badge != null && tab.badge !== '' && tab.badge !== 0"
        class="text-xs px-1.5 py-0.5 rounded-full bg-zinc-700 text-zinc-300"
      >
        {{ tab.badge }}
      </span>
    </button>
  </div>
</template>
