import { getAgent, listAgents } from '../../agents/agent-store.js'
import { getDb } from '../../../db/database.js'
import type { WebClient } from '@slack/web-api'
import type { SlackCtx } from './slack.types.js'

export function getAvailableAgents(ctx: SlackCtx) {
    const all = listAgents()
    if (ctx.allowedAgentIds.length === 0) return all
    const allowed = new Set(ctx.allowedAgentIds)
    return all.filter(a => allowed.has(a.id))
}

export async function handleCommand(
    ctx: SlackCtx,
    slackChannelId: string,
    text: string,
    client: WebClient,
    threadTs: string
): Promise<boolean> {
    const command = text.slice(1).split(/\s/)[0].toLowerCase()

    if (command === 'stop') {
        let cancelled = 0
        for (const [id, entry] of ctx.activeExecutions) {
            entry.controller.abort()
            ctx.activeExecutions.delete(id)
            cancelled++
        }
        const reply = cancelled > 0
            ? `⏹ Stopped ${cancelled} running execution(s).`
            : '✅ No executions are currently running.'
        await client.chat.postMessage({ channel: slackChannelId, text: reply, thread_ts: threadTs }).catch(() => { })
        return true
    }

    if (command === 'new') {
        cancelExecutionsForChannel(ctx, slackChannelId)
        const effectiveAgentId = ctx.channelLastUsedAgent.get(slackChannelId) || ctx.channelAgentOverride.get(slackChannelId) || ctx.agentId
        if (effectiveAgentId === ctx.agentId) {
            ctx.channelAgentOverride.delete(slackChannelId)
        } else {
            ctx.channelAgentOverride.set(slackChannelId, effectiveAgentId)
        }
        ctx.channelLastUsedAgent.set(slackChannelId, effectiveAgentId)
        archiveConversation(ctx, slackChannelId, effectiveAgentId)
        const agent = getAgent(effectiveAgentId)
        await client.chat.postMessage({ channel: slackChannelId, text: `🆕 Starting a fresh conversation with *${agent?.name || 'Unknown'}*.` }).catch(() => { })
        return true
    }

    if (command === 'start') {
        cancelExecutionsForChannel(ctx, slackChannelId)
        const prevAgentId = ctx.channelAgentOverride.get(slackChannelId) || ctx.agentId
        if (prevAgentId !== ctx.agentId || !ctx.channelLastUsedAgent.has(slackChannelId)) {
            ctx.channelLastUsedAgent.set(slackChannelId, prevAgentId)
        }
        ctx.channelAgentOverride.delete(slackChannelId)
        archiveConversation(ctx, slackChannelId, prevAgentId)
        const agent = getAgent(ctx.agentId)
        await client.chat.postMessage({
            channel: slackChannelId, text: `🔄 Switched back to default agent: *${agent?.name || 'Unknown'}*

Starting a fresh conversation.` }).catch(() => { })
        return true
    }

    const agents = getAvailableAgents(ctx)
    const matchedAgent = agents.find(a => {
        const lc = a.internalName.toLowerCase()
        const agentCmd = lc.replace(/[^a-z0-9_]/g, '_')
        return agentCmd === command || lc === command
    })

    if (matchedAgent) {
        cancelExecutionsForChannel(ctx, slackChannelId)
        const prevAgentId = ctx.channelAgentOverride.get(slackChannelId) || ctx.agentId
        archiveConversation(ctx, slackChannelId, prevAgentId)
        if (matchedAgent.id !== prevAgentId) {
            archiveConversation(ctx, slackChannelId, matchedAgent.id)
        }
        ctx.channelAgentOverride.set(slackChannelId, matchedAgent.id)
        ctx.channelLastUsedAgent.set(slackChannelId, matchedAgent.id)
        await client.chat.postMessage({
            channel: slackChannelId,
            text: `🔀 Switched to *${matchedAgent.name}*. Starting a fresh conversation.\n\nUse \`!start\` to switch back.`
        }).catch(() => { })
        return true
    }

    return false
}

export function cancelExecutionsForChannel(ctx: SlackCtx, slackChannelId: string): void {
    for (const [id, entry] of ctx.activeExecutions) {
        const execChannelId = ctx.conversationToChannel.get(entry.exec.conversationId)
        if (execChannelId === slackChannelId) {
            entry.controller.abort()
            ctx.activeExecutions.delete(id)
        }
    }
}

export function archiveConversation(ctx: SlackCtx, slackChannelId: string, agentId: string): void {
    const db = getDb()
    const channelKey = `slack:${ctx.channelId}:${slackChannelId}`

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
