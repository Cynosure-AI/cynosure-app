<script setup lang="ts">
/**
 * Types `text` out one character at a time behind a caret, then blinks the
 * caret away. Every character is laid out from the start and only revealed,
 * so centered or wrapping text never shifts while it types. Pure CSS timing:
 * nothing to clean up, and it replays whenever the component remounts.
 * Screen readers get the whole text at once; reduced motion shows it at once.
 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  text: string
  /** Milliseconds before the first character appears. */
  start?: number
  /** Milliseconds between characters. */
  step?: number
}>(), { start: 0, step: 45 })

const words = computed(() => {
  let offset = 0
  return props.text.split(' ').map((word) => {
    const entry = { chars: [...word], offset }
    offset += entry.chars.length + 1
    return entry
  })
})

const lastIndex = computed(() => [...props.text].length - 1)

function charStyle(index: number) {
  return { '--tw-delay': `${props.start + index * props.step}ms` }
}
</script>

<template>
  <span
    class="typewriter"
    :style="{ '--tw-step': `${step}ms` }"
  >
    <span class="sr-only">{{ text }}</span>
    <span aria-hidden="true"><template
      v-for="(word, w) in words"
      :key="w"
    ><span
      v-if="w > 0"
      class="tw-char"
      :class="{ 'tw-char--last': word.offset - 1 === lastIndex }"
      :style="charStyle(word.offset - 1)"
    >{{ ' ' }}</span><span class="whitespace-nowrap"><span
      v-for="(char, c) in word.chars"
      :key="c"
      class="tw-char"
      :class="{ 'tw-char--last': word.offset + c === lastIndex }"
      :style="charStyle(word.offset + c)"
    >{{ char }}</span></span></template></span>
  </span>
</template>

<style scoped>
.tw-char {
  position: relative;
}

@media (prefers-reduced-motion: no-preference) {
  .tw-char {
    opacity: 0;
    animation: tw-reveal 1ms var(--tw-delay) forwards;
  }

  /* The caret rides just behind the newest character, then blinks out. */
  .tw-char::after {
    content: "";
    position: absolute;
    top: 0.14em;
    bottom: 0.1em;
    left: 100%;
    width: var(--tw-caret-width, 0.08em);
    min-width: 2px;
    margin-left: 0.04em;
    background: currentColor;
    opacity: 0;
    animation: tw-caret var(--tw-step) var(--tw-delay) steps(1);
  }

  .tw-char--last::after {
    animation: tw-caret-tail 1400ms var(--tw-delay) steps(1);
  }
}

@keyframes tw-reveal {
  to {
    opacity: 1;
  }
}

@keyframes tw-caret {
  from,
  to {
    opacity: var(--tw-caret-opacity, 0.9);
  }
}

@keyframes tw-caret-tail {
  0%,
  28%,
  56% {
    opacity: var(--tw-caret-opacity, 0.9);
  }
  14%,
  42%,
  70%,
  100% {
    opacity: 0;
  }
}
</style>
