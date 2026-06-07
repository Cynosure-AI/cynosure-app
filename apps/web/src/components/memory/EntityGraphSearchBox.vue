<script setup lang="ts">
import { Icon } from "@iconify/vue";
import type { EntityGraphNode } from "../../api/types";

defineProps<{
  modelValue: string;
  suggestions: EntityGraphNode[];
  placeholder?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  "select-suggestion": [node: EntityGraphNode];
}>();
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
    >
    <div
      v-if="suggestions.length > 0 && modelValue.trim()"
      class="absolute left-0 top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-theme-700 bg-theme-950 shadow-2xl"
    >
      <button
        v-for="node in suggestions"
        :key="node.id"
        type="button"
        class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-theme-300 transition-colors hover:bg-theme-800 hover:text-theme-100"
        @mousedown.prevent="emit('select-suggestion', node)"
      >
        <span class="truncate">{{ node.name }}</span>
        <span class="shrink-0 rounded-md border border-theme-700 bg-theme-900 px-1.5 py-0.5 text-[10px] text-theme-500">
          {{ node.type }}
        </span>
      </button>
    </div>
  </div>
</template>
