import { getDb } from '../../db/database.js'

/**
 * Resolve the most-recently-active chat/channel target for a given channel ID.
 * Returns the platform-specific target identifier (Telegram chatId, Discord/Slack channel ID),
 * or null if no conversation has been seen on this channel yet.
 */
export function resolveChannelTarget(channelId: string): string | null {
    const db = getDb()
    const ch = db.prepare('SELECT type FROM channels WHERE id = ?').get(channelId) as { type: string } | undefined
    if (!ch) return null
    const prefix = `${ch.type}:${channelId}:`
    const row = db.prepare(
        `SELECT json_extract(config_json, '$.channelKey') AS channel_key
         FROM conversations
         WHERE origin = 'channel'
           AND json_extract(config_json, '$.channelKey') LIKE ?
           AND json_extract(config_json, '$.archived') IS NULL
         ORDER BY updated_at DESC
         LIMIT 1`
    ).get(`${prefix}%`) as { channel_key: string } | undefined
    if (!row?.channel_key) return null
    return row.channel_key.slice(row.channel_key.lastIndexOf(':') + 1)
}
