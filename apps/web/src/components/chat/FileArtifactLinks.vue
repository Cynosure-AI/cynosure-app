<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import { fileArtifactKey, fileArtifactLinks, type FileArtifactLink } from '../../utils/file-artifacts'

const props = defineProps<{
  text?: string
  artifacts?: FileArtifactLink[]
  excludeHrefs?: string[]
  compact?: boolean
  limit?: number
}>()

const links = computed(() => {
  const excluded = new Set((props.excludeHrefs || []).map(fileArtifactKey))
  const candidates = props.artifacts || fileArtifactLinks(props.text || '')
  if (!excluded.size) return candidates
  return candidates.filter((artifact) => !excluded.has(fileArtifactKey(artifact.href)))
})

const visibleLinks = computed(() => props.limit === undefined ? links.value : links.value.slice(0, props.limit))

function handleClick(event: MouseEvent): void {
  if (props.compact) event.stopPropagation()
}
</script>

<template>
  <div
    v-if="links.length"
    class="flex flex-wrap gap-2"
    :class="compact ? '' : 'mt-2'"
  >
    <a
      v-for="artifact in visibleLinks"
      :key="artifact.href"
      :href="artifact.href"
      target="_blank"
      rel="noopener noreferrer"
      class="inline-flex max-w-full items-center gap-1.5 rounded-md border border-theme-600/50 bg-theme-900/70 text-theme-300 transition-colors hover:border-accent-500/50 hover:text-accent-200"
      :class="compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]'"
      @click="handleClick"
    >
      <Icon
        icon="lucide:file-text"
        class="h-3.5 w-3.5 shrink-0 text-accent-300"
      />
      <span class="truncate">{{ artifact.label }}</span>
      <span class="shrink-0 rounded bg-theme-700 px-1 py-0.5 text-[9px] text-theme-400">{{ artifact.ext }}</span>
    </a>
    <span
      v-if="limit !== undefined && links.length > limit"
      class="self-center text-[10px] text-theme-500"
    >+{{ links.length - limit }}</span>
  </div>
</template>
