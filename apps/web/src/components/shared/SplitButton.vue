<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { Icon } from '@iconify/vue'

defineOptions({ inheritAttrs: false })

const emit = defineEmits<{ primary: [] }>()
const root = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const open = ref(false)
const positionTick = ref(0)

onClickOutside(root, () => { open.value = false }, { ignore: [menu] })

const menuStyle = computed(() => {
  void positionTick.value
  const rect = root.value?.getBoundingClientRect()
  if (!rect) return { top: '0', left: '0' }
  const right = Math.max(8, window.innerWidth - rect.right)
  return props.placement === 'above'
    ? { bottom: `${window.innerHeight - rect.top + 8}px`, right: `${right}px` }
    : { top: `${rect.bottom + 8}px`, right: `${right}px` }
})

const props = withDefaults(defineProps<{
  disabled?: boolean
  title?: string
  primaryLabel: string
  menuLabel: string
  placement?: 'above' | 'below'
}>(), {
  disabled: false,
  title: undefined,
  placement: 'below',
})

function close(): void {
  open.value = false
}

function updatePosition(): void {
  if (open.value) positionTick.value++
}

onMounted(() => {
  window.addEventListener('resize', updatePosition)
  window.addEventListener('scroll', updatePosition, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updatePosition)
  window.removeEventListener('scroll', updatePosition, true)
})
</script>

<template>
  <div
    ref="root"
    v-bind="$attrs"
    class="relative inline-flex shrink-0"
  >
    <button
      type="button"
      :disabled="disabled"
      class="inline-flex items-center gap-1.5 rounded-l-lg bg-accent-600 px-2.5 py-1 text-white transition-colors hover:bg-accent-500 disabled:cursor-not-allowed disabled:bg-theme-700 disabled:text-theme-500 focus:z-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-300"
      :title="title"
      :aria-label="primaryLabel"
      @click="emit('primary')"
    >
      <slot />
    </button>
    <button
      type="button"
      :disabled="disabled"
      class="inline-flex w-7 items-center justify-center rounded-r-lg border-l border-white/20 bg-accent-600 text-white transition-colors hover:bg-accent-500 disabled:cursor-not-allowed disabled:border-theme-600 disabled:bg-theme-700 disabled:text-theme-500 focus:z-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-300"
      title="More options"
      :aria-label="menuLabel"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
      @keydown.esc="close"
    >
      <Icon
        icon="lucide:chevron-down"
        class="h-3.5 w-3.5"
      />
    </button>
  </div>

  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-100 ease-out"
      leave-active-class="transition duration-75 ease-in"
      enter-from-class="translate-y-1 opacity-0"
      leave-to-class="translate-y-1 opacity-0"
    >
      <div
        v-if="open"
        ref="menu"
        class="fixed z-50 min-w-48 overflow-hidden rounded-xl border border-theme-700 bg-theme-900 p-1.5 shadow-2xl shadow-black/40"
        :style="menuStyle"
        role="menu"
        :aria-label="menuLabel"
        @keydown.esc="close"
      >
        <slot
          name="menu"
          :close="close"
        />
      </div>
    </Transition>
  </Teleport>
</template>
