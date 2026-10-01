<script setup lang="ts">
import { Icon } from '@iconify/vue'
import CollapsibleSection from '../shared/CollapsibleSection.vue'
import RichContent from '../shared/RichContent.vue'

defineProps<{ content: string }>()
const model = defineModel<boolean>({ required: true })
</script>

<template>
  <CollapsibleSection
    v-model="model"
    :keyboard-shortcuts="true"
  >
    <template #trigger="{ expanded, toggle, triggerAttrs, onTriggerKeydown }">
      <button
        v-bind="triggerAttrs"
        class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs transition-colors group"
        :class="expanded
          ? 'bg-theme-800/80 border border-theme-700/60'
          : 'bg-theme-800/40 hover:bg-theme-800/70 border border-theme-800/40 hover:border-theme-700/40'"
        @click="toggle"
        @keydown="onTriggerKeydown"
      >
        <Icon
          icon="lucide:wrench"
          class="w-3.5 h-3.5 text-ink-muted shrink-0"
        />
        <span class="text-ink-secondary truncate flex-1 text-left">
          {{ content.slice(0, 80) }}{{ content.length > 80 ? '…' : '' }}
        </span>
        <Icon
          icon="lucide:chevron-down"
          class="w-3 h-3 text-ink-faint shrink-0 transition-transform"
          :class="{ 'rotate-180': expanded }"
        />
      </button>
    </template>
    <div class="mt-1.5 ml-3">
      <RichContent
        :content="content"
        class="max-h-60 rounded-lg border border-theme-700/30 bg-theme-900/60 px-3 py-2 text-[10px]"
      />
    </div>
  </CollapsibleSection>
</template>
