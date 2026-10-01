<script setup lang="ts">
import { ref } from 'vue'
import { Icon } from '@iconify/vue'

withDefaults(defineProps<{ icon: string; src?: string; iconClass?: string }>(), {
  src: undefined,
  iconClass: 'h-3 w-3',
})
const brokenSrc = ref<string | undefined>()
</script>

<template>
  <span
    class="flex shrink-0 items-center justify-center overflow-hidden rounded-full"
    aria-hidden="true"
  >
    <img
      v-if="src && src !== brokenSrc"
      :src="src"
      alt=""
      class="h-full w-full object-contain"
      @error="brokenSrc = src"
    >
    <Icon
      v-else
      :icon="icon"
      :class="iconClass"
    />
  </span>
</template>
