import { defineStore, acceptHMRUpdate } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api/client'
import type { AgentDefinition } from '../api/types'
import { useAgentDefinitionsStore } from './agent-definitions.store'
import { useAgentStore } from './agent-runtime.store'
import { isAutoManagedBuiltInToolName, isBuiltInNamespaceId } from '../utils/internal-tools'
import { validateAgentHealth } from '../utils/agent-health'

export const useAgentHealthStore = defineStore('agent-health', () => {
  const definitions = useAgentDefinitionsStore()
  const runtime = useAgentStore()
  const memoryFolderIds = ref<Set<string> | null>(null)
  let memoryRequest: Promise<void> | null = null

  // Build lookup sets once per catalog change, shared by every agent and view.
  const catalog = computed(() => ({
    tools: runtime.toolsLoaded ? new Set(runtime.availableTools
      .filter(tool => !(isBuiltInNamespaceId(tool.namespace.id) && isAutoManagedBuiltInToolName(tool.name)))
      .map(tool => tool.key)) : null,
    agents: definitions.loaded ? new Set(definitions.agents.map(agent => agent.id)) : null,
    memoryFolders: memoryFolderIds.value,
  }))
  function validate(agent: AgentDefinition) {
    return validateAgentHealth(agent, catalog.value)
  }
  const healthByAgent = computed(() => new Map(definitions.agents.map(agent => [agent.id, validate(agent)])))

  function loadMemoryFolders(): Promise<void> {
    if (memoryRequest) return memoryRequest
    memoryRequest = api.memoryFolders.list()
      .then(folders => { memoryFolderIds.value = new Set(folders.map(folder => folder.id)) })
      .catch(() => { /* Keep unknown catalogs pending; failed requests do not imply missing assignments. */ })
      .finally(() => { memoryRequest = null })
    return memoryRequest
  }

  return { healthByAgent, validate, memoryFolderIds, loadMemoryFolders }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAgentHealthStore, import.meta.hot))
}
