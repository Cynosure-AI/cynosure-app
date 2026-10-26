import type Database from 'better-sqlite3'
import type { ChatEvent, ChatEventDraft, ChatEventPayload, ContentBlock, ContextEvidence, MessageItem, MessageToolCall } from '@shared/types'
import type { ContentPart } from '../gateway/providers/base.provider.js'

export interface MessageFields {
  id: string
  role?: string
  content: string
  isError?: boolean
  stopped?: boolean
  createdAt?: number
  thinking?: string
  imageDataUrls?: string[]
  videoDataUrls?: string[]
  audioDataUrls?: string[]
  fileAttachments?: { id?: string; name: string; href?: string }[]
  structuredContent?: unknown
  contentBlocks?: ContentBlock[]
  agentId?: string
  maInvocationId?: string
  agentName?: string
  agentIconUrl?: string | null
  maCodename?: string
  maAgentName?: string
  contextEvidence?: ContextEvidence[]
  provider?: string | null
  model?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  contextTokens?: number | null
  latencyMs?: number | null
  toolCallIds?: string[]
  toolCalls?: MessageToolCall[]
  toolCallId?: string
  toolSuccess?: boolean
}

export function messageContentBlocks(message: MessageFields): ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (message.content) blocks.push({ type: 'text', text: message.content })
  if (message.thinking) blocks.push({ type: 'reasoning', text: message.thinking })
  for (const [type, urls] of [
    ['image', message.imageDataUrls], ['video', message.videoDataUrls], ['audio', message.audioDataUrls],
  ] as const) {
    for (const url of urls || []) blocks.push({ type, artifactId: url, url })
  }
  for (const file of message.fileAttachments || []) {
    blocks.push({ type: 'file', artifactId: file.id || file.href || `${message.id}:${file.name}`, name: file.name, url: file.href })
  }
  if (message.structuredContent !== undefined) blocks.push({ type: 'structured', value: message.structuredContent })
  return blocks
}

export function messageContentJson(message: MessageFields): string {
  return JSON.stringify(message.contentBlocks || messageContentBlocks(message))
}

/** The only conversion needed by the current provider gateway content shape. */
export function contentBlocksToProviderContent(blocks: ContentBlock[], resolveArtifactUrl: (url: string) => string = (url) => url): string | ContentPart[] {
  const parts: ContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image') parts.push({ type: 'image_url', image_url: { url: resolveArtifactUrl(block.url) } })
    else if (block.type === 'audio') parts.push({ type: 'audio_url', audio_url: { url: resolveArtifactUrl(block.url) } })
  }
  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts
}

export function messageToTranscriptItem(message: MessageFields, executionId?: string): MessageItem {
  return {
    type: 'message', id: message.id,
    role: message.role === 'user' || message.role === 'assistant' || message.role === 'system' || message.role === 'tool' ? message.role : 'assistant',
    isError: message.isError,
    stopped: message.stopped,
    content: message.contentBlocks || messageContentBlocks(message),
    createdAt: message.createdAt ?? Date.now(),
    executionId,
    agentId: message.agentId,
    invocationId: message.maInvocationId,
    agentName: message.agentName,
    agentIconUrl: message.agentIconUrl,
    maCodename: message.maCodename,
    maAgentName: message.maAgentName,
    contextEvidence: message.contextEvidence,
    provider: message.provider,
    model: message.model,
    promptTokens: message.promptTokens,
    completionTokens: message.completionTokens,
    contextTokens: message.contextTokens,
    latencyMs: message.latencyMs,
    toolCallIds: message.toolCallIds,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    toolSuccess: message.toolSuccess,
  }
}

/**
 * Tool output is stored in full only in content_blocks_json. The content
 * column keeps a short preview, enough for listings and notification checks.
 */
export const TOOL_CONTENT_PREVIEW_CHARS = 500

export function toolContentPreview(output: string): string {
  return output.length > TOOL_CONTENT_PREVIEW_CHARS ? `${output.slice(0, TOOL_CONTENT_PREVIEW_CHARS)}…` : output
}

