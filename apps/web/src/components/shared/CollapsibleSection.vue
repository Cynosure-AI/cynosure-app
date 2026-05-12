<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'

let collapsibleId = 0

const props = withDefaults(
  defineProps<{
    modelValue?: boolean
    defaultExpanded?: boolean
    unmountOnCollapse?: boolean
    persistKey?: string
    headerLabel?: string
    headerIcon?: string
    headerClass?: string
    headerTextClass?: string
    chevronClass?: string
    chevronIcon?: string
    keyboardShortcuts?: boolean
  }>(),
  {
    modelValue: undefined,
    defaultExpanded: false,
    unmountOnCollapse: true,
    persistKey: undefined,
    headerLabel: 'Details',
    headerIcon: undefined,
    headerClass:
      'flex w-full items-center gap-2 px-3 py-2 text-left text-sm rounded-lg transition-colors border border-theme-700/40 bg-theme-800/50 hover:bg-theme-800 hover:border-theme-700/60',
    headerTextClass: 'font-medium text-theme-300',
    chevronClass: 'w-3.5 h-3.5 text-theme-500',
    chevronIcon: 'lucide:chevron-down',
    keyboardShortcuts: false,
  }
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  toggle: [value: boolean]
}>()

const localExpanded = ref(props.defaultExpanded)

if (props.persistKey && typeof window !== 'undefined') {
  try {
    const raw = window.localStorage.getItem(props.persistKey)
    if (raw === '1') localExpanded.value = true
    if (raw === '0') localExpanded.value = false
  } catch {
    // Ignore storage errors in restricted environments.
  }
}

const expanded = computed(() =>
  props.modelValue === undefined ? localExpanded.value : props.modelValue
)

const triggerId = `collapsible-trigger-${++collapsibleId}`
const contentId = `collapsible-content-${collapsibleId}`

const triggerAttrs = computed(() => ({
  id: triggerId,
  type: 'button' as const,
  'aria-expanded': expanded.value,
  'aria-controls': contentId,
}))

const contentAttrs = computed(() => ({
  id: contentId,
  role: 'region',
  'aria-labelledby': triggerId,
}))

function setExpanded(next: boolean): void {
  if (props.modelValue === undefined) {
    localExpanded.value = next
  }
  emit('update:modelValue', next)
  emit('toggle', next)
}

function toggle(): void {
  setExpanded(!expanded.value)
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (!props.keyboardShortcuts) return
  if (event.ctrlKey && event.key === 'Enter') {
    event.preventDefault()
    toggle()
    return
  }
  if (event.altKey && event.key === 'ArrowDown') {
    event.preventDefault()
    setExpanded(true)
    return
  }
  if (event.altKey && event.key === 'ArrowUp') {
    event.preventDefault()
    setExpanded(false)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    setExpanded(false)
  }
}

watch(
  expanded,
  (value) => {
    if (!props.persistKey || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(props.persistKey, value ? '1' : '0')
    } catch {
      // Ignore storage errors in restricted environments.
    }
  },
  { immediate: true }
)
</script>

<template>
  <slot
    name="trigger"
    :expanded="expanded"
    :toggle="toggle"
    :trigger-attrs="triggerAttrs"
    :on-trigger-keydown="onTriggerKeydown"
  >
    <button
      v-bind="triggerAttrs"
      :class="headerClass"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <Icon
        v-if="headerIcon"
        :icon="headerIcon"
        class="w-3.5 h-3.5 shrink-0 text-theme-400"
      />
      <span :class="headerTextClass">{{ headerLabel }}</span>
      <slot
        name="header-extra"
        :expanded="expanded"
      />
      <Icon
        :icon="chevronIcon"
        :class="[chevronClass, 'ml-auto shrink-0 transition-transform', { 'rotate-180': expanded }]"
      />
    </button>
  </slot>

  <Transition
    enter-active-class="transition-all duration-200 ease-out"
    enter-from-class="opacity-0 -translate-y-1"
    enter-to-class="opacity-100 translate-y-0"
    leave-active-class="transition-all duration-150 ease-in"
    leave-from-class="opacity-100 translate-y-0"
    leave-to-class="opacity-0 -translate-y-1"
  >
    <div
      v-if="expanded || !unmountOnCollapse"
      v-show="expanded"
      v-bind="contentAttrs"
    >
      <slot :expanded="expanded" />
    </div>
  </Transition>
</template>
