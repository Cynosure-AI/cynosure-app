import { getDb } from '../../db/database.js'
import { getChannelManager } from './channel-manager.js'

/** Deliver queued turns, including scheduled wait resumptions, to their original channel. */
export async function deliverQueuedChannelReply(conversationId: string, text: string): Promise<void> {
    if (!text.trim()) return
    const db = getDb()
    const conversation = db.prepare("SELECT json_extract(metadata_json, '$.channelKey') AS channelKey FROM conversations WHERE id = ?")
        .get(conversationId) as { channelKey: string | null } | undefined
    const match = conversation?.channelKey?.match(/^(telegram|discord|slack):([^:]+):(.+)$/)
    // Replies to a proactive notification may continue a cron conversation,
    // which has delivery records rather than a channelKey of its own.
    const destination = match ? { channelId: match[2], target: match[3] }
        : db.prepare(`SELECT channel_id AS channelId, target FROM channel_deliveries
            WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
            .get(conversationId) as { channelId: string; target: string } | undefined
    if (!destination) return
    const delivered = await getChannelManager().deliver(destination.channelId, destination.target, text, {
        sourceConversationId: conversationId,
    })
    if (!delivered) console.warn(`[channels] Could not deliver queued reply for conversation ${conversationId}`)
}