/** A message row's full text, read from its content blocks for tool rows. */
export function messageRowText(row: { role: string; content: string; content_blocks_json: string | null }): string {
  if (row.role !== 'tool') return row.content
  const blocks = parseBlocks(row.content_blocks_json)
  return blocks ? textOf(blocks) : row.content
}

/** SQL for a message row's full text; `table` qualifies the columns when the query joins. */
export function messageTextSql(table = ''): string {
  const column = (name: string) => table ? `${table}.${name}` : name
  return `CASE WHEN ${column('role')} = 'tool' THEN COALESCE((
    SELECT group_concat(json_extract(block.value, '$.text'), '') FROM json_each(${column('content_blocks_json')}) AS block
    WHERE json_extract(block.value, '$.type') = 'text'
  ), ${column('content')}) ELSE ${column('content')} END`
}

/** Publish one typed chat event through the same persistence and WebSocket path. */
export function publishChatEvent(broadcast: (event: string, data: unknown) => void, draft: ChatEventDraft): void {
  broadcast('chat:event', draft)
}

export function persistChatEvent(db: Database.Database, draft: ChatEventDraft): ChatEvent | null {
  if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(draft.conversationId)) return null
  const createdAt = Date.now()
  const result = db.prepare('INSERT INTO chat_events (conversation_id, execution_id, event_json, created_at) VALUES (?, ?, ?, ?)')
    .run(draft.conversationId, draft.executionId, JSON.stringify(draft.payload), createdAt)
  return { ...draft.payload, version: 1, conversationId: draft.conversationId,
    executionId: draft.executionId, sequence: Number(result.lastInsertRowid), createdAt } as ChatEvent
}

/** Map agent execution telemetry into transcript events at the event-bus boundary. */
export function executionUpdateToChatPayload(event: string, data: Record<string, unknown>): ChatEventPayload | null {
    const step = data
    const taskId = str(step.taskId) || 'task'
    const iteration = num(step.iteration)
    const executionId = str(step.executionId) || taskId
    const createdAt = Date.now()
    if (event === 'task:started' || event === 'task:completed' || event === 'task:error') {
      const status = event === 'task:started' ? 'started' : event === 'task:completed' ? 'completed'
        : step.error === 'Cancelled' ? 'cancelled' : 'failed'
      return { type: 'transcript-item', item: { type: 'execution-marker', id: `${taskId}:${status}:${createdAt}`,
        executionId, taskId: str(step.taskId), status, createdAt, parentInvocationId: str(step.maInvocationId),
        maCodename: str(step.maCodename), detail: str(step.error) } }
    }
    if (event === 'step:status') {
      return { type: 'execution-step', taskId, iteration, status: str(step.status) || '', message: str(step.message),
        maCodename: str(step.maCodename), maAgentName: str(step.maAgentName), invocationId: str(step.maInvocationId) }
    }
    if (event === 'step:tools-chosen' && Array.isArray(step.toolCalls)) {
      return { type: 'tool-calls', items: step.toolCalls.map((raw, index) => {
        const call = raw as Record<string, unknown>
        const name = str(call.name) || ''
        const args = str(call.arguments) || '{}'
        const callId = str(call.id) || `${taskId}:${iteration}:${index}`
        return { type: 'tool-call', id: `call:${callId}`, executionId, taskId, iteration, callId, name, arguments: args,
          parentInvocationId: str(step.maInvocationId), invocationId: delegatedInvocationId(name, args), createdAt }
      }) }
    }
    if (event === 'step:executed' && Array.isArray(step.results)) {
      return { type: 'tool-results', items: step.results.map((raw, index) => {
        const result = raw as Record<string, unknown>
        const callId = str(result.toolCallId) || `${taskId}:${iteration}:${index}`
        const content: ContentBlock[] = []
        if (typeof result.output === 'string') content.push({ type: 'text', text: result.output })
        if (Array.isArray(result.images)) {
          for (const url of result.images) if (typeof url === 'string') content.push({ type: 'image', artifactId: url, url })
        }
        if (Array.isArray(result.audioDataUrls)) {
          for (const url of result.audioDataUrls) if (typeof url === 'string') content.push({ type: 'audio', artifactId: url, url })
        }
        if (result.structuredContent !== undefined) content.push({ type: 'structured', value: result.structuredContent })
        return { type: 'tool-result', id: `result:${callId}`, executionId, taskId, iteration, callId,
          name: str(result.name) || '', invocationId: result.structuredContent && typeof result.structuredContent === 'object'
            ? str((result.structuredContent as Record<string, unknown>).invocationId) : undefined,
          content, success: result.success === true, createdAt }
      }) }
    }
    return null
}

