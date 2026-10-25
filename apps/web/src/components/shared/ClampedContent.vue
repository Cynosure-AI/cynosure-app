<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Icon } from '@iconify/vue'

const props = withDefaults(defineProps<{ maxHeight?: number }>(), { maxHeight: 200 })

const content = ref<HTMLElement>()
const expanded = ref(false)
const overflowing = ref(false)
let observer: ResizeObserver | undefined

// Measured against the collapsed height, so the toggle stays while expanded.
function measure(): void {
  if (content.value) overflowing.value = content.value.scrollHeight > props.maxHeight + 1
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(measure)
  if (content.value) observer.observe(content.value)
})

onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div>
    <div
      :class="expanded ? 'custom-scrollbar overflow-auto' : ['overflow-hidden', { 'clamped-fade': overflowing }]"
      :style="{ maxHeight: expanded ? '60vh' : `${maxHeight}px` }"
    >
      <div ref="content">
        <slot />
      </div>
    </div>
    <button
      v-if="overflowing"
      type="button"
      class="clamped-toggle mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-ink-muted transition-colors hover:bg-theme-700/40 hover:text-theme-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      {{ expanded ? 'Show less' : 'Show more' }}
      <Icon
        icon="lucide:chevron-down"
        class="h-3 w-3 transition-transform"
        :class="{ 'rotate-180': expanded }"
      />
    </button>
  </div>
</template>

<style scoped>
/* A mask fades the clipped edge on any background. */
.clamped-fade {
  mask-image: linear-gradient(to bottom, #000 calc(100% - 2.5rem), transparent);
}
</style>
