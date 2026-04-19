<script setup lang="ts">
import { computed } from 'vue'
import type { AgentDefinition } from '../../api/types'
import { useAgentStore } from '../../stores/agent-runtime.store'
import { Icon } from '@iconify/vue'
import ToolSelector from '../shared/ToolSelector.vue'

const props = defineProps<{ agent: AgentDefinition }>()
const emit = defineEmits<{ update: [field: string, value: unknown] }>()

const agentStore = useAgentStore()

const missingTools = computed(() => {
  const availableKeys = new Set(agentStore.availableTools.map(t => `${t.namespace.id}::${t.name}`))
  return props.agent.tools.filter(name => !name.includes('::') || !availableKeys.has(name))
})

function removeMissing() {
  const missing = new Set(missingTools.value)
  emit('update', 'tools', props.agent.tools.filter(t => !missing.has(t)))
}
</script>

<template>
  <div class="flex flex-col h-[75vh]">
    <p class="text-sm text-zinc-500 mb-3 shrink-0">
      Select which tools this agent can access
    </p>

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
      @update:model-value="emit('update', 'tools', $event)"
    />
  </div>
</template>