function str(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function num(value: unknown): number { return typeof value === 'number' ? value : 0 }
function delegatedInvocationId(name: string, args: string): string | undefined {
  if (name !== 'spawn_subagent' && name !== 'continue_subagent') return undefined
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    return str(parsed.invocationId)
  } catch { return undefined }
}

export function listChatEvents(db: Database.Database, conversationId: string, after = 0, limit = 1000, types?: readonly string[]): ChatEvent[] {
  const typeFilter = types?.length ? ` AND json_extract(event_json, '$.type') IN (${types.map(() => '?').join(', ')})` : ''
  const rows = db.prepare(`SELECT sequence, execution_id, event_json, created_at FROM chat_events WHERE conversation_id = ? AND sequence > ?${typeFilter} ORDER BY sequence LIMIT ?`)
    .all(conversationId, after, ...(types ?? []), limit) as Array<{ sequence: number; execution_id: string; event_json: string; created_at: number }>
  const hydrate = toolOutputHydrator(db, conversationId)
  return rows.map((row) => ({ ...hydrate(JSON.parse(row.event_json) as ChatEventPayload), version: 1, conversationId, executionId: row.execution_id, sequence: row.sequence, createdAt: row.created_at }) as ChatEvent)
}

// Tool output is saved on its message row. Settled events drop their copy of
// it and are filled back in from that row whenever they are read.
type StoredToolResult = Extract<ChatEventPayload, { type: 'tool-results' }>['items'][number] & { outputInMessage?: true }
type StoredTranscriptItem = Extract<ChatEventPayload, { type: 'transcript-item' }> & { contentInMessage?: true }

function textOf(blocks: ContentBlock[]): string {
  return blocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')
}

function parseBlocks(json: string | null): ContentBlock[] | null {
  if (!json) return null
  try { return JSON.parse(json) as ContentBlock[] } catch { return null }
}

function toolMessageLookup(db: Database.Database, conversationId: string) {
  const byId = db.prepare("SELECT content_blocks_json FROM messages WHERE id = ? AND conversation_id = ? AND role = 'tool'").pluck()
  const byCallId = db.prepare("SELECT content_blocks_json FROM messages WHERE conversation_id = ? AND tool_call_id = ? AND role = 'tool' LIMIT 2").pluck()
  return {
    byId: (id: string) => parseBlocks(byId.get(id, conversationId) as string | null),
    // A call ID only identifies a message when it is unique in the conversation.
    byCallId: (callId: string) => {
      const rows = byCallId.all(conversationId, callId) as Array<string | null>
      return rows.length === 1 ? parseBlocks(rows[0]) : null
    },
  }
}

function toolOutputHydrator(db: Database.Database, conversationId: string): (payload: ChatEventPayload) => ChatEventPayload {
  let lookup: ReturnType<typeof toolMessageLookup> | undefined
  return (payload) => {
    if (payload.type === 'tool-results' && payload.items.some((item) => (item as StoredToolResult).outputInMessage)) {
      lookup ??= toolMessageLookup(db, conversationId)
      return { ...payload, items: payload.items.map((item) => {
        const { outputInMessage, ...rest } = item as StoredToolResult
        if (!outputInMessage) return item
        const blocks = lookup!.byCallId(item.callId)
        return blocks ? { ...rest, content: [{ type: 'text' as const, text: textOf(blocks) }, ...rest.content] } : rest
      }) }
    }
    if (payload.type === 'transcript-item') {
      const { contentInMessage, ...rest } = payload as StoredTranscriptItem
      if (!contentInMessage || rest.item.type !== 'message') return payload
      lookup ??= toolMessageLookup(db, conversationId)
      return { ...rest, item: { ...rest.item, content: lookup.byId(rest.item.id) ?? rest.item.content } }
    }
    return payload
  }
}

