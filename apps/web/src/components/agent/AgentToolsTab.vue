<script setup lang="ts">
import { computed } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import type { AgentDefinition } from '../../api/types'
import { useAgentHealthStore } from '../../stores/agent-health.store'
import { Icon } from '@iconify/vue'
import ToolSelector from '../shared/ToolSelector.vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import BaseCard from '../shared/BaseCard.vue'
import { memoryAutomaticToolStates } from '../../utils/internal-tools'
import { DIRECT_TOOL_SELECTION_LIMIT } from '@shared/runtime-limits'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()

const agentHealth = useAgentHealthStore()
const desktopToolList = useMediaQuery('(min-width: 640px)')

const hasMemoryScope = computed(() => (props.agent.memoryFolders?.length ?? 0) > 0)
const hasSelectableExecutionTools = computed(() => props.agent.tools.length > 0 || props.agent.autoToolRouting)
const usesSelectionCapRouting = computed(() => props.agent.tools.length > DIRECT_TOOL_SELECTION_LIMIT)

const automaticToolStates = computed(() => ({
  todo_update: {
    active: props.agent.thinkingEnabled && hasSelectableExecutionTools.value,
    criteria: 'thinking mode and visible execution tools',
  },
  ...memoryAutomaticToolStates(hasMemoryScope.value),
  attachment_search: {
    active: false,
    criteria: 'large indexed attachment available during chat',
  },
  attachment_read: {
    active: false,
    criteria: 'large indexed attachment available during chat',
  },
  expand_available_toolset: {
    active: props.agent.autoToolRouting || usesSelectionCapRouting.value,
    criteria: `auto tool mode enabled or more than ${DIRECT_TOOL_SELECTION_LIMIT} tools selected`,
  },
  spawn_subagent: {
    active: (props.agent.subAgents?.length ?? 0) > 0,
    criteria: 'sub-agent selected',
  },
  continue_subagent: {
    active: (props.agent.subAgents?.length ?? 0) > 0,
    criteria: 'sub-agent selected',
  },
}))

const missingTools = computed(() => agentHealth.validate(props.agent).tools)

function removeMissing() {
  const missing = new Set(missingTools.value)
  emit('update', 'tools', props.agent.tools.filter(t => !missing.has(t)))
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <BaseCard class="shrink-0 px-5 py-4">
      <div class="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <Icon
              icon="lucide:route"
              class="h-4 w-4 text-accent-fg"
            />
            <p class="text-sm font-medium text-theme-200">
              Automatic tool discovery
            </p>
            <span
              v-if="usesSelectionCapRouting && !agent.autoToolRouting"
              class="rounded bg-accent-500/10 px-1.5 py-0.5 text-[10px] text-accent-fg"
            >
              Auto for {{ agent.tools.length }} tools
            </span>
          </div>
          <p class="mt-1 text-xs text-ink-muted">
            Discover a compact set of relevant registered tools for each request. Up to {{ DIRECT_TOOL_SELECTION_LIMIT }} selected tools are sent directly and remain pinned. Above that limit, a relevant subset is selected automatically from only those tools, even when this switch is off. Required internal tools are added separately.
          </p>
        </div>
        <ToggleSwitch
          class="self-end sm:self-auto"
          :model-value="agent.autoToolRouting"
          label="Automatic tool discovery"
          size="md"
          color="accent"
          @update:model-value="emit('update', 'autoToolRouting', $event)"
        />
      </div>
    </BaseCard>

    <!-- Missing tools warning -->
    <div
      v-if="missingTools.length"
      class="shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3"
    >
      <div class="flex items-start gap-2">
        <Icon
          icon="lucide:alert-triangle"
          class="w-4 h-4 text-status-warning shrink-0 mt-0.5"
        />
        <div class="flex-1 min-w-0">
          <p class="text-xs font-medium text-amber-300">
            {{ missingTools.length }} assigned tool{{ missingTools.length > 1 ? 's' : '' }} unavailable
          </p>
          <p class="text-[11px] text-status-warning/60 mt-0.5">
            These tools are assigned to the agent but no longer found in any MCP server or built-in tools.
          </p>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <span
              v-for="name in missingTools"
              :key="name"
              class="inline-flex max-w-full items-center gap-1 break-all px-2 py-0.5 rounded bg-amber-500/10 text-[10px] font-mono text-amber-300/80"
            >
              <Icon
                icon="lucide:unplug"
                class="w-3 h-3"
              />
              {{ name }}
            </span>
          </div>
          <button
            class="mt-2.5 text-[11px] font-medium text-status-warning hover:text-amber-300 transition-colors flex items-center gap-1"
            @click="removeMissing"
          >
            <Icon
              icon="lucide:trash-2"
              class="w-3 h-3"
            />
            Remove unavailable tools
          </button>
        </div>
      </div>
    </div>

    <ToolSelector
      class="min-w-0 shrink-0 "
      :model-value="agent.tools"
      :show-approvals="true"
      :scrollable="desktopToolList"
      :automatic-tool-states="automaticToolStates"
      @update:model-value="emit('update', 'tools', $event)"
    />
  </div>
</template>
