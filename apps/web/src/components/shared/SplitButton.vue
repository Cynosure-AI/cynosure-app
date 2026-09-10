<script setup lang="ts">
import { ref } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { Icon } from '@iconify/vue'

withDefaults(defineProps<{
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

const emit = defineEmits<{ primary: [] }>()
const root = ref<HTMLElement | null>(null)
const open = ref(false)

onClickOutside(root, () => { open.value = false })

function close(): void {
  open.value = false
}
</script>

<template>
  <div
    ref="root"
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
    <Transition
      enter-active-class="transition duration-100 ease-out"
      leave-active-class="transition duration-75 ease-in"
      enter-from-class="translate-y-1 opacity-0"
      leave-to-class="translate-y-1 opacity-0"
    >
      <div
        v-if="open"
        class="absolute right-0 z-30 min-w-48 overflow-hidden rounded-xl border border-theme-700 bg-theme-900 p-1.5 shadow-2xl shadow-black/40"
        :class="placement === 'above' ? 'bottom-full mb-2' : 'top-full mt-2'"
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
  </div>
</template>
