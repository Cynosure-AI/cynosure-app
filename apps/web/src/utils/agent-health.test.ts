import { describe, expect, test } from 'vitest'
import type { AgentDefinition } from '../api/types'
import { validateAgentHealth } from './agent-health'

const agent = {
  tools: ['existing-tool', 'missing-tool', 'missing-tool'],
  memoryFolders: ['existing-folder', 'missing-folder'],
  subAgents: [{ agentId: 'existing-agent' }, { agentId: 'missing-agent' }],
} as AgentDefinition

describe('agent health validation', () => {
  test('identifies and deduplicates missing assignments', () => {
    const health = validateAgentHealth(agent, {
      tools: new Set(['existing-tool']),
      memoryFolders: new Set(['existing-folder']),
      agents: new Set(['existing-agent']),
    })
    expect(health.status).toBe('warning')
    expect(health.issues).toEqual([
      'Tool: missing-tool', 'Memory folder: missing-folder', 'Sub-agent: missing-agent',
    ])
  })

  test('does not report unloaded or failed catalogs as missing assignments', () => {
    expect(validateAgentHealth(agent, { tools: null, memoryFolders: null, agents: null }))
      .toMatchObject({ status: 'checking', issues: [] })
  })

  test('a successfully loaded empty catalog reports missing assignments', () => {
    const health = validateAgentHealth(agent, {
      tools: new Set(), memoryFolders: new Set(), agents: new Set(),
    })
    expect(health.status).toBe('warning')
    expect(health.tools).toEqual(['existing-tool', 'missing-tool'])
  })

  test('becomes ready when assignments are available again', () => {
    expect(validateAgentHealth(agent, {
      tools: new Set(agent.tools), memoryFolders: new Set(agent.memoryFolders),
      agents: new Set((agent.subAgents ?? []).map(item => item.agentId)),
    })).toMatchObject({ status: 'ready', issues: [] })
  })
})
