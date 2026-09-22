export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

/** Provider-neutral, persisted content. URLs point to Cynosure artifacts. */
export type ContentBlock =
  | { type: 'text' | 'reasoning'; text: string }
  | { type: 'image' | 'video' | 'audio'; artifactId: string; url: string }
  | { type: 'file'; artifactId: string; name: string; url?: string }
  | { type: 'structured'; value: unknown }

export interface MessageItem {
  type: 'message'
  id: string
  role: ChatRole
  content: ContentBlock[]
  createdAt: number
  executionId?: string
  agentId?: string
  invocationId?: string
  agentName?: string
  agentIconUrl?: string | null
  maCodename?: string
  maAgentName?: string
}

export interface ToolCallItem {
  type: 'tool-call'
  id: string
  executionId: string
  taskId?: string
  iteration?: number
  callId: string
  name: string
  arguments: string
  parentInvocationId?: string
  invocationId?: string
  createdAt: number
}

export interface ToolResultItem {
  type: 'tool-result'
  id: string
  executionId: string
  taskId?: string
  iteration?: number
  callId: string
  name: string
  invocationId?: string
  content: ContentBlock[]
  success: boolean
  createdAt: number
}

export interface ExecutionMarkerItem {
  type: 'execution-marker'
  id: string
  executionId: string
  taskId?: string
  status: 'started' | 'completed' | 'cancelled' | 'failed' | 'compacted'
  createdAt: number
  parentInvocationId?: string
  maCodename?: string
  detail?: string
}

export type TranscriptItem = MessageItem | ToolCallItem | ToolResultItem | ExecutionMarkerItem

export interface ChatEventBase {
  version: 1
  conversationId: string
  executionId: string
  sequence: number
  createdAt: number
}

export type ChatEvent = ChatEventBase & (
  | { type: 'transcript-item'; item: TranscriptItem }
  | { type: 'tool-calls'; items: ToolCallItem[] }
  | { type: 'tool-results'; items: ToolResultItem[] }
  | { type: 'execution-step'; taskId: string; iteration: number; status: string; message?: string; maCodename?: string; maAgentName?: string; invocationId?: string }
  | { type: 'stream-start'; streamId: string; scope: 'main' | 'subagent'; agentId?: string; agentName?: string; agentIconUrl?: string | null; invocationId?: string; maCodename?: string; maAgentName?: string; parentInvocationId?: string }
  | { type: 'content-delta'; streamId: string; scope: 'main' | 'subagent'; block: { type: 'text' | 'reasoning'; text: string } }
  | { type: 'media-added'; streamId: string; scope: 'main' | 'subagent'; blocks: ContentBlock[] }
  | { type: 'stream-reset' | 'stream-discard'; streamId: string; scope: 'main' | 'subagent' }
  | { type: 'stream-end'; streamId: string; scope: 'main' | 'subagent'; cancelled?: boolean; model?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; contextTokens?: number; contextWindow?: number; images?: string[] }
  | { type: 'stream-error'; streamId: string; scope: 'main' | 'subagent'; error: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number; totalTokens: number; contextTokens?: number; contextWindow?: number; model?: string }
  | { type: 'execution-state'; agentId: string | null; state: 'running' | 'stopped' | 'finished' }
  | { type: 'queue-changed' }
  | { type: 'title-updated'; title: string }
  | { type: 'post-action'; action: string; status: 'started' | 'completed' }
  | { type: 'quick-responses'; messageId: string | null; suggestions: string[] }
  | { type: 'compact-start' }
  | { type: 'compact-error'; error: string }
  | { type: 'compact-event'; messageId: string; summary: string; compactedMessageCount: number; model: string }
)

export type ContextStrategy = 'sliding-window' | 'truncate-middle' | 'compact' | 'none'

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ContextEvidenceKind = 'memory-chunk' | 'graph-assertion' | 'attachment-chunk'
export type ContextVerificationStatus = 'verified' | 'ranked-fallback'

export interface ContextEvidence {
  kind: ContextEvidenceKind
  sourceId: string
  documentId?: string
  revision?: string
  chunkIndex?: number
  retrievalMethod: string
  selectionMethod: string
  relevance?: number
  verificationStatus: ContextVerificationStatus
}

export interface SubAgentAssignmentDto {
  agentId: string
}

export interface ChatRunConfig {
  model?: string
  providerOverride?: string
  allowedTools?: string[]
  systemPrompt?: string
  generateTitle?: boolean
  /** Experimental: generate up to three suggested user follow-ups after a turn. */
  generateQuickResponses?: boolean
  subAgents?: SubAgentAssignmentDto[]
  memoryFolderIds?: string[]
  thinkingEnabled?: boolean
  reasoningEffort?: ReasoningEffort
  contextStrategy?: ContextStrategy
  titleProviderId?: string
  titleModel?: string
  autoToolRouting?: boolean
  autoMemory?: boolean
  autoRouterProviderId?: string
  autoRouterModel?: string
  compactProviderId?: string
  compactModel?: string
  inlineAttachmentTextLimit?: number
  /** Capture the exact gateway context for the opt-in chat debug inspector. */
  debugMode?: boolean
}

