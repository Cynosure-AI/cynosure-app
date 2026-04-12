<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { Icon } from '@iconify/vue'

export interface MultiSelectOption {
  value: string
  label: string
  /** Optional secondary text shown to the right */
  hint?: string
}

const props = withDefaults(
  defineProps<{
    modelValue: string[]
    options: MultiSelectOption[]
    placeholder?: string
    /** Minimum number of selected items (default: 0) */
    minSelected?: number
    disabled?: boolean
    /** Max height CSS class for the dropdown list (default: 'max-h-52') */
    maxHeight?: string
  }>(),
  {
    placeholder: 'Select...',
    minSelected: 0,
    maxHeight: 'max-h-52',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const isOpen = ref(false)
const containerRef = ref<HTMLElement | null>(null)
const filterQuery = ref('')

const filteredOptions = computed(() => {
  if (!filterQuery.value.trim()) return props.options
  const q = filterQuery.value.toLowerCase()
  return props.options.filter(
    (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
  )
})

const summary = computed(() => {
  const labels = props.modelValue.map(
    (v) => props.options.find((o) => o.value === v)?.label ?? v,
  )
  if (labels.length === 0) return props.placeholder
  if (labels.length <= 2) return labels.join(', ')
  return `${labels[0]}, ${labels[1]} +${labels.length - 2} more`
})

function isSelected(value: string) {
  return props.modelValue.includes(value)
}

function toggle(value: string) {
  let next: string[]
  if (isSelected(value)) {
    next = props.modelValue.filter((v) => v !== value)
    if (next.length < props.minSelected) return
  } else {
    next = [...props.modelValue, value]
  }
  emit('update:modelValue', next)
}

function handleClickOutside(e: MouseEvent) {
  if (containerRef.value && !containerRef.value.contains(e.target as Node)) {
    isOpen.value = false
  }
}

onMounted(() => document.addEventListener('mousedown', handleClickOutside))
onBeforeUnmount(() => document.removeEventListener('mousedown', handleClickOutside))
</script>

<template>
  <div
    ref="containerRef"
    class="relative w-full"
  >
    <!-- Trigger -->
    <button
      type="button"
      :disabled="disabled"
      class="w-full flex items-center justify-between bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
      @click="isOpen = !isOpen"
    >
      <span class="truncate">{{ summary }}</span>
      <Icon
        icon="lucide:chevron-down"
        class="w-4 h-4 text-zinc-400 shrink-0 ml-2 transition-transform"
        :class="isOpen ? 'rotate-180' : ''"
      />
    </button>

    <!-- Dropdown -->
    <div
      v-if="isOpen"
      class="absolute z-10 mt-1 w-full rounded border border-zinc-700 bg-zinc-900 shadow-lg"
    >
      <!-- Filter input -->
      <div
        v-if="options.length > 8"
        class="p-1.5 border-b border-zinc-700"
      >
        <input
          v-model="filterQuery"
          type="text"
          placeholder="Filter..."
          class="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-blue-500"
        >
      </div>

      <!-- Options list -->
      <div
        class="overflow-y-auto"
        :class="maxHeight"
      >
        <label
          v-for="opt in filteredOptions"
          :key="opt.value"
          class="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-800 cursor-pointer text-sm text-zinc-300"
        >
          <input
            type="checkbox"
            :checked="isSelected(opt.value)"
            class="accent-blue-500"
            @change="toggle(opt.value)"
          >
          <span>{{ opt.label }}</span>
          <span
            v-if="opt.hint"
            class="text-zinc-500 text-xs ml-auto"
          >{{ opt.hint }}</span>
        </label>
        <div
          v-if="filteredOptions.length === 0"
          class="px-3 py-2 text-xs text-zinc-500"
        >
          No matches
        </div>
      </div>
    </div>
  </div>
</template>
