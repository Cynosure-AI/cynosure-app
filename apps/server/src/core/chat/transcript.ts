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

export function listChatEvents(db: Database.Database, conversationId: string, after = 0, limit = 1000): ChatEvent[] {
  const rows = db.prepare('SELECT sequence, execution_id, event_json, created_at FROM chat_events WHERE conversation_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
    .all(conversationId, after, limit) as Array<{ sequence: number; execution_id: string; event_json: string; created_at: number }>
  return rows.map((row) => ({ ...JSON.parse(row.event_json) as ChatEventPayload, version: 1, conversationId, executionId: row.execution_id, sequence: row.sequence, createdAt: row.created_at }) as ChatEvent)
}
