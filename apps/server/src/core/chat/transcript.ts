import type { ContentBlock, StoredMessageDto, TranscriptItem } from '@shared/types'

/** Compatibility projection for rows written before content_blocks_json and by older writers. */
export function blocksFromStoredMessage(message: StoredMessageDto): ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (message.content) blocks.push({ type: 'text', text: message.content })
  if (message.thinking) blocks.push({ type: 'reasoning', text: message.thinking })
  for (const url of message.imageDataUrls || []) blocks.push({ type: 'image', url })
  for (const url of message.videoDataUrls || []) blocks.push({ type: 'video', url })
  for (const url of message.audioDataUrls || []) blocks.push({ type: 'audio', url })
  for (const file of message.fileAttachments || []) {
    blocks.push({ type: 'file', name: file.name, url: file.href })
  }
  if (message.structuredContent !== undefined) {
    blocks.push({ type: 'structured', value: message.structuredContent })
  }
  return blocks
}

export function readContentBlocks(json: string | null, message: StoredMessageDto): ContentBlock[] {
  if (json) {
    try {
      const blocks: unknown = JSON.parse(json)
      if (Array.isArray(blocks) && blocks.every((block: unknown) => {
        if (!block || typeof block !== 'object' || !('type' in block)) return false
        const value = block as Record<string, unknown>
        switch (value.type) {
          case 'text':
          case 'reasoning': return typeof value.text === 'string'
          case 'image':
          case 'video':
          case 'audio': return typeof value.url === 'string'
          case 'file': return typeof value.name === 'string' &&
            (value.url === undefined || typeof value.url === 'string')
          case 'structured': return 'value' in value
          default: return false
        }
      })) return blocks as ContentBlock[]
    } catch { /* Old or damaged rows fall back to legacy columns. */ }
  }
  return blocksFromStoredMessage(message)
}

export function toTranscriptItems(message: StoredMessageDto): TranscriptItem[] {
  const blocks = message.blocks ?? blocksFromStoredMessage(message)
  if (message.role === 'tool') {
    return [{
      type: 'tool-result',
      id: message.id,
      conversationId: message.conversationId,
      callId: message.toolCallId ?? message.id,
      blocks,
      createdAt: message.createdAt,
      invocationId: message.maInvocationId,
    }]
  }

  const role = message.role === 'assistant' || message.role === 'user' || message.role === 'system'
    ? message.role
    : 'system'
  const items: TranscriptItem[] = [{
    type: 'message',
    id: message.id,
    conversationId: message.conversationId,
    role,
    blocks,
    createdAt: message.createdAt,
    agentId: message.agentId,
    agentName: message.agentName,
    agentIconUrl: message.agentIconUrl,
    invocationId: message.maInvocationId,
    provider: message.provider,
    model: message.model,
    contextEvidence: message.contextEvidence,
    usage: {
      promptTokens: message.promptTokens,
      completionTokens: message.completionTokens,
      contextTokens: message.contextTokens,
      latencyMs: message.latencyMs,
    },
  }]
  if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
    for (const [index, value] of message.toolCalls.entries()) {
      if (!value || typeof value !== 'object') continue
      const call = value as { id?: string; function?: { name?: string; arguments?: unknown } }
      if (!call.function?.name) continue
      let args: unknown = call.function.arguments
      if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { /* Preserve invalid source as text. */ }
      }
      items.push({
        type: 'tool-call',
        id: `${message.id}:call:${index}`,
        conversationId: message.conversationId,
        callId: call.id ?? `${message.id}:call:${index}`,
        name: call.function.name,
        arguments: args,
        createdAt: message.createdAt,
        invocationId: message.maInvocationId,
      })
    }
  }
  return items
}
