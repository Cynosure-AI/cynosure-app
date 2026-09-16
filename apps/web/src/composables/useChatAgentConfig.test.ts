import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useChatAgentConfig } from './useChatAgentConfig'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useAgentStore, type ToolInfo } from '../stores/agent-runtime.store'
import { SK_ACTIVE_AGENT, SK_FREE_CHAT_MODEL, SK_FREE_CHAT_PROVIDER } from '../utils/storage-keys'
import { DEFAULT_FREE_CHAT_SYSTEM_PROMPT } from '../utils/default-system-prompts'
import type { AgentDefinition } from '../api/types'

describe('chat agent provider defaults', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    setActivePinia(createPinia())
  })

  test('preserves and applies a same-provider default override', async () => {
    sessionStorage.setItem(SK_ACTIVE_AGENT, 'agent-1')
    const definitions = useAgentDefinitionsStore()
    definitions.agents = [{
      id: 'agent-1',
      name: 'Agent',
      providerId: 'provider-1',
      model: 'agent-model',
      tools: [],
      subAgents: [],
      memoryFolders: [],
      autoMemory: true,
    } as unknown as AgentDefinition]
    definitions.update = vi.fn().mockResolvedValue(undefined)

    const config = useChatAgentConfig(ref(null), ref([]), ref([]), vi.fn().mockResolvedValue(undefined))
    config.setSessionModel(null, 'provider-1')

    expect(config.sessionProviderOverride.value).toBe('provider-1')
    expect(config.sessionModelOverride.value).toBeNull()

    await config.applyOverridesToAgent()
    expect(definitions.update).toHaveBeenCalledWith('agent-1', {
      model: '',
    })
  })

  test('allows scheduling tools in Free Chat selections', () => {
    const runtime = useAgentStore()
    runtime.availableTools = [
      tool('builtin::schedule_create', 'schedule_create'),
      tool('builtin::read_file', 'read_file'),
    ]
    const config = useChatAgentConfig(ref(null), ref([]), ref([]), vi.fn().mockResolvedValue(undefined))

    config.setSelectedToolNames(['builtin::schedule_create', 'builtin::read_file'])

    expect(config.selectedToolNames.value).toEqual(['builtin::schedule_create', 'builtin::read_file'])
  })

  test('uses the Cyno system prompt for new Free Chats', () => {
    const config = useChatAgentConfig(ref(null), ref([]), ref([]), vi.fn().mockResolvedValue(undefined))

    config.ensureFreeChatPreset()

    expect(config.sessionSystemPrompt.value).toBe(DEFAULT_FREE_CHAT_SYSTEM_PROMPT)
    expect(config.hasFreeChatOverrides.value).toBe(false)
  })

  test('restores the Cyno system prompt when Free Chat defaults are reset', () => {
    const config = useChatAgentConfig(ref(null), ref([]), ref([]), vi.fn().mockResolvedValue(undefined))
    config.ensureFreeChatPreset()
    config.sessionSystemPrompt.value = 'Temporary override'
    config.markOverridesModified()

    config.resetToDefaults()

    expect(config.sessionSystemPrompt.value).toBe(DEFAULT_FREE_CHAT_SYSTEM_PROMPT)
    expect(config.hasFreeChatOverrides.value).toBe(false)
  })

  test('starts a new Free Chat from its defaults instead of retaining overrides', () => {
    localStorage.setItem(SK_FREE_CHAT_MODEL, 'preferred-model')
    localStorage.setItem(SK_FREE_CHAT_PROVIDER, 'preferred-provider')
    const config = useChatAgentConfig(ref(null), ref([]), ref([]), vi.fn().mockResolvedValue(undefined))
    config.setFreeChatDefaultMemoryFolderIds(['uncategorized'])
    config.ensureFreeChatPreset()
    config.sessionSystemPrompt.value = 'Temporary override'
    config.sessionThinkingEnabled.value = false
    config.sessionAutoToolRouting.value = false
    config.freeChatSubAgentIds.value = ['agent-2']
    config.freeChatMemoryFolderIds.value = ['custom-folder']
    config.markOverridesModified()

    config.syncAgentBaseline()

    expect(config.sessionSystemPrompt.value).toBe(DEFAULT_FREE_CHAT_SYSTEM_PROMPT)
    expect(config.sessionThinkingEnabled.value).toBe(true)
    expect(config.sessionAutoToolRouting.value).toBe(true)
    expect(config.freeChatSubAgentIds.value).toEqual([])
    expect(config.freeChatMemoryFolderIds.value).toEqual(['uncategorized'])
    expect(config.sessionModelOverride.value).toBe('preferred-model')
    expect(config.sessionProviderOverride.value).toBe('preferred-provider')
    expect(config.hasFreeChatOverrides.value).toBe(false)
  })

  test('allows scheduling tools when a saved agent is active', () => {
    sessionStorage.setItem(SK_ACTIVE_AGENT, 'agent-1')
    const definitions = useAgentDefinitionsStore()
    definitions.agents = [{
      id: 'agent-1',
      name: 'Agent',
      tools: [],
      subAgents: [],
      memoryFolders: [],
    } as unknown as AgentDefinition]
    const runtime = useAgentStore()
    runtime.availableTools = [tool('builtin::schedule_create', 'schedule_create')]
    const config = useChatAgentConfig(ref(null), ref([]), ref([]), vi.fn().mockResolvedValue(undefined))

    config.setSelectedToolNames(['builtin::schedule_create'])

    expect(config.selectedToolNames.value).toEqual(['builtin::schedule_create'])
  })
})

function tool(key: string, name: string): ToolInfo {
  return {
    key,
    name,
    executionName: name,
    description: name,
    parameters: {},
    autoApprove: false,
    usesDefaultApproval: true,
    namespace: { id: 'builtin', label: 'Built-In' },
    ambiguous: false,
  }
}
