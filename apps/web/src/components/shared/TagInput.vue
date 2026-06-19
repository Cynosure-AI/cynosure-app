<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Icon } from "@iconify/vue";

const props = withDefaults(
  defineProps<{
    modelValue: string[];
    suggestions?: string[];
    placeholder?: string;
    inputClass?: string;
  }>(),
  {
    suggestions: () => [],
    placeholder: "Type a tag and press Enter",
    inputClass: "",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string[]];
}>();

const inputValue = ref("");
const activeIndex = ref(0);

function normalizeTag(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function tagKey(value: string): string {
  return normalizeTag(value).toLowerCase();
}

const selectedKeys = computed(() => new Set(props.modelValue.map(tagKey)));

const filteredSuggestions = computed(() => {
  const query = tagKey(inputValue.value);
  if (!query) return [];

  const seen = new Set<string>();
  return props.suggestions
    .map(normalizeTag)
    .filter(Boolean)
    .filter((tag) => {
      const key = tag.toLowerCase();
      if (selectedKeys.value.has(key) || seen.has(key)) return false;
      seen.add(key);
      return key.includes(query);
    })
    .slice(0, 8);
});

const showSuggestions = computed(() => inputValue.value.trim().length > 0 && filteredSuggestions.value.length > 0);

watch(filteredSuggestions, () => {
  activeIndex.value = 0;
});

function emitTags(tags: string[]): void {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const raw of tags) {
    const tag = normalizeTag(raw);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }

  emit("update:modelValue", result);
}

function addTag(value = inputValue.value): void {
  const tag = normalizeTag(value);
  if (!tag) return;

  emitTags([...props.modelValue, tag]);
  inputValue.value = "";
}

function addInputTags(): void {
  const tags = inputValue.value.split(",").map(normalizeTag).filter(Boolean);
  if (!tags.length) return;
  emitTags([...props.modelValue, ...tags]);
  inputValue.value = "";
}

function removeTag(tag: string): void {
  const key = tagKey(tag);
  emitTags(props.modelValue.filter((item) => tagKey(item) !== key));
}

function selectSuggestion(tag: string): void {
  addTag(tag);
}

function selectActiveSuggestion(): boolean {
  if (!showSuggestions.value) return false;
  const tag = filteredSuggestions.value[activeIndex.value];
  if (!tag) return false;
  selectSuggestion(tag);
  return true;
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown" && showSuggestions.value) {
    event.preventDefault();
    activeIndex.value = (activeIndex.value + 1) % filteredSuggestions.value.length;
    return;
  }

  if (event.key === "ArrowUp" && showSuggestions.value) {
    event.preventDefault();
    activeIndex.value = (activeIndex.value - 1 + filteredSuggestions.value.length) % filteredSuggestions.value.length;
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    if (!selectActiveSuggestion()) addInputTags();
    return;
  }

  if (event.key === "Backspace" && !inputValue.value && props.modelValue.length) {
    removeTag(props.modelValue[props.modelValue.length - 1]);
  }
}
</script>

<template>
  <div class="space-y-2">
    <div class="relative">
      <input
        v-model="inputValue"
        type="text"
        :placeholder="placeholder"
        class="w-full px-3 py-2 bg-theme-900 border border-theme-700 rounded-lg text-sm text-theme-200 placeholder:text-theme-600 focus:outline-none focus:ring-1 focus:ring-accent-500"
        :class="inputClass"
        @keydown="handleKeydown"
      >
      <div
        v-if="showSuggestions"
        class="absolute left-0 top-full z-30 mt-1 w-full overflow-hidden rounded-lg border border-theme-700 bg-theme-950 shadow-2xl"
      >
        <button
          v-for="(tag, index) in filteredSuggestions"
          :key="tag"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-theme-300 transition-colors hover:bg-theme-800 hover:text-theme-100"
          :class="{ 'bg-theme-800 text-theme-100': index === activeIndex }"
          @mouseenter="activeIndex = index"
          @mousedown.prevent.stop="selectSuggestion(tag)"
        >
          <Icon
            icon="lucide:tag"
            class="h-3.5 w-3.5 text-theme-500"
          />
          <span class="truncate">{{ tag }}</span>
        </button>
      </div>
    </div>

    <div
      v-if="modelValue.length"
      class="flex flex-wrap gap-2"
    >
      <span
        v-for="tag in modelValue"
        :key="tag"
        class="inline-flex items-center gap-1.5 rounded-full border border-theme-700 bg-theme-900/70 px-2.5 py-1 text-xs text-theme-300"
      >
        {{ tag }}
        <button
          type="button"
          class="rounded-full p-0.5 text-theme-500 transition-colors hover:bg-theme-700 hover:text-theme-200"
          :aria-label="`Remove ${tag} tag`"
          @click="removeTag(tag)"
        >
          <Icon
            icon="lucide:x"
            class="h-3 w-3"
          />
        </button>
      </span>
    </div>
  </div>
</template>