export interface DebugContextTool {
  name: string
  title?: string
  description: string
  parameters: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

export interface DebugContextMessage {
  role: ChatRole
  content: unknown
  toolCalls?: unknown[]
  toolCallId?: string
  metadata?: Record<string, unknown>
}

export interface DebugContextRound {
  round: number
  /** Execution phase that issued this model request. Older captures default to main-agent. */
  phase?: 'task-context' | 'memory-curation' | 'tool-curation' | 'toolset-selection' | 'main-agent'
  label?: string
  providerId?: string
  capturedAt: number
  request: {
    messages: DebugContextMessage[]
    tools: DebugContextTool[]
    model?: string
    temperature?: number
    maxTokens?: number
    thinkingEnabled?: boolean
    reasoningEffort?: ReasoningEffort
    toolChoice?: { type: 'function'; name: string }
  }
  response?: {
    content: string
    thinking: string
    toolCalls?: unknown[]
    images?: string[]
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
    error?: string
    completedAt: number
  }
}

export interface DebugContextSnapshot {
  conversationId: string
  executionId: string
  createdAt: number
  updatedAt: number
  providerId?: string
  model?: string
  contextWindow?: number
  contextStrategy?: ContextStrategy
  /** Structured evidence that was serialized into the main model turn. */
  evidence?: ContextEvidence[]
  rounds: DebugContextRound[]
  limitations: string[]
}

export interface ChatAttachmentInput {
  name: string
  content?: string
  /** Server-side preprocessed draft attachment. Content is omitted when this is set. */
  stagedId?: string
  /** Persisted attachment selected from the library; its parsed text and vectors are reused. */
  existingAttachmentId?: string
}

export interface ChatResendAttachments {
  imageDataUrls?: string[]
  audioDataUrls?: string[]
  files?: ChatAttachmentInput[]
}

export interface ChatSendRequest {
  content: string
  messageId?: string
  imageDataUrls?: string[]
  audioDataUrls?: string[]
  files?: ChatAttachmentInput[]
  run: ChatRunConfig
}

export type ChatQueueDelivery = 'next' | 'steer'
export type ChatQueueStatus = 'pending' | 'paused'

export interface QueuedChatAttachment {
  id: string
  kind: 'image' | 'audio' | 'file'
  name: string
  url?: string
}

export interface QueuedChatMessageDto {
  id: string
  conversationId: string
  content: string
  delivery: ChatQueueDelivery
  status: ChatQueueStatus
  position: number
  attachments: QueuedChatAttachment[]
  run: ChatRunConfig
  createdAt: number
  updatedAt: number
}

export interface ChatQueueStateDto {
  conversationId: string
  paused: boolean
  items: QueuedChatMessageDto[]
}

export interface ChatQueueRequest extends ChatSendRequest {
  delivery: ChatQueueDelivery
}

export interface ConversationExecutionConfig {
  allowedTools: string[]
  subAgents: SubAgentAssignmentDto[]
  memoryFolderIds: string[]
  systemPrompt: string
  model: string
  providerId: string
  thinkingEnabled: boolean
  reasoningEffort: ReasoningEffort
  autoToolRouting: boolean
  autoMemory: boolean
  autoRouterProviderId?: string
  autoRouterModel?: string
}

export interface ConversationMetadata {
  channelKey?: string
  archived?: number | boolean | string
  titleGenerated?: boolean | number
}

export interface ConversationDto {
  id: string
  title: string
  agentId: string | null
  maWorkspaceId: string | null
  origin: string
  createdAt: number
  updatedAt: number
}

export interface ConversationListItemDto {
  id: string
  title: string
  agent_id: string | null
  ma_workspace_id: string | null
  origin: string
  pinned: number
  last_read_at: number | null
  created_at: number
  updated_at: number
  last_user_message: string | null
}

export interface StoredMessageDto {
  id: string
  conversationId: string
  sequence?: number
  role: ChatRole | string
  content: string
  /** Canonical content; legacy scalar/media fields remain for older clients. */
  contentBlocks?: ContentBlock[]
  thinking?: string
  toolCalls?: unknown[]
  toolCallId?: string
  imageDataUrls?: string[]
  videoDataUrls?: string[]
  audioDataUrls?: string[]
  structuredContent?: unknown
  /** Exact retrieval evidence associated with this assistant turn. */
  contextEvidence?: ContextEvidence[]
  fileAttachments?: { id?: string; name: string; href?: string }[]
  agentId?: string
  agentName?: string
  agentIconUrl?: string | null
  maCodename?: string
  maAgentName?: string
  maInvocationId?: string
  provider?: string | null
  model?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  contextTokens?: number | null
  latencyMs?: number | null
  createdAt: number
}

export interface ConversationMessagesResponse {
  conversationAgentId: string | null
  messages: StoredMessageDto[]
  /** Highest persisted message event included in this snapshot; later stream events must replay. */
  latestEventSequence: number
  lastContextTokens: number | null
  executionConfig: ConversationExecutionConfig
}
