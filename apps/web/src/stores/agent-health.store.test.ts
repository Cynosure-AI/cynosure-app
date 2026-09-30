import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentDefinition } from '../api/types'
import { useAgentDefinitionsStore } from './agent-definitions.store'
import { useAgentStore, type ToolInfo } from './agent-runtime.store'
import { useAgentHealthStore } from './agent-health.store'

const mocks = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('../api/client', () => ({ api: { memoryFolders: mocks } }))

const definition = { id: 'agent', tools: ['tool'], memoryFolders: [], subAgents: [] } as unknown as AgentDefinition

describe('shared agent health', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.list.mockReset().mockResolvedValue([])
  })

  test('reacts to tools disappearing, returning, and assignment edits', async () => {
    const definitions = useAgentDefinitionsStore()
    const runtime = useAgentStore()
    definitions.agents = [definition]
    const health = useAgentHealthStore()
    expect(health.healthByAgent.get('agent')?.status).toBe('checking')
    definitions.loaded = true
    runtime.toolsLoaded = true
    await health.loadMemoryFolders()
    expect(health.healthByAgent.get('agent')?.tools).toEqual(['tool'])
    runtime.availableTools = [{ key: 'tool', name: 'tool', namespace: { id: 'mcp:server' } }] as ToolInfo[]
    expect(health.healthByAgent.get('agent')?.status).toBe('ready')
    definitions.agents[0] = { ...definition, subAgents: [{ agentId: 'removed' }] }
    expect(health.healthByAgent.get('agent')?.subAgents).toEqual(['removed'])
    definitions.agents.push({ ...definition, id: 'removed' })
    expect(health.healthByAgent.get('agent')?.status).toBe('ready')
  })

  test('deduplicates folder requests and keeps failed catalogs unknown', async () => {
    const health = useAgentHealthStore()
    mocks.list.mockRejectedValueOnce(new Error('offline'))
    await Promise.all([health.loadMemoryFolders(), health.loadMemoryFolders()])
    expect(mocks.list).toHaveBeenCalledTimes(1)
    expect(health.memoryFolderIds).toBeNull()
    await health.loadMemoryFolders()
    expect(health.memoryFolderIds).toEqual(new Set())
  })

  test('uses the same selectable-tool rules for every view', () => {
    const runtime = useAgentStore()
    runtime.toolsLoaded = true
    runtime.availableTools = [
      { key: 'internal', name: 'spawn_subagent', namespace: { id: 'builtin' } },
      { key: 'external', name: 'spawn_subagent', namespace: { id: 'mcp:server' } },
    ] as ToolInfo[]
    expect(useAgentHealthStore().validate({ ...definition, tools: ['internal', 'external'] }).tools)
      .toEqual(['internal'])
  })
})