/**
 * Drop the tool output copies a settled turn left in the event log. Each copy
 * is removed only after it is confirmed identical to the saved tool message,
 * so reading the event back yields exactly what was stored.
 */
export function slimSettledToolEvents(db: Database.Database, conversationId: string): number {
  const cursor = latestMessageEventSequence(db, conversationId)
  if (!cursor) return 0
  const rows = db.prepare(`
    SELECT sequence, event_json FROM chat_events
    WHERE conversation_id = ? AND sequence <= ? AND (
      (json_extract(event_json, '$.type') = 'tool-results' AND json_extract(event_json, '$.items[0].outputInMessage') IS NULL)
      OR (json_extract(event_json, '$.type') = 'transcript-item' AND json_extract(event_json, '$.item.role') = 'tool'
        AND json_extract(event_json, '$.contentInMessage') IS NULL)
    )
  `).all(conversationId, cursor) as Array<{ sequence: number; event_json: string }>
  if (!rows.length) return 0
  const lookup = toolMessageLookup(db, conversationId)
  const update = db.prepare('UPDATE chat_events SET event_json = ? WHERE sequence = ?')
  let slimmed = 0
  db.transaction(() => {
    for (const row of rows) {
      const payload = JSON.parse(row.event_json) as ChatEventPayload
      let next: ChatEventPayload | null = null
      if (payload.type === 'tool-results') {
        let changed = false
        const items = payload.items.map((item) => {
          const [first, ...others] = item.content
          if ((item as StoredToolResult).outputInMessage || first?.type !== 'text' || others.some((block) => block.type === 'text')) return item
          const blocks = lookup.byCallId(item.callId)
          if (!blocks || textOf(blocks) !== first.text) return item
          changed = true
          return { ...item, content: others, outputInMessage: true }
        })
        if (changed) next = { ...payload, items } as ChatEventPayload
      } else if (payload.type === 'transcript-item' && payload.item.type === 'message') {
        const blocks = lookup.byId(payload.item.id)
        if (blocks && JSON.stringify(blocks) === JSON.stringify(payload.item.content)) {
          next = { ...payload, item: { ...payload.item, content: [] }, contentInMessage: true } as ChatEventPayload
        }
      }
      if (!next) continue
      update.run(JSON.stringify(next), row.sequence)
      slimmed++
    }
  })()
  return slimmed
}

/** Compact one conversation's event log once its turn has settled. */
export function compactSettledChatEvents(db: Database.Database, conversationId: string): void {
  pruneSettledStreamDeltas(db, conversationId)
  slimSettledToolEvents(db, conversationId)
}

/** Sequence of the latest saved message; clients resume event replay after it when opening a chat. */
export function latestMessageEventSequence(db: Database.Database, conversationId: string): number {
  return (db.prepare(`
    SELECT MAX(sequence) AS sequence FROM chat_events
    WHERE conversation_id = ? AND json_extract(event_json, '$.type') = 'transcript-item'
      AND json_extract(event_json, '$.item.type') = 'message'
  `).get(conversationId) as { sequence: number | null }).sequence ?? 0
}

/**
 * Drop streamed token deltas that a saved message already supersedes. Replay
 * starts after the latest saved message, so earlier deltas are never read again;
 * they make up most of the event log by row count.
 */
export function pruneSettledStreamDeltas(db: Database.Database, conversationId: string): number {
  const cursor = latestMessageEventSequence(db, conversationId)
  if (!cursor) return 0
  return db.prepare(`
    DELETE FROM chat_events
    WHERE conversation_id = ? AND sequence < ? AND json_extract(event_json, '$.type') = 'content-delta'
  `).run(conversationId, cursor).changes
}

/** Compact every conversation, yielding between them so startup traffic is not blocked. */
export async function compactAllSettledChatEvents(db: Database.Database): Promise<void> {
  const conversationIds = db.prepare('SELECT id FROM conversations').pluck().all() as string[]
  for (const conversationId of conversationIds) {
    compactSettledChatEvents(db, conversationId)
    await new Promise((resolve) => setImmediate(resolve))
  }
}
