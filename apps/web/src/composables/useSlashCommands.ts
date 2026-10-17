import { computed } from 'vue'
import { useRouter } from 'vue-router'
import type { ReasoningEffort } from '@shared/types'
import { useChatStore } from '../stores/chat.store'
import { useAgentStore } from '../stores/agent-runtime.store'
import { useAgentDefinitionsStore } from '../stores/agent-definitions.store'
import { useProjectsStore } from '../stores/projects.store'
import { useMcpServers } from './useMcpServers'
import { memoryFolderSelectionInfo } from '../utils/memory-folder-selection'
import { getToolNamespaceIcon } from '../utils/tool-namespace-icons'
import { groupSelectableTools, toolGroupSelectionState, withToolGroup, type ToolGroup } from '../utils/tool-groups'
import {
  findSlashCommand,
  rankSlashArgs,
  slashName,
  type SlashArgOption,
  type SlashCommand,
  type SlashResult,
} from '../utils/slash-commands'

/** Composer actions the commands open; the composer owns these dialogs. */
export interface SlashCommandActions {
  attachFiles: () => void
  browseLibrary: () => void
  chooseModel: () => void
  editSystemPrompt: () => void
}

const REASONING_LEVELS: Array<{ value: ReasoningEffort | 'off'; label: string; description: string }> = [
  { value: 'off', label: 'Off', description: 'Reasoning disabled' },
  { value: 'minimal', label: 'Minimal', description: 'Lowest latency and token use' },
  { value: 'low', label: 'Low', description: 'Quick reasoning for simple tasks' },
  { value: 'medium', label: 'Medium', description: 'Balanced reasoning, speed, and tokens' },
  { value: 'high', label: 'High', description: 'Deep reasoning for complex tasks' },
  { value: 'xhigh', label: 'Extra high', description: 'For especially difficult tasks' },
  { value: 'max', label: 'Maximum', description: 'The provider\'s maximum effort' },
]

const SETTINGS_SECTIONS: Array<{ category: string; label: string; icon: string }> = [
  { category: 'general', label: 'General', icon: 'lucide:settings' },
  { category: 'appearance', label: 'Appearance', icon: 'lucide:palette' },
  { category: 'chat', label: 'Chat', icon: 'lucide:message-square' },
  { category: 'memory', label: 'Memory', icon: 'lucide:brain' },
  { category: 'speech-to-text', label: 'Voice', icon: 'lucide:mic' },
  { category: 'providers', label: 'Providers', icon: 'lucide:server' },
  { category: 'channels', label: 'Channels', icon: 'lucide:radio-tower' },
  { category: 'file-access', label: 'File Access', icon: 'lucide:folder-lock' },
  { category: 'backup', label: 'Backup & Restore', icon: 'lucide:archive-restore' },
]

function onOffState(on: boolean): 'on' | 'off' {
  return on ? 'on' : 'off'
}

/** `on` / `off` argument options for a toggle command. */
function toggleArgs(current: boolean | 'mixed', set: (on: boolean) => SlashResult): (query: string) => SlashArgOption[] {
  return query => rankSlashArgs([
    { key: 'on', label: 'On', icon: 'lucide:toggle-right', detail: current === true ? 'Current' : undefined, run: () => set(true) },
    { key: 'off', label: 'Off', icon: 'lucide:toggle-left', detail: current === false ? 'Current' : undefined, run: () => set(false) },
  ], query)
}

