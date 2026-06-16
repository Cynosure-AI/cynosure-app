<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { Icon } from "@iconify/vue";
import {
  PROMPT_SMART_TAGS,
  formatPromptSmartTag,
  type PromptSmartTag,
} from "../../utils/prompt-smart-tags";

const emit = defineEmits<{
  insert: [value: string];
}>();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);

function insertTag(tag: PromptSmartTag): void {
  emit("insert", formatPromptSmartTag(tag.name));
  open.value = false;
}

function handleClickOutside(e: MouseEvent): void {
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) {
    open.value = false;
  }
}

onMounted(() => document.addEventListener("mousedown", handleClickOutside));
onBeforeUnmount(() =>
  document.removeEventListener("mousedown", handleClickOutside),
);
</script>

<template>
  <div
    ref="rootRef"
    class="relative"
  >
    <button
      type="button"
      class="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-theme-700 bg-theme-900 text-theme-300 hover:bg-theme-800 hover:text-theme-100 transition-colors"
      title="Insert smart tag"
      @click="open = !open"
    >
      <Icon
        icon="lucide:braces"
        class="w-3.5 h-3.5"
      />
      Smart tags
      <Icon
        icon="lucide:chevron-down"
        class="w-3 h-3 text-theme-500 transition-transform"
        :class="{ 'rotate-180': open }"
      />
    </button>

    <div
      v-if="open"
      class="absolute right-0 z-50 mt-1 w-100 max-h-80 overflow-y-auto rounded-lg border border-theme-700 bg-theme-900 shadow-xl py-1"
    >
      <button
        v-for="tag in PROMPT_SMART_TAGS"
        :key="tag.name"
        type="button"
        class="w-full text-left px-3 py-2 hover:bg-theme-800 transition-colors"
        :title="tag.description"
        @click="insertTag(tag)"
      >
        <div class="flex items-center justify-between gap-3">
          <span class="text-sm text-theme-200 truncate">{{ tag.label }}</span>
          <code class="text-xs text-accent-300 shrink-0">{{ formatPromptSmartTag(tag.name) }}</code>
        </div>
        <div class="text-xs text-theme-500 mt-0.5 line-clamp-2">
          {{ tag.description }}
        </div>
      </button>
    </div>
  </div>
</template>
