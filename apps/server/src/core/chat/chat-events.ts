import type Database from 'better-sqlite3'
import type { ChatEvent, StoredMessageDto, TranscriptItem } from '@shared/types'
import { readContentBlocks, toTranscriptItems } from './transcript.js'

function parseArray(value: string | null): string[] | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((url): url is string => typeof url === 'string') : undefined
  } catch { return undefined }
}

/** Append only after a message has been committed. Missing/deleted messages emit nothing. */
export function appendMessageEvents(
  db: Database.Database,
  conversationId: string,
  executionId: string,
  messageId: string,
): ChatEvent[] {
  const row = db.prepare(`
    SELECT id, conversation_id, role, content, thinking, content_blocks_json,
           image_urls_json, video_urls_json, audio_urls_json, structured_content_json,
           tool_calls_json, tool_call_id, agent_id, ma_invocation_id,
           provider, model, created_at
    FROM messages WHERE id = ? AND conversation_id = ?
  `).get(messageId, conversationId) as {
    id: string; conversation_id: string; role: string; content: string
    thinking: string | null; content_blocks_json: string | null
    image_urls_json: string | null; video_urls_json: string | null
    audio_urls_json: string | null; structured_content_json: string | null
    tool_calls_json: string | null; tool_call_id: string | null
    agent_id: string | null; ma_invocation_id: string | null
    provider: string | null; model: string | null; created_at: number
  } | undefined
  if (!row) return []

  let structuredContent: unknown
  try { structuredContent = row.structured_content_json ? JSON.parse(row.structured_content_json) : undefined }
  catch { /* Preserve text and media even when structured data is damaged. */ }
  let toolCalls: unknown[] | undefined
  try {
    const parsed = row.tool_calls_json ? JSON.parse(row.tool_calls_json) : undefined
    toolCalls = Array.isArray(parsed) ? parsed : undefined
  } catch { /* Preserve the message. */ }
  const message: StoredMessageDto = {
    id: row.id, conversationId, role: row.role, content: row.content,
    thinking: row.thinking ?? undefined,
    imageDataUrls: parseArray(row.image_urls_json),
    videoDataUrls: parseArray(row.video_urls_json),
    audioDataUrls: parseArray(row.audio_urls_json),
    structuredContent, toolCalls, toolCallId: row.tool_call_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    maInvocationId: row.ma_invocation_id ?? undefined,
    provider: row.provider, model: row.model, createdAt: row.created_at,
  }
  message.blocks = readContentBlocks(row.content_blocks_json, message)

  const insert = db.prepare(`
    INSERT INTO chat_events (conversation_id, execution_id, event_type, payload_json, created_at)
    VALUES (?, ?, 'item.appended', ?, ?)
  `)
  return db.transaction(() => toTranscriptItems(message).map((item): ChatEvent => {
    const sequence = Number(insert.run(conversationId, executionId, JSON.stringify({ item }), Date.now()).lastInsertRowid)
    return { version: 1, type: 'item.appended', conversationId, executionId, sequence, payload: { item } }
  }))()
}

export function listChatEvents(
  db: Database.Database, conversationId: string, after: number, limit = 500,
): ChatEvent[] {
  const rows = db.prepare(`
    SELECT sequence, execution_id, event_type, payload_json
    FROM chat_events WHERE conversation_id = ? AND sequence > ?
    ORDER BY sequence ASC LIMIT ?
  `).all(conversationId, after, limit) as Array<{
    sequence: number; execution_id: string; event_type: string; payload_json: string
  }>
  return rows.flatMap((row): ChatEvent[] => {
    try {
      const payload: unknown = JSON.parse(row.payload_json)
      if (row.event_type === 'item.appended' && payload && typeof payload === 'object' && 'item' in payload) {
        return [{
          version: 1, type: 'item.appended', conversationId, executionId: row.execution_id,
          sequence: row.sequence, payload: { item: payload.item as TranscriptItem },
        }]
      }
    } catch { /* Skip an invalid event rather than breaking conversation loading. */ }
    return []
  })
}

export function lastChatEventSequence(db: Database.Database, conversationId: string): number {
  const row = db.prepare('SELECT MAX(sequence) AS sequence FROM chat_events WHERE conversation_id = ?')
    .get(conversationId) as { sequence: number | null }
  return row.sequence ?? 0
}
