import { reactive, ref } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { findSlashCommand, slashSuggestions } from '../utils/slash-commands'
import { useSlashCommands } from './useSlashCommands'

function tool(key: string, namespaceId: string, label: string) {
  return { key, name: key, description: '', namespace: { id: namespaceId, label } }
}

const chatStore = reactive({
  activeConversationId: 'conversation-1' as string | null,
  activeConversation: { pinned: false },
  activeProjectId: null as string | null,
  activeAgentId: null as string | null,
  activeConversationHasRunningInstance: false,
  hasAgentOverrides: false,
  hasCynoOverrides: false,
  sessionThinkingEnabled: true,
  sessionReasoningEffort: 'medium',
  sessionAutoMemory: true,
  sessionAutoToolRouting: false,
  selectedToolNames: [] as string[],
  sessionSubAgentIds: [] as string[],
  sessionMemoryFolderIds: [] as string[],
  sessionMemorySelectionInitialized: false,
  memoryFolders: [] as unknown[],
  resolvedModelProvider: null,
  markOverridesModified: vi.fn(),
  setSelectedToolNames: vi.fn((names: string[]) => { chatStore.selectedToolNames = names }),
  setSessionReasoningEffort: vi.fn(),
  loadMemoryFolders: vi.fn(),
  startNewChat: vi.fn(),
  compactConversation: vi.fn(async () => ({ compactedMessageCount: 12, model: 'm' })),
})
const agentStore = reactive({
  availableTools: [
    tool('gh_issues', 'mcp:gh', 'GitHub'),
    tool('gh_prs', 'mcp:gh', 'GitHub'),
    tool('notes', 'mcp:notes', 'Memory'),
    tool('web_search', 'builtin:web', 'Web'),
  ],
})
const servers = ref([{ id: 'gh', icon_url: 'https://example.test/gh.png' }])

vi.mock('../stores/chat.store', () => ({ useChatStore: () => chatStore }))
vi.mock('../stores/agent-runtime.store', () => ({ useAgentStore: () => agentStore }))
vi.mock('../stores/agent-definitions.store', () => ({ useAgentDefinitionsStore: () => ({ agents: [] }) }))
vi.mock('../stores/projects.store', () => ({
  useProjectsStore: () => ({ activeProjects: [], get: () => undefined, ensureLoaded: vi.fn(async () => undefined), load: vi.fn() }),
}))
vi.mock('./useMcpServers', () => ({ useMcpServers: () => ({ servers, loadServers: vi.fn(async () => undefined) }) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const actions = { attachFiles: vi.fn(), browseLibrary: vi.fn(), chooseModel: vi.fn(), editSystemPrompt: vi.fn() }

describe('useSlashCommands', () => {
  beforeEach(() => {
    chatStore.selectedToolNames = []
    chatStore.sessionAutoMemory = true
    chatStore.activeConversationHasRunningInstance = false
    chatStore.hasCynoOverrides = false
    chatStore.markOverridesModified.mockClear()
  })

  test('adds a command per MCP server, skipping built-ins and names already taken', () => {
    const { commands } = useSlashCommands(actions)
    const github = findSlashCommand(commands.value, 'github')
    expect(github).toMatchObject({ group: 'MCP servers', iconUrl: 'https://example.test/gh.png', state: 'off', detail: '0/2' })
    // "Memory" collides with the /memory folder command, which wins.
    expect(commands.value.filter(command => command.name === 'memory')).toHaveLength(1)
    expect(findSlashCommand(commands.value, 'memory')?.group).toBe('Settings')
    expect(findSlashCommand(commands.value, 'web')).toBeUndefined()
  })

  test('an MCP command toggles every tool of that server, or sets it with on/off', () => {
    const { commands } = useSlashCommands(actions)
    expect(findSlashCommand(commands.value, 'github')?.run?.()).toBe('GitHub tools on')
    expect(chatStore.selectedToolNames).toEqual(['gh_issues', 'gh_prs'])
    expect(findSlashCommand(commands.value, 'github')?.state).toBe('on')

    const [off] = slashSuggestions(commands.value, '/github off')
    expect(off.label).toBe('Off')
    expect(off.run?.()).toBe('GitHub tools off')
    expect(chatStore.selectedToolNames).toEqual([])
  })

  test('/tools lists every toolset, including built-ins', () => {
    const { commands } = useSlashCommands(actions)
    expect(slashSuggestions(commands.value, '/tools ').map(option => option.label)).toEqual(['Web', 'GitHub', 'Memory'])
  })

  test('/auto-memory toggles bare and accepts on/off', () => {
    const { commands } = useSlashCommands(actions)
    expect(findSlashCommand(commands.value, 'auto-memory')?.run?.()).toBe('Automatic memories off')
    expect(chatStore.sessionAutoMemory).toBe(false)
    slashSuggestions(commands.value, '/auto-memory on')[0].run?.()
    expect(chatStore.sessionAutoMemory).toBe(true)
    expect(chatStore.markOverridesModified).toHaveBeenCalledTimes(2)
  })

  test('commands that cannot run stay listed with a reason, so they are never sent as messages', () => {
    const { commands } = useSlashCommands(actions)
    expect(findSlashCommand(commands.value, 'stop')?.unavailable).toBe('Nothing is running.')
    expect(findSlashCommand(commands.value, 'reset')?.unavailable).toBe('Nothing has been changed.')
    chatStore.activeConversationHasRunningInstance = true
    chatStore.hasCynoOverrides = true
    expect(findSlashCommand(commands.value, 'stop')?.unavailable).toBeUndefined()
    expect(findSlashCommand(commands.value, 'reset')?.unavailable).toBeUndefined()
  })

  test('/reset is available in a saved chat that only has a project, since reset removes it', () => {
    const { commands } = useSlashCommands(actions)
    chatStore.activeProjectId = 'project-1'
    try {
      expect(findSlashCommand(commands.value, 'reset')?.unavailable).toBeUndefined()
    } finally {
      chatStore.activeProjectId = null
    }
  })

  test('/compact summarises the chat, but not while a response runs or before the chat exists', async () => {
    const { commands } = useSlashCommands(actions)
    await expect(findSlashCommand(commands.value, 'compact')?.run?.()).resolves.toBe('Compacted 12 messages')
    expect(chatStore.compactConversation).toHaveBeenCalledOnce()

    chatStore.activeConversationHasRunningInstance = true
    expect(findSlashCommand(commands.value, 'compact')?.unavailable).toBe('Wait for the current response to finish.')
    chatStore.activeConversationId = null
    expect(findSlashCommand(commands.value, 'compact')?.unavailable).toBe('Start the chat first.')
    expect(findSlashCommand(commands.value, 'rename')?.unavailable).toBe('Start the chat first.')
    chatStore.activeConversationId = 'conversation-1'
  })

  test('/think sets the reasoning level by name or value', () => {
    const { commands } = useSlashCommands(actions)
    const [option] = slashSuggestions(commands.value, '/think xhigh')
    expect(option.label).toBe('Extra high')
    option.run?.()
    expect(chatStore.setSessionReasoningEffort).toHaveBeenCalledWith('xhigh')
  })
})
