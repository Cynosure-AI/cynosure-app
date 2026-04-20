<script setup lang="ts">
import { computed } from 'vue'
import CustomSelect, { type SelectOptionGroup } from './CustomSelect.vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    models: string[]
    /** Prepend an entry with value='' representing "no specific model" */
    includeDefault?: boolean
    /** Label for the default entry */
    defaultLabel?: string
    placeholder?: string
    maxHeight?: string
    filterable?: boolean
    dropUp?: boolean
    align?: 'left' | 'center' | 'right'
    dropdownWidth?: string
  }>(),
  {
    includeDefault: false,
    defaultLabel: 'Use provider default',
    placeholder: 'Select a model…',
    maxHeight: 'max-h-80',
    filterable: true,
    dropUp: false,
    align: 'left',
    dropdownWidth: 'w-full',
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
        { value: '', label: props.defaultLabel, iconName: 'lucide:settings' },
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
    @update:model-value="emit('update:modelValue', $event)"
    @change="emit('change', $event)"
  />
</template>
