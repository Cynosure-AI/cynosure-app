import type Database from 'better-sqlite3'
import type { ChatEvent, StoredMessageDto, TranscriptItem } from '@shared/types'
import { readContentBlocks, toTranscriptItems } from './transcript.js'
import { getAgent } from '../agents/agent-store.js'

function parseArray(value: string | null): string[] | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((url): url is string => typeof url === 'string') : undefined
  } catch { return undefined }
}

type PendingChatEvent = ChatEvent extends infer Event
  ? Event extends ChatEvent ? Omit<Event, 'sequence'> : never
  : never

/** Persist an event and allocate its conversation sequence atomically. Broadcast only after commit. */
export function appendChatEvent(db: Database.Database, event: PendingChatEvent): ChatEvent | null {
  return db.transaction(() => {
    const itemId = event.type === 'item.appended' ? event.payload.item.id : null
    const sequence = lastChatEventSequence(db, event.conversationId) + 1
    const insert = db.prepare(`
      INSERT INTO chat_events (conversation_id, sequence, execution_id, event_type, item_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, item_id) WHERE event_type = 'item.appended' DO NOTHING
    `).run(event.conversationId, sequence, event.executionId, event.type, itemId, JSON.stringify(event.payload), Date.now())
    if (insert.changes === 0) return null
    return { ...event, sequence } as ChatEvent
  })()
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
           provider, model, memory_sources_json,
           prompt_tokens, completion_tokens, context_tokens, latency_ms, created_at
    FROM messages WHERE id = ? AND conversation_id = ?
  `).get(messageId, conversationId) as {
    id: string; conversation_id: string; role: string; content: string
    thinking: string | null; content_blocks_json: string | null
    image_urls_json: string | null; video_urls_json: string | null
    audio_urls_json: string | null; structured_content_json: string | null
    tool_calls_json: string | null; tool_call_id: string | null
    agent_id: string | null; ma_invocation_id: string | null
    provider: string | null; model: string | null; memory_sources_json: string | null
    prompt_tokens: number | null; completion_tokens: number | null
    context_tokens: number | null; latency_ms: number | null; created_at: number
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
  let contextEvidence: StoredMessageDto['contextEvidence']
  try {
    const parsed: unknown = row.memory_sources_json ? JSON.parse(row.memory_sources_json) : undefined
    if (Array.isArray(parsed)) contextEvidence = parsed
  } catch { /* Keep remaining metadata. */ }
  let agent: ReturnType<typeof getAgent> = null
  try { agent = row.agent_id ? getAgent(row.agent_id) : null }
  catch { /* An agent may have been deleted since this message was written. */ }
  const message: StoredMessageDto = {
    id: row.id, conversationId, role: row.role, content: row.content,
    thinking: row.thinking ?? undefined,
    imageDataUrls: parseArray(row.image_urls_json),
    videoDataUrls: parseArray(row.video_urls_json),
    audioDataUrls: parseArray(row.audio_urls_json),
    structuredContent, toolCalls, toolCallId: row.tool_call_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    agentName: agent?.name,
    agentIconUrl: agent?.iconUrl ?? undefined,
    contextEvidence,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    contextTokens: row.context_tokens,
    latencyMs: row.latency_ms,
    maInvocationId: row.ma_invocation_id ?? undefined,
    provider: row.provider, model: row.model, createdAt: row.created_at,
  }
  message.blocks = readContentBlocks(row.content_blocks_json, message)

  return db.transaction(() => toTranscriptItems(message).flatMap((item): ChatEvent[] => {
    const event = appendChatEvent(db, {
      version: 1, type: 'item.appended', conversationId, executionId, payload: { item },
    })
    return event ? [event] : []
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
      if (!payload || typeof payload !== 'object') return []
      const envelope = {
        version: 1 as const, conversationId, executionId: row.execution_id,
        sequence: row.sequence,
      }
      switch (row.event_type) {
        case 'item.appended':
          return 'item' in payload ? [{ ...envelope, type: 'item.appended', payload: { item: payload.item as TranscriptItem } }] : []
        case 'execution.marker':
          return 'item' in payload ? [{ ...envelope, type: 'execution.marker', payload: { item: payload.item as Extract<TranscriptItem, { type: 'execution-marker' }> } }] : []
        case 'content.delta':
          return 'itemId' in payload && 'block' in payload
            ? [{ ...envelope, type: 'content.delta', payload: { itemId: payload.itemId as string, block: payload.block as Extract<import('@shared/types').ContentBlock, { type: 'text' | 'reasoning' }> } }]
            : []
        default: return []
      }
    } catch { return [] }
  })
}

export function lastChatEventSequence(db: Database.Database, conversationId: string): number {
  const row = db.prepare('SELECT MAX(sequence) AS sequence FROM chat_events WHERE conversation_id = ?')
    .get(conversationId) as { sequence: number | null }
  return row.sequence ?? 0
}
