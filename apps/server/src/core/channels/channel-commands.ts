/** Chat commands shared by all messaging channels: kill, stop, new, start, and agent switching. */
import { getAgent } from '../agents/agent-store.js'
import { stopAllActivity } from '../activity/stop-all.js'
import {
    agentCommandName, archiveChannelConversation, cancelExecutionsForTarget, getAvailableAgents,
    type ChannelSessionState, type ChannelTargetId,
} from './channel-session.js'

export interface ChannelCommandStyle {
    bold(text: string): string
    /** Appended to the agent-switch confirmation, e.g. "Use `!start` to switch back." */
    switchBackHint: string
}

/** Command word of a `!cmd` or `/cmd` message; drops a Telegram-style `@botname` suffix. */
function parseChannelCommand(text: string): string {
    return text.split(/\s|@/)[0].slice(1).toLowerCase()
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

    if (command === 'new') {
        cancelExecutionsForTarget(state, target)
        const agentId = state.lastUsedAgent.get(target) || state.agentOverride.get(target) || state.agentId
        if (agentId === state.agentId) state.agentOverride.delete(target)
        else state.agentOverride.set(target, agentId)
        state.lastUsedAgent.set(target, agentId)
        archiveChannelConversation(state, target, agentId)
        const agent = getAgent(agentId)
        await reply(`🆕 Starting a fresh conversation with ${style.bold(agent?.name || 'Unknown')}.`)
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
        const agent = getAgent(state.agentId)
        await reply(`🔄 Switched back to default agent: ${style.bold(agent?.name || 'Unknown')}\n\nStarting a fresh conversation.`)
        return true
    }

    const matchedAgent = getAvailableAgents(state).find(a =>
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
