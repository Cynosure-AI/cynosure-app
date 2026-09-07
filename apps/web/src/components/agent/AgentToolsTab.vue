<script setup lang="ts">
import { computed } from 'vue'
import type { AgentDefinition } from '../../api/types'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { Icon } from '@iconify/vue'
import ToolSelector from '../shared/ToolSelector.vue'
import ToggleSwitch from '../shared/ToggleSwitch.vue'
import BaseCard from '../shared/BaseCard.vue'
import { isAutoManagedBuiltInToolName, isBuiltInNamespaceId, memoryAutomaticToolStates } from '../../utils/internal-tools'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()

const agentStore = useAgentStore()

const hasMemoryScope = computed(() => (props.agent.memorySpaces?.length ?? 0) > 0)
const hasSelectableExecutionTools = computed(() => props.agent.tools.length > 0 || props.agent.autoToolRouting)

const automaticToolStates = computed(() => ({
  todo_write: {
    active: props.agent.thinkingEnabled && hasSelectableExecutionTools.value,
    criteria: 'thinking mode and visible execution tools',
  },
  ...memoryAutomaticToolStates(hasMemoryScope.value),
  knowledge_search: {
    active: hasMemoryScope.value,
    criteria: 'memory folder selected',
  },
  attachment_list_documents: {
    active: false,
    criteria: 'large indexed attachment available during chat',
  },
  attachment_search: {
    active: false,
    criteria: 'large indexed attachment available during chat',
  },
  attachment_retrieve_chunks: {
    active: false,
    criteria: 'large indexed attachment available during chat',
  },
  expand_available_toolset: {
    active: props.agent.autoToolRouting,
    criteria: 'auto tool mode enabled',
  },
  spawn_subagent: {
    active: (props.agent.subAgents?.length ?? 0) > 0,
    criteria: 'sub-agent selected',
  },
}))

const missingTools = computed(() => {
  const availableKeys = new Set(
    agentStore.availableTools
      .filter(t => !(isBuiltInNamespaceId(t.namespace.id) && isAutoManagedBuiltInToolName(t.name)))
      .map(t => t.key)
  )
  return props.agent.tools.filter(name => !availableKeys.has(name))
})

function removeMissing() {
  const missing = new Set(missingTools.value)
  emit('update', 'tools', props.agent.tools.filter(t => !missing.has(t)))
}
</script>

<template>
  <div class="flex flex-col h-[75vh]">
    <BaseCard class="mb-3 shrink-0 px-5 py-4">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <Icon
              icon="lucide:route"
              class="h-4 w-4 text-accent-400"
            />
            <p class="text-sm font-medium text-theme-200">
              Automatic tool discovery
            </p>
          </div>
          <p class="mt-1 text-xs text-theme-500">
            Discover a compact set of relevant registered tools for each request. Tools selected below are pinned and always kept; required internal tools are added separately.
          </p>
        </div>
        <ToggleSwitch
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
      class="mb-3 shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3"
    >
      <div class="flex items-start gap-2">
        <Icon
          icon="lucide:alert-triangle"
          class="w-4 h-4 text-amber-400 shrink-0 mt-0.5"
        />
        <div class="flex-1 min-w-0">
          <p class="text-xs font-medium text-amber-300">
            {{ missingTools.length }} assigned tool{{ missingTools.length > 1 ? 's' : '' }} unavailable
          </p>
          <p class="text-[11px] text-amber-400/60 mt-0.5">
            These tools are assigned to the agent but no longer found in any MCP server or built-in tools.
          </p>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <span
              v-for="name in missingTools"
              :key="name"
              class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/10 text-[10px] font-mono text-amber-300/80"
            >
              <Icon
                icon="lucide:unplug"
                class="w-3 h-3"
              />
              {{ name }}
            </span>
          </div>
          <button
            class="mt-2.5 text-[11px] font-medium text-amber-400 hover:text-amber-300 transition-colors flex items-center gap-1"
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
      class="flex-1 min-h-0"
      :model-value="agent.tools"
      :show-approvals="true"
      :automatic-tool-states="automaticToolStates"
      @update:model-value="emit('update', 'tools', $event)"
    />
  </div>
</template>
