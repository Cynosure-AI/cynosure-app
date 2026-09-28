<script setup lang="ts" generic="T extends string">
import { Icon } from '@iconify/vue'

export interface TabDef<V extends string = string> {
  value: V
  label: string
  icon?: string
  badge?: string | number
  warning?: string
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
  <div
    role="tablist"
    class="w-full flex gap-1 border-b border-theme-800 overflow-x-auto overflow-y-hidden scrollbar-none"
  >
    <button
      v-for="tab in props.tabs"
      :key="tab.value"
      type="button"
      role="tab"
      :aria-selected="modelValue === tab.value"
      :tabindex="modelValue === tab.value ? 0 : -1"
      class="shrink-0 whitespace-nowrap flex items-center gap-2 px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px"
      :class="modelValue === tab.value
        ? 'text-accent-fg border-accent-400'
        : 'text-theme-500 border-transparent hover:text-theme-300'"
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
        class="text-xs px-1.5 py-0.5 rounded-full bg-theme-700 text-theme-300"
      >
        {{ tab.badge }}
      </span>
      <Icon
        v-if="tab.warning"
        icon="lucide:alert-triangle"
        class="h-3.5 w-3.5 shrink-0 text-status-warning"
        :title="tab.warning"
        :aria-label="tab.warning"
      />
    </button>
  </div>
</template>
