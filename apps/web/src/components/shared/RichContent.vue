<script setup lang="ts">
/* eslint-disable vue/no-v-html -- renderMarkdown sanitizes untrusted content before rendering. */
import { computed } from 'vue'
import { formatRichContent } from '../../utils/rich-content'
import { handleMarkdownClick, renderMarkdown } from '../../utils/markdown'

const props = defineProps<{
  content: unknown
  tone?: 'default' | 'muted' | 'error'
}>()

const formatted = computed(() => formatRichContent(props.content))
const rendered = computed(() => renderMarkdown(formatted.value.markdown))
</script>

<template>
  <div
    class="rich-content msg-markdown min-w-0 overflow-auto text-xs leading-relaxed"
    :class="[
      `rich-content--${formatted.kind}`,
      tone === 'error' ? 'text-red-700 dark:text-red-300' : tone === 'muted' ? 'text-theme-500' : 'text-theme-300',
    ]"
    :data-content-kind="formatted.kind"
    @click="handleMarkdownClick"
    v-html="rendered"
  />
</template>

<style scoped>
.rich-content {
  overflow-wrap: anywhere;
}

.rich-content :deep(> :first-child) {
  margin-top: 0;
}

.rich-content :deep(> :last-child) {
  margin-bottom: 0;
}

.rich-content :deep(.code-block-wrapper) {
  margin: 0;
}

.rich-content :deep(pre) {
  max-height: inherit;
  overflow: auto;
}
</style>
