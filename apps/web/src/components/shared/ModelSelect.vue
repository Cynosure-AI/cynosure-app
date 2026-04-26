<script setup lang="ts">
import { computed } from 'vue'
import CustomSelect, { type SelectOption, type SelectOptionGroup } from './CustomSelect.vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    models: string[]
    /** Prepend an entry with value='' representing "no specific model" */
    includeDefault?: boolean
    /** Label for the default entry */
    defaultLabel?: string
    /** Disable the default entry when a parent setting makes it invalid */
    disableDefault?: boolean
    /** Extra options inserted after the default entry and before models */
    leadingOptions?: SelectOption[]
    placeholder?: string
    maxHeight?: string
    filterable?: boolean
    dropUp?: boolean
    align?: 'left' | 'center' | 'right'
    dropdownWidth?: string
    size?: 'sm' | 'md'
  }>(),
  {
    includeDefault: false,
    defaultLabel: 'Use provider default',
    disableDefault: false,
    leadingOptions: () => [],
    placeholder: 'Select a model…',
    maxHeight: 'max-h-80',
    filterable: true,
    dropUp: false,
    align: 'left',
    dropdownWidth: 'w-full',
    size: 'md',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
}>()

const groups = computed((): SelectOptionGroup[] => {
  const modelOptions = props.models.map((m) => ({ value: m, label: m }))

  if (props.includeDefault) {
    return [{
      options: [
        { value: '', label: props.defaultLabel, iconName: 'lucide:settings', disabled: props.disableDefault },
        ...props.leadingOptions,
        ...modelOptions,
      ],
    }]
  }

  return [{ options: modelOptions }]
})
</script>

<template>
  <CustomSelect
    :model-value="modelValue"
    :groups="groups"
    :placeholder="placeholder"
    :max-height="maxHeight"
    :filterable="filterable"
    :drop-up="dropUp"
    :align="align"
    :dropdown-width="dropdownWidth"
    :size="size"
    @update:model-value="emit('update:modelValue', $event)"
    @change="emit('change', $event)"
  />
</template>
