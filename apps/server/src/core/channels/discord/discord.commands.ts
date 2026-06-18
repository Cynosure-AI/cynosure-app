import { getAgent, listAgents } from '../../agents/agent-store.js'
import { getDb } from '../../../db/database.js'
import type { DiscordCtx } from './discord.types.js'

export function getAvailableAgents(ctx: DiscordCtx) {
    const all = listAgents()
    if (ctx.allowedAgentIds.length === 0) return all
    const allowed = new Set(ctx.allowedAgentIds)
    return all.filter(a => allowed.has(a.id))
}

export async function handleCommand(ctx: DiscordCtx, msg: import('discord.js').Message, text: string): Promise<boolean> {
    const command = text.slice(1).split(/\s/)[0].toLowerCase()
    const discordChannelId = msg.channel.id

    if (command === 'stop') {
        let cancelled = 0
        for (const [id, entry] of ctx.activeExecutions) {
            entry.controller.abort()
            ctx.activeExecutions.delete(id)
            cancelled++
        }
        if (cancelled > 0) {
            await msg.reply(`⏹ Stopped ${cancelled} running execution(s).`).catch(() => { })
        } else {
            await msg.reply('✅ No executions are currently running.').catch(() => { })
        }
        return true
    }

    if (command === 'new') {
        cancelExecutionsForChannel(ctx, discordChannelId)
        const effectiveAgentId = ctx.channelLastUsedAgent.get(discordChannelId) || ctx.channelAgentOverride.get(discordChannelId) || ctx.agentId
        if (effectiveAgentId === ctx.agentId) {
            ctx.channelAgentOverride.delete(discordChannelId)
        } else {
            ctx.channelAgentOverride.set(discordChannelId, effectiveAgentId)
        }
        ctx.channelLastUsedAgent.set(discordChannelId, effectiveAgentId)
        archiveConversation(ctx, discordChannelId, effectiveAgentId)
        const agent = getAgent(effectiveAgentId)
        await msg.reply(`🆕 Starting a fresh conversation with **${agent?.name || 'Unknown'}**.`).catch(() => { })
        return true
    }

    if (command === 'start') {
        cancelExecutionsForChannel(ctx, discordChannelId)
        const prevAgentId = ctx.channelAgentOverride.get(discordChannelId) || ctx.agentId
        if (prevAgentId !== ctx.agentId || !ctx.channelLastUsedAgent.has(discordChannelId)) {
            ctx.channelLastUsedAgent.set(discordChannelId, prevAgentId)
        }
        ctx.channelAgentOverride.delete(discordChannelId)
        archiveConversation(ctx, discordChannelId, prevAgentId)
        const agent = getAgent(ctx.agentId)
        await msg.reply(`🔄 Switched back to default agent: **${agent?.name || 'Unknown'}**\n\nStarting a fresh conversation.`).catch(() => { })
        return true
    }

    const agents = getAvailableAgents(ctx)
    const matchedAgent = agents.find(a => {
        const lc = a.internalName.toLowerCase()
        const agentCmd = lc.replace(/[^a-z0-9_]/g, '_')
        return agentCmd === command || lc === command
    })

    if (matchedAgent) {
        cancelExecutionsForChannel(ctx, discordChannelId)
        const prevAgentId = ctx.channelAgentOverride.get(discordChannelId) || ctx.agentId
        archiveConversation(ctx, discordChannelId, prevAgentId)
        if (matchedAgent.id !== prevAgentId) {
            archiveConversation(ctx, discordChannelId, matchedAgent.id)
        }
        ctx.channelAgentOverride.set(discordChannelId, matchedAgent.id)
        ctx.channelLastUsedAgent.set(discordChannelId, matchedAgent.id)
        await msg.reply(`🔀 Switched to **${matchedAgent.name}**. Starting a fresh conversation.\n\nUse \`!start\` to switch back.`).catch(() => { })
        return true
    }

    return false
}

export function cancelExecutionsForChannel(ctx: DiscordCtx, discordChannelId: string): void {
    for (const [id, entry] of ctx.activeExecutions) {
        const execChannelId = ctx.conversationToChannel.get(entry.exec.conversationId)
        if (execChannelId === discordChannelId) {
            entry.controller.abort()
            ctx.activeExecutions.delete(id)
        }
    }
}

export function archiveConversation(ctx: DiscordCtx, discordChannelId: string, agentId: string): void {
    const db = getDb()
    const channelKey = `discord:${ctx.channelId}:${discordChannelId}`

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
        ctx.conversationToChannel.delete(existing.id)
    }
}
