import { describe, expect, it } from 'vitest'
import { agentInternalName } from './agent-memory'

describe('agent memory paths', () => {
  it('matches the server-generated internal name convention', () => {
    expect(agentInternalName(' Research Assistant! ')).toBe('research_assistant')
  })
})
