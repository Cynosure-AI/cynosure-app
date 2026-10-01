import { computed } from 'vue'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useMcpServers } from './useMcpServers'
import { isBuiltInNamespaceId, isInternalToolName } from '../utils/internal-tools'
import { getToolNamespaceIcon } from '../utils/tool-namespace-icons'

/** One source of tool titles, namespace icons, and colors for all chat rows. */
export function useToolPresentation() {
  const agentStore = useAgentStore()
  const { servers } = useMcpServers()
  const toolsByName = computed(() => {
    const tools = new Map(agentStore.availableTools.map((tool) => [tool.executionName, tool]))
    for (const tool of agentStore.availableTools) {
      tools.set(tool.key, tool)
      if (!tool.ambiguous && !tools.has(tool.name)) tools.set(tool.name, tool)
    }
    return tools
  })

  function isBuiltInTool(name = ''): boolean {
    const tool = toolsByName.value.get(name)
    return tool ? isBuiltInNamespaceId(tool.namespace.id) : isInternalToolName(name)
  }

  function toolNamespaceIcon(name = ''): string {
    const namespaceId = toolsByName.value.get(name)?.namespace.id
    return namespaceId ? getToolNamespaceIcon(namespaceId) : name === 'spawn_subagent' || name === 'continue_subagent' ? 'lucide:bot' : 'lucide:terminal'
  }

  function toolIconUrl(name = ''): string | undefined {
    const namespaceId = toolsByName.value.get(name)?.namespace.id
    if (!namespaceId?.startsWith('mcp:')) return undefined
    return servers.value.find((server) => server.id === namespaceId.slice(4))?.icon_url || undefined
  }

  function toolDisplayName(name = 'Tool'): string {
    if (name === 'Task context') return 'Preparing Context'
    if (name === 'spawn_subagent') return 'Spawn sub-agent'
    if (name === 'continue_subagent') return 'Continue sub-agent'
    return toolsByName.value.get(name)?.name ?? name
  }
  return { isBuiltInTool, toolDisplayName, toolNamespaceIcon, toolIconUrl }
}
