export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

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
  role: ChatRole | string
  content: string
  thinking?: string
  toolCalls?: unknown[]
  toolCallId?: string
  imageDataUrls?: string[]
  videoDataUrls?: string[]
  audioDataUrls?: string[]
  structuredContent?: unknown
  /** Exact retrieval evidence associated with this assistant turn. */
  contextEvidence?: ContextEvidence[]
  fileAttachments?: { name: string; href?: string }[]
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
  lastContextTokens: number | null
  executionConfig: ConversationExecutionConfig
}
