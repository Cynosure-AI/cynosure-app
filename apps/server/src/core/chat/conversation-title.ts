import type Database from 'better-sqlite3'

/** Consume a fork's pending rename when its first new user message is saved. */
export function shouldGenerateConversationTitle(db: Database.Database, conversationId: string): boolean {
  const conversation = db.prepare(`
    SELECT title,
           json_extract(CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
                        '$.titleGenerationPending') AS pending
    FROM conversations WHERE id = ?
  `).get(conversationId) as { title: string | null; pending: number | null } | undefined
  if (!conversation) return false
  if (conversation.pending === 1) {
    db.prepare(`
      UPDATE conversations
      SET metadata_json = json_remove(metadata_json, '$.titleGenerationPending')
      WHERE id = ?
    `).run(conversationId)
    return true
  }
  return conversation.title === 'New Chat'
}
