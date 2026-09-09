import { getAgent, listAgents } from '../../agents/agent-store.js'
import { getDb } from '../../../db/database.js'
import type { TelegramCtx } from './telegram.types.js'
import { TELEGRAM_API } from './telegram.types.js'
import { sendMessage } from './telegram.api.js'
import { cancelChannelExecutionsWhere } from '../channel-execution.js'
import { stopAllActivity } from '../../activity/stop-all.js'

/** Return the list of agents available for this channel (filtered by allowedAgentIds). */
export function getAvailableAgents(ctx: TelegramCtx) {
    const all = listAgents()
    if (ctx.allowedAgentIds.length === 0) return all
    const allowed = new Set(ctx.allowedAgentIds)
    return all.filter(a => allowed.has(a.id))
}

/** Register Telegram bot commands from the agent list for slash-command autocompletion. */
export async function registerBotCommands(ctx: TelegramCtx): Promise<void> {
    const agents = getAvailableAgents(ctx)
    const commands: { command: string; description: string }[] = [
        { command: 'start', description: 'Start a fresh conversation with the default agent' },
        { command: 'stop', description: 'Cancel the currently running execution' },
        { command: 'kill', description: 'Stop all running executions' },
        { command: 'new', description: 'Start a fresh conversation with the last used agent' }
    ]
    for (const agent of agents) {
        const cmd = agent.internalName.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32)
        if (cmd) {
            commands.push({ command: cmd, description: `Switch to ${agent.name}` })
        }
    }
    await fetch(`${TELEGRAM_API}/bot${ctx.botToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands })
    }).catch(() => { })
}

/** Handle slash commands. Returns true if the message was a command and was handled. */
export async function handleCommand(ctx: TelegramCtx, chatId: number, text: string): Promise<boolean> {
    const command = text.split(/\s|@/)[0].slice(1).toLowerCase()

    if (command === 'kill') {
        const result = stopAllActivity()
        const reply = result.total > 0
            ? `Stopped ${result.total} running execution(s) across all activity.`
            : 'No executions are currently running.'
        await sendMessage(ctx, chatId, reply)
        return true
    }

    if (command === 'stop') {
        const cancelled = cancelExecutionsForChat(ctx, chatId)
        if (cancelled > 0) {
            await sendMessage(ctx, chatId, `⏹ Stopped ${cancelled} running execution(s).`)
        } else {
            await sendMessage(ctx, chatId, '✅ No executions are currently running.')
        }
        return true
    }

    if (command === 'new') {
        cancelExecutionsForChat(ctx, chatId)
        const effectiveAgentId = ctx.chatLastUsedAgent.get(chatId) || ctx.chatAgentOverride.get(chatId) || ctx.agentId
        if (effectiveAgentId === ctx.agentId) {
            ctx.chatAgentOverride.delete(chatId)
        } else {
            ctx.chatAgentOverride.set(chatId, effectiveAgentId)
        }
        ctx.chatLastUsedAgent.set(chatId, effectiveAgentId)
        archiveConversation(ctx, chatId, effectiveAgentId)
        const agent = getAgent(effectiveAgentId)
        await sendMessage(ctx, chatId, `🆕 Starting a fresh conversation with *${agent?.name || 'Unknown'}*.`)
        return true
    }

    if (command === 'start') {
        cancelExecutionsForChat(ctx, chatId)
        const prevAgentId = ctx.chatAgentOverride.get(chatId) || ctx.agentId
        if (prevAgentId !== ctx.agentId || !ctx.chatLastUsedAgent.has(chatId)) {
            ctx.chatLastUsedAgent.set(chatId, prevAgentId)
        }
        ctx.chatAgentOverride.delete(chatId)
        archiveConversation(ctx, chatId, prevAgentId)
        const agent = getAgent(ctx.agentId)
        await sendMessage(ctx, chatId, `🔄 Switched back to default agent: *${agent?.name || 'Unknown'}*\n\nStarting a fresh conversation.`)
        return true
    }

    // Try to match an agent internal name
    const agents = getAvailableAgents(ctx)
    const normalizedCmd = command.replace(/_/g, '-')
    const matchedAgent = agents.find(a => {
        const lc = a.internalName.toLowerCase()
        const agentCmd = lc.replace(/[^a-z0-9_]/g, '_')
        return agentCmd === command || lc === normalizedCmd || lc === command
    })

    if (matchedAgent) {
        cancelExecutionsForChat(ctx, chatId)
        const prevAgentId = ctx.chatAgentOverride.get(chatId) || ctx.agentId
        archiveConversation(ctx, chatId, prevAgentId)
        if (matchedAgent.id !== prevAgentId) {
            archiveConversation(ctx, chatId, matchedAgent.id)
        }
        ctx.chatAgentOverride.set(chatId, matchedAgent.id)
        ctx.chatLastUsedAgent.set(chatId, matchedAgent.id)
        await sendMessage(ctx, chatId, `🔀 Switched to *${matchedAgent.name}*. Starting a fresh conversation.\n\nUse /start to switch back to the default agent.`)
        return true
    }

    return false
}

/** Cancel all active executions whose conversationId maps to the given Telegram chatId. */
export function cancelExecutionsForChat(ctx: TelegramCtx, chatId: number): number {
    return cancelChannelExecutionsWhere(ctx.activeExecutions, (entry) => {
        const execChatId = ctx.conversationToChat.get(entry.exec.conversationId)
        return execChatId === chatId
    })
}

/** Archive the active conversation for a Telegram chat so a fresh one is created next time. */
export function archiveConversation(ctx: TelegramCtx, telegramChatId: number, agentId: string): void {
    const db = getDb()
    const channelKey = `telegram:${ctx.channelId}:${telegramChatId}`

    let existing = db
        .prepare("SELECT id FROM conversations WHERE origin = 'channel' AND agent_id = ? AND json_extract(metadata_json, '$.channelKey') = ? AND json_extract(metadata_json, '$.archived') IS NULL")
        .get(agentId, channelKey) as { id: string } | undefined

    if (!existing) {
        existing = db
            .prepare('SELECT id FROM conversations WHERE origin = ? AND agent_id = ? AND title LIKE ? AND title NOT LIKE ?')
            .get('channel', agentId, `${channelKey}%`, '%|archived:%') as { id: string } | undefined
    }

    if (existing) {
        db.prepare("UPDATE conversations SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.archived', ?), updated_at = ? WHERE id = ?")
            .run(Date.now(), Date.now(), existing.id)
        ctx.conversationToChat.delete(existing.id)
    }
}
