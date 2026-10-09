export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

/** Provider-neutral, persisted content. URLs point to Cynosure artifacts. */
export type ContentBlock =
  | { type: 'text' | 'reasoning'; text: string }
  | { type: 'image' | 'video' | 'audio'; artifactId: string; url: string }
  | { type: 'file'; artifactId: string; name: string; url?: string }
  | { type: 'structured'; value: unknown }

/** Saved call identity and arguments, independent of execution-event history. */
export interface MessageToolCall {
  id: string
  name: string
  arguments: string
}

export interface MessageItem {
  type: 'message'
  id: string
  role: ChatRole
  isError?: boolean
  /** The reply was stopped by the user before the model finished it. */
  stopped?: boolean
  content: ContentBlock[]
  createdAt: number
  executionId?: string
  agentId?: string
  invocationId?: string
  agentName?: string
  agentIconUrl?: string | null
  maCodename?: string
  maAgentName?: string
  /** Sequence of the event that first published this persisted message. */
  sequence?: number
  /** Tool calls requested by this assistant message, for transcript ordering. */
  toolCallIds?: string[]
  toolCalls?: MessageToolCall[]
  toolCallId?: string
  toolSuccess?: boolean
  contextEvidence?: ContextEvidence[]
  provider?: string | null
  model?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  contextTokens?: number | null
  latencyMs?: number | null
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
  | { type: 'routing-decision'; taskId: string; phase: 'task-context' | 'toolsets' | 'tools' | 'memory-candidates' | 'memory-context'; entries: Array<{ name: string; details: Record<string, unknown> }>; maCodename?: string; maAgentName?: string; parentInvocationId?: string }
  | { type: 'execution-step'; taskId: string; iteration: number; status: string; message?: string; maCodename?: string; maAgentName?: string; invocationId?: string }
  | { type: 'stream-start'; streamId: string; scope: 'main' | 'subagent'; agentId?: string; agentName?: string; agentIconUrl?: string | null; invocationId?: string; maCodename?: string; maAgentName?: string; parentInvocationId?: string }
  | { type: 'content-delta'; streamId: string; scope: 'main' | 'subagent'; block: { type: 'text' | 'reasoning'; text: string } }
  | { type: 'media-added'; streamId: string; scope: 'main' | 'subagent'; blocks: ContentBlock[] }
  | { type: 'stream-reset' | 'stream-discard'; streamId: string; scope: 'main' | 'subagent' }
  | { type: 'stream-end'; streamId: string; scope: 'main' | 'subagent'; cancelled?: boolean; model?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; contextTokens?: number; contextWindow?: number; images?: string[] }
  | { type: 'stream-error'; streamId: string; scope: 'main' | 'subagent'; error: string }
  | { type: 'usage'; scope?: 'main' | 'subagent'; promptTokens: number; completionTokens: number; totalTokens: number; contextTokens?: number; contextWindow?: number; model?: string }
  | { type: 'execution-state'; agentId: string | null; state: 'running' | 'stopped' | 'finished' }
  | { type: 'queue-changed' }
  | { type: 'title-updated'; title: string }
  | { type: 'post-action'; action: string; status: 'started' | 'completed' }
  | { type: 'quick-responses'; messageId: string | null; suggestions: string[] }
  | { type: 'compact-start' }
  | { type: 'compact-error'; error: string }
  | { type: 'compact-event'; messageId: string; summary: string; compactedMessageCount: number; model: string }
)

export type ChatEventPayload = ChatEvent extends infer Event
  ? Event extends ChatEvent ? Omit<Event, keyof ChatEventBase> : never
  : never

export interface ChatEventDraft {
  conversationId: string
  executionId: string
  payload: ChatEventPayload
}

export type ContextStrategy = 'sliding-window' | 'truncate-middle' | 'compact' | 'none'

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Server-wide chat behavior, shared by the web UI, channels, and scheduled runs. */
export interface ChatRunSettings {
  contextStrategy: ContextStrategy
  generateTitle: boolean
  /** Empty provider and model use the conversation's model. */
  titleProviderId: string
  titleModel: string
  compactProviderId: string
  compactModel: string
}

export type ContextEvidenceKind = 'memory-chunk' | 'attachment-chunk'
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
  /** Experimental: generate up to three suggested user follow-ups after a turn. */
  generateQuickResponses?: boolean
  subAgents?: SubAgentAssignmentDto[]
  memoryFolderIds?: string[]
  thinkingEnabled?: boolean
  reasoningEffort?: ReasoningEffort
  autoToolRouting?: boolean
  autoMemory?: boolean
  autoRouterProviderId?: string
  autoRouterModel?: string
  /** Settings chosen for this message's image or video generation. */
  mediaGeneration?: MediaGenerationSettings
}

export interface MediaGenerationSettings {
  kind: 'image' | 'video'
  resolution?: string
  aspect_ratio?: string
  /** Images per call (image models only). */
  n?: number
  /** Seconds (video models only). */
  duration?: number
  generate_audio?: boolean
  /** How attached images should be used for video generation. */
  frame_mode?: 'auto' | 'first' | 'last' | 'first_last' | 'reference'
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

export interface ConversationDto {
  id: string
  title: string
  agentId: string | null
  maWorkspaceId: string | null
  projectId: string | null
  origin: string
  createdAt: number
  updatedAt: number
}

export interface ConversationMessagesResponse {
  conversationAgentId: string | null
  messages: MessageItem[]
  /** Highest persisted message event included in this snapshot; later stream events must replay. */
  latestEventSequence: number
  lastContextTokens: number | null
  executionConfig: ConversationExecutionConfig
  conversationProjectId?: string | null
}

export type ProjectTaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done'

export interface ProjectDto {
  id: string
  name: string
  description: string
  /** User-authored instructions added to every run in the project. */
  instructions: string
  /** Living summary of goal, state, decisions, and open questions, maintained by agents. */
  brief: string
  briefUpdatedAt: number | null
  /** Optional working directory; file tools may access it and the shell starts there. */
  rootPath: string
  memoryFolderId: string | null
  defaultAgentId: string | null
  color: string
  archived: boolean
  sortOrder: number
  createdAt: number
  updatedAt: number
  conversationCount?: number
  openTaskCount?: number
  lastActivityAt?: number | null
}

export interface ProjectTaskDto {
  id: string
  projectId: string
  title: string
  notes: string
  status: ProjectTaskStatus
  sortOrder: number
  assigneeAgentId: string | null
  conversationId: string | null
  createdBy: 'user' | 'agent'
  createdAt: number
  updatedAt: number
  completedAt: number | null
}
