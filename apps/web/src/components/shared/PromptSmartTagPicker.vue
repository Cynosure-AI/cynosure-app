<script setup lang="ts">
import { computed } from "vue";
import CustomSelect, {
  type SelectOptionGroup,
} from "./CustomSelect.vue";
import {
  PROMPT_SMART_TAGS,
  formatPromptSmartTag,
} from "../../utils/prompt-smart-tags";

const emit = defineEmits<{
  insert: [value: string];
}>();

const groups = computed<SelectOptionGroup[]>(() => [{
  options: PROMPT_SMART_TAGS.map((tag) => ({
    value: tag.name,
    label: tag.label,
    tag: formatPromptSmartTag(tag.name),
    tooltip: tag.description,
  })),
}]);

function insertTag(name: string): void {
  emit("insert", formatPromptSmartTag(name));
}
</script>

<template>
  <div class="w-44 shrink-0">
    <CustomSelect
      model-value=""
      :groups="groups"
      placeholder="Insert smart tag"
      placeholder-icon="lucide:braces"
      dropdown-width="w-96 max-w-[calc(100vw-2rem)]"
      max-height="max-h-80"
      align="right"
      size="xs"
      filterable
      @change="insertTag"
    />
  </div>
</template>
