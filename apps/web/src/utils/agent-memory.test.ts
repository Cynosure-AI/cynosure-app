import { describe, expect, it } from 'vitest'
import { agentInternalName, agentMemoryFolderName, agentMemoryRelativePath } from './agent-memory'

describe('agent memory paths', () => {
  it('matches the server-generated internal name convention', () => {
    expect(agentInternalName(' Research Assistant! ')).toBe('research_assistant')
  })

  it('builds the dedicated agent memory path', () => {
    expect(agentMemoryFolderName('research_assistant', 'Research Assistant')).toBe('research_assistant')
    expect(agentMemoryRelativePath('research_assistant', 'Research Assistant')).toBe('agents/research_assistant')
  })

  it('sanitizes fallback display names', () => {
    expect(agentMemoryRelativePath('', 'Writer / Editor')).toBe('agents/Writer_-_Editor')
  })
})
