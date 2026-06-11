<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Icon } from "@iconify/vue";
import type { EntityGraphNode } from "../../api/types";

const props = defineProps<{
  modelValue: string;
  suggestions: EntityGraphNode[];
  placeholder?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  "select-suggestion": [node: EntityGraphNode];
}>();

const activeIndex = ref(0);
const hasQuery = computed(() => props.modelValue.trim().length > 0);
const showSuggestions = computed(() => hasQuery.value && props.suggestions.length > 0);

watch(() => props.suggestions, () => {
  activeIndex.value = 0;
});

function clampActiveIndex() {
  if (props.suggestions.length === 0) {
    activeIndex.value = 0;
    return;
  }
  activeIndex.value = Math.min(Math.max(activeIndex.value, 0), props.suggestions.length - 1);
}

function selectNode(node: EntityGraphNode) {
  emit("select-suggestion", node);
}

function selectActiveSuggestion() {
  if (!showSuggestions.value) return false;
  clampActiveIndex();
  const node = props.suggestions[activeIndex.value];
  if (!node) return false;
  selectNode(node);
  return true;
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown" && showSuggestions.value) {
    event.preventDefault();
    activeIndex.value = (activeIndex.value + 1) % props.suggestions.length;
    return;
  }
  if (event.key === "ArrowUp" && showSuggestions.value) {
    event.preventDefault();
    activeIndex.value = (activeIndex.value - 1 + props.suggestions.length) % props.suggestions.length;
    return;
  }
  if (event.key === "Enter" && selectActiveSuggestion()) {
    event.preventDefault();
    event.stopPropagation();
  }
}
</script>

<template>
  <div class="relative">
    <Icon
      icon="lucide:search"
      class="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-600"
    />
    <input
      :value="modelValue"
      type="text"
      class="w-72 max-w-full pl-8 pr-3 py-2 text-sm bg-theme-950 border border-theme-800 rounded-lg text-theme-200 placeholder-theme-600 focus:outline-none focus:border-theme-600"
      :placeholder="placeholder || 'Search entities'"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown="handleKeydown"
    >
    <div
      v-if="showSuggestions"
      class="absolute left-0 top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-theme-700 bg-theme-950 shadow-2xl"
    >
      <button
        v-for="(node, index) in suggestions"
        :key="node.id"
        type="button"
        class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-theme-300 transition-colors hover:bg-theme-800 hover:text-theme-100"
        :class="{ 'bg-theme-800 text-theme-100': index === activeIndex }"
        @mouseenter="activeIndex = index"
        @mousedown.prevent.stop="selectNode(node)"
      >
        <span class="truncate">{{ node.name }}</span>
        <span class="shrink-0 rounded-md border border-theme-700 bg-theme-900 px-1.5 py-0.5 text-[10px] text-theme-500">
          {{ node.type }}
        </span>
      </button>
    </div>
  </div>
</template>
