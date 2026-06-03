<script setup lang="ts">
import { computed } from 'vue'
import CustomSelect, { type SelectOption, type SelectOptionGroup, type SelectSize } from './CustomSelect.vue'
import { useProviderLogos } from '../../composables/useProviderLogos'

const props = withDefaults(
  defineProps<{
    modelValue: string
    providers: { id: string; name: string; type: string }[]
    /** Prepend an entry with value='' representing "no specific provider" */
    includeDefault?: boolean
    /** Label for the default entry */
    defaultLabel?: string
    /** Icon for the default entry */
    defaultIcon?: string
    /** Extra options inserted after the default entry and before providers */
    leadingOptions?: SelectOption[]
    placeholder?: string
    maxHeight?: string
    dropUp?: boolean
    align?: 'left' | 'center' | 'right'
    dropdownWidth?: string
    size?: SelectSize
  }>(),
  {
    includeDefault: false,
    defaultLabel: 'Use agent default',
    defaultIcon: 'lucide:settings',
    leadingOptions: () => [],
    placeholder: 'Select a provider…',
    maxHeight: 'max-h-80',
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

const { logoUrl } = useProviderLogos()

const groups = computed((): SelectOptionGroup[] => {
  const providerOptions = props.providers.map((p) => ({
    value: p.id,
    label: p.name,
    imgSrc: logoUrl(p.type),
  }))

  if (props.includeDefault) {
    return [{
      options: [
        { value: '', label: props.defaultLabel, iconName: props.defaultIcon },
        ...props.leadingOptions,
        ...providerOptions,
      ],
    }]
  }

  return [{ options: providerOptions }]
})
</script>

<template>
  <CustomSelect
    :model-value="modelValue"
    :groups="groups"
    :placeholder="placeholder"
    :max-height="maxHeight"
    :drop-up="dropUp"
    :align="align"
    :dropdown-width="dropdownWidth"
    :size="size"
    @update:model-value="emit('update:modelValue', $event)"
    @change="emit('change', $event)"
  />
</template>
