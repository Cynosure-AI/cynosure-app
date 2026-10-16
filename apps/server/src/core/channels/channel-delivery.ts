/**
 * Proactive channel messages (scheduled job results, notifications): the text
 * joins the target's active chat when there is one, and each sent platform
 * message remembers which conversation a reply to it should continue.
 */
import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { messageContentJson, messageToTranscriptItem, publishChatEvent } from '../chat/transcript.js'

type BroadcastFn = (event: string, data: unknown) => void

/** Remember that replying to these platform messages continues `conversationId`. */
export function recordChannelDeliveries(input: {
    channelId: string
    target: string
    platformMessageIds: string[]
    conversationId: string
}): void {
    if (!input.platformMessageIds.length) return
    const db = getDb()
    const insert = db.prepare(`INSERT INTO channel_deliveries (id, channel_id, target, platform_message_id, conversation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
    const now = Date.now()
    db.transaction(() => {
        for (const messageId of input.platformMessageIds) {
            insert.run(nanoid(), input.channelId, input.target, messageId, input.conversationId, now)
        }
    })()
}

/** The conversation a reply to this platform message continues, if it still exists. */
export function findDeliveryConversation(channelId: string, target: string, platformMessageId: string): string | null {
    const row = getDb().prepare(`SELECT d.conversation_id FROM channel_deliveries d
        JOIN conversations c ON c.id = d.conversation_id
        WHERE d.channel_id = ? AND d.target = ? AND d.platform_message_id = ?
        ORDER BY d.created_at DESC LIMIT 1`).get(channelId, target, platformMessageId) as { conversation_id: string } | undefined
    return row?.conversation_id ?? null
}

/** Save a message the agent sent on its own as an assistant turn of the conversation. */
export function persistProactiveMessage(input: {
    broadcast: BroadcastFn
    conversationId: string
    /** Null for Cyno, which runs without an agent. */
    agentId: string | null
    content: string
}): void {
    const { broadcast, conversationId, agentId, content } = input
    const db = getDb()
    const id = nanoid()
    const createdAt = Date.now()
    db.prepare(`INSERT INTO messages (id, conversation_id, role, content, content_blocks_json, agent_id, created_at)
        VALUES (?, ?, 'assistant', ?, ?, ?, ?)`).run(id, conversationId, content, messageContentJson({ id, content }), agentId, createdAt)
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(createdAt, conversationId)
    publishChatEvent(broadcast, { conversationId, executionId: 'external', payload: {
        type: 'transcript-item', item: messageToTranscriptItem({ id, role: 'assistant', content, agentId: agentId ?? undefined, createdAt }),
    } })
}
