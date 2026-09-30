import type { AgentDefinition } from '../api/types'

export interface AgentHealthCatalog {
  tools: ReadonlySet<string> | null
  memoryFolders: ReadonlySet<string> | null
  agents: ReadonlySet<string> | null
}

export function validateAgentHealth(agent: AgentDefinition, catalog: AgentHealthCatalog) {
  const missing = (ids: string[], available: ReadonlySet<string> | null) =>
    available ? [...new Set(ids)].filter(id => !available.has(id)) : []
  const tools = missing(agent.tools ?? [], catalog.tools)
  const memoryFolders = missing(agent.memoryFolders ?? [], catalog.memoryFolders)
  const subAgents = missing((agent.subAgents ?? []).map(item => item.agentId), catalog.agents)
  const issues = [
    ...tools.map(id => `Tool: ${id}`),
    ...memoryFolders.map(id => `Memory folder: ${id}`),
    ...subAgents.map(id => `Sub-agent: ${id}`),
  ]
  return {
    status: issues.length ? 'warning' : Object.values(catalog).some(value => value === null) ? 'checking' : 'ready',
    tools, memoryFolders, subAgents, issues,
  } as const
}
