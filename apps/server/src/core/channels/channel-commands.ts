/** Chat commands shared by all messaging channels: kill, stop, new, start, cyno, project, and agent switching. */
import { stopAllActivity } from '../activity/stop-all.js'
import { getProjectForConversation, listProjects, setConversationProject } from '../projects/project-store.js'
import {
    agentCommandName, archiveChannelConversation, cancelExecutionsForTarget, channelAgentName, getAvailableAgents, resolveHomeConversation, type ChannelSessionState, type ChannelTargetId,
} from './channel-session.js'
import { CYNO_AGENT_ID } from '../agent/execution-preset.js'

export interface ChannelCommandStyle {
    bold(text: string): string
    /** Appended to the agent-switch confirmation, e.g. "Use `!start` to switch back." */
    switchBackHint: string
}

/** Read the current, unarchived projects on every suggestion request. Values use stable IDs. */
export function projectSuggestions(query = '', limit = 25): { name: string; value: string }[] {
    const needle = query.trim().toLowerCase()
    const projects = listProjects()
        .filter(project => project.name.toLowerCase().includes(needle))
        .map(project => ({ name: project.name, value: `id:${project.id}` }))
    return [...projects, ...('off'.includes(needle) ? [{ name: 'Leave project', value: 'off' }] : [])].slice(0, limit)
}

/** Selections resolve by ID, so renames, reordering, and names like "off" remain unambiguous. */
export function runProjectSuggestion<K extends ChannelTargetId>(
    state: ChannelSessionState<K>, target: K, value: string, style: Pick<ChannelCommandStyle, 'bold'>,
): string {
    if (value === 'off') return runProjectCommand(state, target, 'off', style)
    const id = value.startsWith('id:') ? value.slice(3) : ''
    if (!id || !listProjects().some(project => project.id === id)) {
        return 'That project is no longer available. Send /project to refresh the list.'
    }
    return runProjectCommand(state, target, '', style, id)
}

const NO_PROJECTS = 'There are no projects yet. Create one in the app first.'

/** The project the target's active conversation works in, for pickers that show the choices as buttons. */
export function currentChannelProject<K extends ChannelTargetId>(
    state: ChannelSessionState<K>, target: K,
): { id: string; name: string } | null {
    const project = getProjectForConversation(resolveHomeConversation(state, target).conversationId)
    return project ? { id: project.id, name: project.name } : null
}

/** Command word of a `!cmd` or `/cmd` message; drops a Telegram-style `@botname` suffix. */
function parseChannelCommand(text: string): string {
    return text.split(/\s|@/)[0].slice(1).toLowerCase()
}

/**
 * Show or change the project the target's active conversation works in.
 * `arg` is empty (list), "off", a list number, or a project name.
 */
export function runProjectCommand<K extends ChannelTargetId>(
    state: ChannelSessionState<K>,
    target: K,
    arg: string,
    style: Pick<ChannelCommandStyle, 'bold'>,
    selectedId?: string,
): string {
    const projects = listProjects()
    const { conversationId } = resolveHomeConversation(state, target)
    const current = getProjectForConversation(conversationId)
    const query = arg.trim().toLowerCase()

    if (!query && !selectedId) {
        if (!projects.length) return NO_PROJECTS
        const list = projects.map((project, i) => `${i + 1}. ${project.name}${project.id === current?.id ? ' (current)' : ''}`).join('\n')
        const status = current ? `Working in ${style.bold(current.name)}.` : 'This chat is not in a project.'
        return `${status}\n\n${list}\n\nSend /project <name or number> to switch, or /project off to leave.`
    }
    if (!selectedId && (query === 'off' || query === 'none')) {
        if (!current) return 'This chat is not in a project.'
        setConversationProject(conversationId, null)
        return `Left ${style.bold(current.name)}.`
    }
    const match = selectedId ? projects.find(project => project.id === selectedId) : /^\d+$/.test(query)
        ? projects[Number(query) - 1]
        : projects.find((project) => project.name.toLowerCase() === query)
            ?? projects.find((project) => project.name.toLowerCase().includes(query))
    if (!match) return `No project matches "${arg.trim()}". Send /project to see the list.`
    setConversationProject(conversationId, match.id)
    return `📁 Now working in ${style.bold(match.name)}. Its brief, open tasks, and instructions apply from your next message.`
}

/** Handle a chat command. Returns true if the text was a command and was handled. */
export async function handleChannelCommand<K extends ChannelTargetId>(
    state: ChannelSessionState<K>,
    target: K,
    text: string,
    reply: (text: string) => Promise<void>,
    style: ChannelCommandStyle,
): Promise<boolean> {
    const command = parseChannelCommand(text)

    if (command === 'kill') {
        const result = stopAllActivity()
        await reply(result.total > 0
            ? `Stopped ${result.total} running execution(s) across all activity.`
            : 'No executions are currently running.')
        return true
    }

    if (command === 'stop') {
        const cancelled = cancelExecutionsForTarget(state, target)
        await reply(cancelled > 0
            ? `⏹ Stopped ${cancelled} running execution(s).`
            : '✅ No executions are currently running.')
        return true
    }

    if (command === 'project') {
        await reply(runProjectCommand(state, target, text.replace(/^\S+\s*/, ''), style))
        return true
    }

    if (command === 'new') {
        cancelExecutionsForTarget(state, target)
        const agentId = state.lastUsedAgent.get(target) || state.agentOverride.get(target) || state.agentId
        if (agentId === state.agentId) state.agentOverride.delete(target)
        else state.agentOverride.set(target, agentId)
        state.lastUsedAgent.set(target, agentId)
        archiveChannelConversation(state, target, agentId)
        await reply(`🆕 Starting a fresh conversation with ${style.bold(channelAgentName(agentId))}.`)
        return true
    }

    if (command === 'start') {
        cancelExecutionsForTarget(state, target)
        const prevAgentId = state.agentOverride.get(target) || state.agentId
        if (prevAgentId !== state.agentId || !state.lastUsedAgent.has(target)) {
            state.lastUsedAgent.set(target, prevAgentId)
        }
        state.agentOverride.delete(target)
        archiveChannelConversation(state, target, prevAgentId)
        await reply(`🔄 Switched back to default agent: ${style.bold(channelAgentName(state.agentId))}\n\nStarting a fresh conversation.`)
        return true
    }

    // Cyno is always reachable, also on channels whose default is a specialist agent.
    const matchedAgent = command === 'cyno'
        ? { id: CYNO_AGENT_ID, name: channelAgentName(CYNO_AGENT_ID) }
        : getAvailableAgents(state).find(a =>
            agentCommandName(a.internalName) === command || a.internalName.toLowerCase() === command)

    if (!matchedAgent) return false

    cancelExecutionsForTarget(state, target)
    const prevAgentId = state.agentOverride.get(target) || state.agentId
    archiveChannelConversation(state, target, prevAgentId)
    if (matchedAgent.id !== prevAgentId) {
        archiveChannelConversation(state, target, matchedAgent.id)
    }
    state.agentOverride.set(target, matchedAgent.id)
    state.lastUsedAgent.set(target, matchedAgent.id)
    await reply(`🔀 Switched to ${style.bold(matchedAgent.name)}. Starting a fresh conversation.\n\n${style.switchBackHint}`)
    return true
}