export function useSlashCommands(actions: SlashCommandActions) {
  const chatStore = useChatStore()
  const agentStore = useAgentStore()
  const agentDefs = useAgentDefinitionsStore()
  const projectsStore = useProjectsStore()
  const { servers, loadServers } = useMcpServers()
  const router = useRouter()

  /** Load the lists that argument suggestions draw from. Safe to call repeatedly. */
  function prepare(): void {
    if (!chatStore.memoryFolders.length) void chatStore.loadMemoryFolders()
    if (!servers.value.length) void loadServers().catch(() => undefined)
    void projectsStore.ensureLoaded().catch(() => undefined)
  }

  function setAutoMemory(on: boolean): SlashResult {
    chatStore.sessionAutoMemory = on
    chatStore.markOverridesModified()
    return `Automatic memories ${on ? 'on' : 'off'}`
  }

  function setAutoTools(on: boolean): SlashResult {
    chatStore.sessionAutoToolRouting = on
    chatStore.markOverridesModified()
    return `Automatic tools ${on ? 'on' : 'off'}`
  }

  function setToolGroup(group: ToolGroup, on: boolean): SlashResult {
    chatStore.setSelectedToolNames(withToolGroup(group, chatStore.selectedToolNames, on))
    return `${group.label} tools ${on ? 'on' : 'off'}`
  }

  function toggleSubAgent(id: string, name: string): SlashResult {
    const index = chatStore.sessionSubAgentIds.indexOf(id)
    if (index < 0) chatStore.sessionSubAgentIds.push(id)
    else chatStore.sessionSubAgentIds.splice(index, 1)
    chatStore.markOverridesModified()
    return `Subagent ${name} ${index < 0 ? 'on' : 'off'}`
  }

  function toggleMemoryFolder(id: string, name: string): SlashResult {
    const index = chatStore.sessionMemoryFolderIds.indexOf(id)
    if (index < 0) chatStore.sessionMemoryFolderIds.push(id)
    else chatStore.sessionMemoryFolderIds.splice(index, 1)
    chatStore.sessionMemorySelectionInitialized = true
    chatStore.markOverridesModified()
    return `Memory folder ${name} ${index < 0 ? 'on' : 'off'}`
  }

  async function chooseProject(projectId: string | null, name: string): Promise<SlashResult> {
    await chatStore.setConversationProject(projectId)
    void projectsStore.load()
    return projectId ? `Project: ${name}` : 'Removed from project'
  }

  async function togglePin(conversationId: string): Promise<SlashResult> {
    if (!chatStore.activeConversation) await chatStore.loadConversations()
    const pinned = chatStore.activeConversation?.pinned === true
    await chatStore.pinConversation(conversationId, !pinned)
    await chatStore.loadConversations()
    return pinned ? 'Chat unpinned' : 'Chat pinned'
  }

  const toolGroups = computed(() => groupSelectableTools(agentStore.availableTools))

  function toolGroupArg(group: ToolGroup): SlashArgOption {
    const state = toolGroupSelectionState(group, chatStore.selectedToolNames)
    const iconUrl = group.id.startsWith('mcp:')
      ? servers.value.find(server => server.id === group.id.slice(4))?.icon_url
      : null
    return {
      key: group.id,
      label: group.label,
      icon: getToolNamespaceIcon(group.id),
      iconUrl,
      state: state === 'mixed' ? 'mixed' : onOffState(state),
      detail: `${group.tools.filter(tool => chatStore.selectedToolNames.includes(tool.key)).length}/${group.tools.length}`,
      run: () => setToolGroup(group, state !== true),
    }
  }

  const commands = computed<SlashCommand[]>(() => {
    const conversationId = chatStore.activeConversationId
    const canReset = chatStore.hasAgentOverrides || (!chatStore.activeAgentId && chatStore.hasCynoOverrides)
      || Boolean(chatStore.activeProjectId)
    const reasoning = chatStore.sessionThinkingEnabled ? chatStore.sessionReasoningEffort : 'off'
    const list: SlashCommand[] = []

    // ── Chat ──
    list.push({
      name: 'new',
      aliases: ['clear'],
      description: 'Start a new chat',
      icon: 'lucide:square-pen',
      group: 'Chat',
      run: async () => { await chatStore.startNewChat({ projectId: chatStore.activeProjectId }) },
    })
    const running = chatStore.activeConversationHasRunningInstance
    const noChat = conversationId ? undefined : 'Start the chat first.'
    list.push({
      name: 'stop',
      description: 'Stop the current response',
      icon: 'lucide:square',
      group: 'Chat',
      unavailable: running ? undefined : 'Nothing is running.',
      run: async () => { await chatStore.cancelStream(); return 'Stopped' },
    })
    list.push({
      name: 'compact',
      description: 'Summarise this chat so far to free up context',
      icon: 'lucide:fold-vertical',
      group: 'Chat',
      unavailable: noChat ?? (running ? 'Wait for the current response to finish.' : undefined),
      run: async () => {
        const { compactedMessageCount } = await chatStore.compactConversation()
        return `Compacted ${compactedMessageCount} message${compactedMessageCount === 1 ? '' : 's'}`
      },
    })
    const pinned = chatStore.activeConversation?.pinned === true
    list.push({
      name: 'pin',
      aliases: ['unpin'],
      description: pinned ? 'Unpin this chat' : 'Pin this chat',
      icon: pinned ? 'lucide:pin-off' : 'lucide:pin',
      group: 'Chat',
      state: conversationId ? onOffState(pinned) : undefined,
      unavailable: noChat,
      run: () => conversationId ? togglePin(conversationId) : undefined,
    })
    list.push({
      name: 'rename',
      description: 'Rename this chat',
      icon: 'lucide:pencil',
      group: 'Chat',
      hint: 'title',
      unavailable: noChat,
      args: (query) => query && conversationId
        ? [{
            key: 'title',
            label: `Rename to “${query}”`,
            value: query,
            icon: 'lucide:pencil',
            run: async () => { await chatStore.renameConversation(conversationId, query); return 'Chat renamed' },
          }]
        : [],
    })
    list.push({
      name: 'goal',
      description: 'Keep working until every task for this goal is done',
      icon: 'lucide:target',
      group: 'Chat',
      hint: 'objective',
      sendsMessage: true,
    })
    list.push({
      name: 'attach',
      aliases: ['upload'],
      description: 'Upload files from your device',
      icon: 'lucide:paperclip',
      group: 'Chat',
      run: () => actions.attachFiles(),
    })
    list.push({
      name: 'library',
      description: 'Attach a previous upload from the library',
      icon: 'lucide:library',
      group: 'Chat',
      run: () => actions.browseLibrary(),
    })

    // ── Session settings ──
    list.push({
      name: 'model',
      description: 'Choose the provider and model',
      icon: 'lucide:cpu',
      group: 'Settings',
      detail: chatStore.resolvedModelProvider?.model || undefined,
      run: () => actions.chooseModel(),
    })
    list.push({
      name: 'think',
      aliases: ['reasoning', 'effort'],
      description: 'Set the reasoning level',
      icon: 'lucide:gauge',
      group: 'Settings',
      hint: 'level',
      detail: REASONING_LEVELS.find(level => level.value === reasoning)?.label,
      args: query => rankSlashArgs(REASONING_LEVELS.map(level => ({
        key: level.value,
        label: level.label,
        value: level.value,
        description: level.description,
        icon: 'lucide:gauge',
        detail: level.value === reasoning ? 'Current' : undefined,
        run: () => {
          chatStore.setSessionReasoningEffort(level.value)
          return `Reasoning: ${level.label}`
        },
      })), query),
    })
    list.push({
      name: 'auto-memory',
      aliases: ['automemory'],
      description: 'Retrieve relevant memories automatically',
      icon: 'lucide:database-zap',
      group: 'Settings',
      hint: 'on|off',
      state: onOffState(chatStore.sessionAutoMemory),
      run: () => setAutoMemory(!chatStore.sessionAutoMemory),
      args: toggleArgs(chatStore.sessionAutoMemory, setAutoMemory),
    })
    list.push({
      name: 'auto-tools',
      aliases: ['autotools'],
      description: 'Auto-select the appropriate toolset',
      icon: 'lucide:sparkles',
      group: 'Settings',
      hint: 'on|off',
      state: onOffState(chatStore.sessionAutoToolRouting),
      run: () => setAutoTools(!chatStore.sessionAutoToolRouting),
      args: toggleArgs(chatStore.sessionAutoToolRouting, setAutoTools),
    })
    list.push({
      name: 'tools',
      aliases: ['mcp'],
      description: 'Turn a toolset or MCP server on or off',
      icon: 'lucide:wrench',
      group: 'Settings',
      hint: 'toolset',
      args: query => rankSlashArgs(toolGroups.value.map(toolGroupArg), query),
    })
    list.push({
      name: 'memory',
      aliases: ['memories'],
      description: 'Turn a memory folder on or off',
      icon: 'lucide:brain',
      group: 'Settings',
      hint: 'folder',
      args: query => rankSlashArgs(chatStore.memoryFolders.map((folder) => {
        const info = memoryFolderSelectionInfo(folder, chatStore.memoryFolders, chatStore.sessionMemoryFolderIds)
        return {
          key: folder.id,
          label: folder.name,
          description: folder.isUncategorized ? 'Every folder that is not opt-in' : folder.folderPath,
          icon: folder.isUncategorized ? 'lucide:brain' : 'lucide:folder',
          state: info.state === 'selected' ? 'on' : info.state === 'partial' ? 'mixed' : 'off',
          detail: info.state === 'inherited' && info.via ? `via ${info.via.name}` : undefined,
          run: () => toggleMemoryFolder(folder.id, folder.name),
        }
      }), query),
    })
    list.push({
      name: 'agent',
      aliases: ['subagent'],
      description: 'Turn a subagent on or off',
      icon: 'lucide:users',
      group: 'Settings',
      hint: 'name',
      args: query => rankSlashArgs(agentDefs.agents.map(agent => ({
        key: agent.id,
        label: agent.name,
        description: agent.description || agent.internalName,
        icon: 'lucide:bot',
        iconUrl: agent.iconUrl,
        state: onOffState(chatStore.sessionSubAgentIds.includes(agent.id)),
        run: () => toggleSubAgent(agent.id, agent.name),
      })), query),
    })
    list.push({
      name: 'project',
      description: 'Run this chat inside a project',
      icon: 'lucide:folder-kanban',
      group: 'Settings',
      hint: 'name',
      detail: projectsStore.get(chatStore.activeProjectId)?.name,
      args: query => rankSlashArgs([
        {
          key: 'none',
          label: 'No project',
          value: 'none',
          icon: 'lucide:circle-off',
          detail: chatStore.activeProjectId ? undefined : 'Current',
          run: () => chooseProject(null, ''),
        },
        ...projectsStore.activeProjects.map(project => ({
          key: project.id,
          label: project.name,
          description: project.description,
          icon: 'lucide:folder-kanban',
          detail: project.id === chatStore.activeProjectId ? 'Current' : undefined,
          run: () => chooseProject(project.id, project.name),
        })),
      ], query),
    })
    list.push({
      name: 'system',
      aliases: ['prompt'],
      description: 'View and edit the system prompt',
      icon: 'lucide:scroll-text',
      group: 'Settings',
      run: () => actions.editSystemPrompt(),
    })
    list.push({
      name: 'reset',
      description: 'Reset this chat\'s settings to the defaults',
      icon: 'lucide:rotate-ccw',
      group: 'Settings',
      unavailable: canReset ? undefined : 'Nothing has been changed.',
      run: async () => {
        await chatStore.resetToDefaults()
        return 'Settings reset to defaults'
      },
    })
    list.push({
      name: 'settings',
      description: 'Open the app settings',
      icon: 'lucide:settings',
      group: 'Settings',
      hint: 'section',
      run: async () => { await router.push({ name: 'settings' }) },
      args: query => rankSlashArgs([
        ...SETTINGS_SECTIONS.map(section => ({
          key: section.category,
          label: section.label,
          value: section.category,
          icon: section.icon,
          run: async () => { await router.push({ name: 'settings', query: { category: section.category } }) },
        })),
        {
          key: 'mcp',
          label: 'MCP servers',
          value: 'mcp',
          icon: 'lucide:plug',
          run: async () => { await router.push({ name: 'settings-mcp' }) },
        },
      ], query),
    })

    // ── One command per MCP server, e.g. `/github` ──
    for (const group of toolGroups.value) {
      if (!group.id.startsWith('mcp:')) continue
      const name = slashName(group.label)
      if (!name || findSlashCommand(list, name)) continue
      const option = toolGroupArg(group)
      const state = toolGroupSelectionState(group, chatStore.selectedToolNames)
      list.push({
        name,
        description: `Turn ${group.label} tools on or off`,
        icon: option.icon ?? 'lucide:plug',
        iconUrl: option.iconUrl,
        group: 'MCP servers',
        hint: 'on|off',
        state: option.state,
        detail: option.detail,
        run: option.run,
        args: toggleArgs(state, on => setToolGroup(group, on)),
      })
    }

    return list
  })

  return { commands, prepare }
}
