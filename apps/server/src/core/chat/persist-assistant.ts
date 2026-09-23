import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { ContextEvidence } from '@shared/types'
import { messageContentJson, messageToTranscriptItem, publishChatEvent, type MessageFields } from './transcript.js'

export interface AssistantTurnInput {
  conversationId: string
  streamId?: string
  content: string
  thinking?: string
  images?: string[]
  videos?: string[]
  contextEvidence?: ContextEvidence[]
  agentId?: string | null
  provider?: string | null
  model?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  contextTokens?: number | null
  startedAt?: number
  generatedMedia?: boolean
  isError?: boolean
}

/** One persistence and publication path for chat, video, and transcription turns. */
export function persistAssistantTurn(
  db: Database.Database,
  broadcast: (event: string, data: unknown) => void,
  input: AssistantTurnInput,
): MessageFields & { conversationId: string; contextEvidence?: ContextEvidence[]; provider?: string; model?: string; promptTokens?: number; completionTokens?: number; contextTokens?: number; latencyMs?: number } {
  const id = nanoid()
  const createdAt = Date.now()
  const message = {
    id, conversationId: input.conversationId, role: 'assistant', content: input.content,
    isError: input.isError || undefined,
    thinking: input.thinking || undefined,
    imageDataUrls: input.images?.length ? input.images : undefined,
    videoDataUrls: input.videos?.length ? input.videos : undefined,
    contextEvidence: input.contextEvidence?.length ? input.contextEvidence : undefined,
    agentId: input.agentId || undefined,
    provider: input.provider || undefined,
    model: input.model || undefined,
    promptTokens: input.promptTokens ?? undefined,
    completionTokens: input.completionTokens ?? undefined,
    contextTokens: input.contextTokens ?? undefined,
    latencyMs: input.startedAt === undefined ? undefined : createdAt - input.startedAt,
    createdAt,
  }
  db.transaction(() => {
    db.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, content, content_blocks_json,
        generated_media, is_error, memory_sources_json, agent_id, provider, model,
        prompt_tokens, completion_tokens, context_tokens, latency_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.conversationId, 'assistant', input.content, messageContentJson(message),
      input.generatedMedia ? 1 : 0, input.isError ? 1 : 0,
      message.contextEvidence ? JSON.stringify(message.contextEvidence) : null,
      input.agentId || null, input.provider || null, input.model || null,
      input.promptTokens ?? null, input.completionTokens ?? null, input.contextTokens ?? null,
      message.latencyMs ?? null, createdAt,
    )
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(createdAt, input.conversationId)
  })()
  publishChatEvent(broadcast, {
    conversationId: input.conversationId,
    executionId: input.streamId || 'external',
    payload: { type: 'transcript-item', item: messageToTranscriptItem(message, input.streamId) },
  })
  return message
}
