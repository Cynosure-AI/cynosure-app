import type { MessageItem } from '@shared/types'
import type { DisplayMessage } from '../stores/chat.store'

/** The single projection from persisted/live transcript messages to the chat view. */
export function toDisplayMessage(item: MessageItem, sequence = item.sequence): DisplayMessage {
  const text = item.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')
  const message: DisplayMessage = {
    id: item.id,
    sequence,
    toolCallIds: item.toolCallIds,
    toolCalls: item.toolCalls,
    toolCallId: item.toolCallId,
    toolSuccess: item.toolSuccess,
    streamId: item.role === 'assistant' ? item.executionId : undefined,
    role: item.role,
    isError: item.isError,
    content: text,
    thinking: item.content.flatMap((block) => block.type === 'reasoning' ? [block.text] : []).join('') || undefined,
    imageDataUrls: item.content.flatMap((block) => block.type === 'image' ? [block.url] : []),
    videoDataUrls: item.content.flatMap((block) => block.type === 'video' ? [block.url] : []),
    audioDataUrls: item.content.flatMap((block) => block.type === 'audio' ? [block.url] : []),
    structuredContent: item.content.flatMap((block) => block.type === 'structured' ? [block.value] : [])[0],
    fileAttachments: item.content.flatMap((block) => block.type === 'file' ? [{ name: block.name, href: block.url }] : []),
    contextEvidence: item.contextEvidence,
    agentId: item.agentId,
    agentName: item.agentName,
    agentIconUrl: item.agentIconUrl,
    maCodename: item.maCodename,
    maAgentName: item.maAgentName,
    maInvocationId: item.invocationId,
    provider: item.provider || undefined,
    model: item.model || undefined,
    promptTokens: item.promptTokens ?? undefined,
    completionTokens: item.completionTokens ?? undefined,
    contextTokens: item.contextTokens ?? undefined,
    latencyMs: item.latencyMs ?? undefined,
    createdAt: item.createdAt,
  }
  const compactPrefix = '[CONTEXT_COMPACT_EVENT] '
  if (item.role === 'system' && text.startsWith(compactPrefix)) {
    try {
      message.compactEventData = JSON.parse(text.slice(compactPrefix.length))
    } catch { /* Invalid markers remain ordinary system messages. */ }
  }
  return message
}
