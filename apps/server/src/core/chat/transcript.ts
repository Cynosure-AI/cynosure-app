import type Database from 'better-sqlite3'
import type { ChatEvent, ContentBlock, MessageItem, StoredMessageDto } from '@shared/types'
import type { ContentPart } from '../gateway/providers/base.provider.js'

export function messageContentBlocks(message: Pick<StoredMessageDto, 'id' | 'content' | 'thinking' | 'imageDataUrls' | 'videoDataUrls' | 'audioDataUrls' | 'fileAttachments' | 'structuredContent'>): ContentBlock[] {
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

export function messageToTranscriptItem(message: StoredMessageDto, executionId?: string): MessageItem {
  return {
    type: 'message', id: message.id,
    role: message.role === 'user' || message.role === 'assistant' || message.role === 'system' || message.role === 'tool' ? message.role : 'assistant',
    content: message.contentBlocks || messageContentBlocks(message),
    createdAt: message.createdAt,
    executionId,
    agentId: message.agentId,
    invocationId: message.maInvocationId,
    agentName: message.agentName,
    agentIconUrl: message.agentIconUrl,
    maCodename: message.maCodename,
    maAgentName: message.maAgentName,
  }
}

type EventPayload = ChatEvent extends infer Event
  ? Event extends ChatEvent ? Omit<Event, 'version' | 'conversationId' | 'executionId' | 'sequence' | 'createdAt'> : never
  : never

/** Compatibility adapter for the existing emitters. Unknown events are deliberately excluded. */
export function legacyChatEvent(event: string, data: Record<string, unknown>): EventPayload | null {
  if (event === 'agent:execution-update' && data.data && typeof data.data === 'object') {
    const step = data.data as Record<string, unknown>
    const taskId = str(step.taskId) || 'task'
    const iteration = num(step.iteration)
    const executionId = str(step.executionId) || taskId
    const createdAt = Date.now()
    if (data.event === 'task:started' || data.event === 'task:completed' || data.event === 'task:error') {
      const status = data.event === 'task:started' ? 'started' : data.event === 'task:completed' ? 'completed'
        : step.error === 'Cancelled' ? 'cancelled' : 'failed'
      return { type: 'transcript-item', item: { type: 'execution-marker', id: `${taskId}:${status}:${createdAt}`,
        executionId, taskId: str(step.taskId), status, createdAt, parentInvocationId: str(step.maInvocationId),
        maCodename: str(step.maCodename), detail: str(step.error) } }
    }
    if (data.event === 'step:status') {
      return { type: 'execution-step', taskId, iteration, status: str(step.status) || '', message: str(step.message),
        maCodename: str(step.maCodename), maAgentName: str(step.maAgentName), invocationId: str(step.maInvocationId) }
    }
    if (data.event === 'step:tools-chosen' && Array.isArray(step.toolCalls)) {
      return { type: 'tool-calls', items: step.toolCalls.map((raw, index) => {
        const call = raw as Record<string, unknown>
        const name = str(call.name) || ''
        const args = str(call.arguments) || '{}'
        const callId = str(call.id) || `${taskId}:${iteration}:${index}`
        return { type: 'tool-call', id: `call:${callId}`, executionId, taskId, iteration, callId, name, arguments: args,
          parentInvocationId: str(step.maInvocationId), invocationId: delegatedInvocationId(name, args), createdAt }
      }) }
    }
    if (data.event === 'step:executed' && Array.isArray(step.results)) {
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
  const streamId = typeof data.streamId === 'string' ? data.streamId : ''
  const suffix = event.startsWith('chat:subagent-stream-') ? event.slice('chat:subagent-stream-'.length)
    : event.startsWith('chat:stream-') ? event.slice('chat:stream-'.length) : ''
  const scope = event.startsWith('chat:subagent-stream-') ? 'subagent' : 'main'
  if (suffix === 'start') return { type: 'stream-start', streamId, scope, agentId: str(data.agentId), agentName: str(data.agentName), agentIconUrl: str(data.agentIconUrl), invocationId: str(data.maInvocationId), maCodename: str(data.maCodename), maAgentName: str(data.maAgentName) }
  if (suffix === 'chunk' && typeof data.content === 'string') return { type: 'content-delta', streamId, scope, block: { type: 'text', text: data.content } }
  if (suffix === 'thinking' && typeof data.thinking === 'string') return { type: 'content-delta', streamId, scope, block: { type: 'reasoning', text: data.thinking } }
  if (suffix === 'images' || suffix === 'videos') {
    const urls = data[suffix]
    if (!Array.isArray(urls)) return null
    return { type: 'media-added', streamId, scope, blocks: urls.filter((url): url is string => typeof url === 'string').map((url) => ({ type: suffix === 'images' ? 'image' : 'video', artifactId: url, url })) }
  }
  if (suffix === 'reset' || suffix === 'discard') return { type: `stream-${suffix}`, streamId, scope }
  if (suffix === 'end') return { type: 'stream-end', streamId, scope, cancelled: data.cancelled === true, model: str(data.model), usage: usageOf(data.usage), contextTokens: typeof data.contextTokens === 'number' ? data.contextTokens : undefined, contextWindow: typeof data.contextWindow === 'number' ? data.contextWindow : undefined, images: Array.isArray(data.images) ? data.images.filter((url): url is string => typeof url === 'string') : undefined }
  if (suffix === 'error' && typeof data.error === 'string') return { type: 'stream-error', streamId, scope, error: data.error }
  if (suffix === 'usage' && data.usage && typeof data.usage === 'object') {
    const usage = data.usage as Record<string, unknown>
    return { type: 'usage', promptTokens: num(usage.promptTokens), completionTokens: num(usage.completionTokens), totalTokens: num(usage.totalTokens), contextTokens: typeof data.contextTokens === 'number' ? data.contextTokens : undefined, contextWindow: typeof data.contextWindow === 'number' ? data.contextWindow : undefined, model: str(data.model) }
  }
  if (event === 'chat:new-message' && data.message && typeof data.message === 'object') {
    const message = data.message as StoredMessageDto
    if (typeof message.id !== 'string' || typeof message.createdAt !== 'number') return null
    return { type: 'transcript-item', item: messageToTranscriptItem(message, str(data.executionId)) }
  }
  if (event === 'chat:execution-state' && (data.state === 'running' || data.state === 'stopped' || data.state === 'finished')) {
    return { type: 'execution-state', state: data.state, agentId: str(data.agentId) || null }
  }
  if (event === 'chat:queue-changed') return { type: 'queue-changed' }
  if (event === 'chat:title-updated' && typeof data.title === 'string') return { type: 'title-updated', title: data.title }
  if (event === 'chat:post-action' && typeof data.action === 'string' && (data.status === 'started' || data.status === 'completed')) {
    return { type: 'post-action', action: data.action, status: data.status }
  }
  if (event === 'chat:quick-responses' && Array.isArray(data.suggestions)) {
    return { type: 'quick-responses', messageId: str(data.messageId) || null, suggestions: data.suggestions.filter((value): value is string => typeof value === 'string') }
  }
  if (event === 'chat:compact-start') return { type: 'compact-start' }
  if (event === 'chat:compact-error' && typeof data.error === 'string') return { type: 'compact-error', error: data.error }
  if (event === 'chat:compact-event' && typeof data.messageId === 'string' && typeof data.summary === 'string') {
    return { type: 'compact-event', messageId: data.messageId, summary: data.summary, compactedMessageCount: num(data.compactedMessageCount), model: str(data.model) || '' }
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
function usageOf(value: unknown): { promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Record<string, unknown>
  return { promptTokens: num(usage.promptTokens), completionTokens: num(usage.completionTokens), totalTokens: num(usage.totalTokens) }
}

export function appendChatEvent(db: Database.Database, event: string, data: Record<string, unknown>): ChatEvent | null {
  const nested = data.data && typeof data.data === 'object' ? data.data as Record<string, unknown> : data
  const conversationId = str(data.conversationId) || str(nested.conversationId)
  const payload = legacyChatEvent(event, data)
  if (!conversationId || !payload) return null
  if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) return null
  const executionId = str(data.executionId) || str(nested.executionId) || str(data.streamId) || str(nested.taskId) || 'external'
  const createdAt = Date.now()
  const result = db.prepare('INSERT INTO chat_events (conversation_id, execution_id, event_json, created_at) VALUES (?, ?, ?, ?)')
    .run(conversationId, executionId, JSON.stringify(payload), createdAt)
  return { ...payload, version: 1, conversationId, executionId, sequence: Number(result.lastInsertRowid), createdAt } as ChatEvent
}

export function listChatEvents(db: Database.Database, conversationId: string, after = 0, limit = 1000): ChatEvent[] {
  const rows = db.prepare('SELECT sequence, execution_id, event_json, created_at FROM chat_events WHERE conversation_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
    .all(conversationId, after, limit) as Array<{ sequence: number; execution_id: string; event_json: string; created_at: number }>
  return rows.map((row) => ({ ...JSON.parse(row.event_json) as EventPayload, version: 1, conversationId, executionId: row.execution_id, sequence: row.sequence, createdAt: row.created_at }) as ChatEvent)
}
