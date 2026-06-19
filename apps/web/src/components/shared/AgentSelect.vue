<script setup lang="ts">
import { computed } from 'vue'
import CustomSelect, { type SelectOptionGroup, type SelectSize } from './CustomSelect.vue'
import { useProviderStore } from '../../stores/provider.store'
import { useProviderLogos } from '../../composables/useProviderLogos'
import type { AgentDefinition } from '../../api/types'

const props = withDefaults(
  defineProps<{
    modelValue: string
    agents: AgentDefinition[]
    /** Prepend an entry with value='' representing "no specific agent" */
    includeDefault?: boolean
    /** Label for the default entry */
    defaultLabel?: string
    /** Icon for the default entry */
    defaultIcon?: string
    /**
     * When set, agents are placed in a labeled group with this label.
     * Useful when pairing with a "Default" entry in a separate group above.
     */
    agentsGroupLabel?: string
    placeholder?: string
    maxHeight?: string
    filterable?: boolean
    dropUp?: boolean
    align?: 'left' | 'center' | 'right'
    dropdownWidth?: string
    size?: SelectSize
  }>(),
  {
    includeDefault: false,
    defaultLabel: 'Default',
    defaultIcon: 'lucide:message-square',
    agentsGroupLabel: undefined,
    placeholder: 'Select an agent…',
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

const providerStore = useProviderStore()
const { logoUrl } = useProviderLogos()

function agentSort(a: AgentDefinition, b: AgentDefinition): number {
  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)
}

const groups = computed((): SelectOptionGroup[] => {
  const sorted = [...props.agents].sort(agentSort)

  const agentOptions = sorted.map((a) => {
    let imgSrc: string | null = a.iconUrl || null
    if (!imgSrc && a.providerId) {
      const prov = providerStore.providers.find((p) => p.id === a.providerId)
      if (prov) imgSrc = logoUrl(prov.type)
    }
    return {
      value: a.id,
      label: a.name,
      imgSrc,
      tooltip: a.description || undefined,
      tag: a.favorite ? 'Favorite' : (a.subAgents?.length ? `+${a.subAgents.length}` : undefined),
    }
  })

  if (props.includeDefault) {
    const defaultOption = {
      value: '',
      label: props.defaultLabel,
      iconName: props.defaultIcon,
    }
    return [
      { options: [defaultOption] },
      { label: props.agentsGroupLabel, options: agentOptions },
    ]
  }

  return [{ label: props.agentsGroupLabel, options: agentOptions }]
})
</script>

<template>
  <CustomSelect
    :model-value="modelValue"
    :groups="groups"
    :placeholder="placeholder"
    placeholder-icon="lucide:bot"
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
