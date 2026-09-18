import { BASE_URL, get, post, put, patch, del, onWsEvent, sendWsMessage, subscribeWsConversations } from './http'
import type {
  DreamConfig, LLMProviderConfig, McpServerInfo, McpRegistryResponse,
  AgentDefinition, AppNotification, MemoryFolder, MemoryFileStatus, MemoryFileSearchResult, MemoryIndexJob, MemoryKnowledgeStats, MemoryDocumentAnalysis, MemoryDocumentKnowledgePreview, KnowledgeSourceChunk, RuntimeLimits,
  AgentInstance, ChatExecutionState, ActivityItem, ActivityKind, ActivityTotalsByKind, StopAllActivityResult, ConversationUpload, CronJob, ExecutionStepRecord, ChannelDefinition, ChannelType, KnowledgeGraph, KnowledgeGraphSuggestionsResponse,
  MetricsSummary, PlanningState,
  ModelListType,
  ModelInfo,
  ModelListItem, StagedChatAttachment,
  VideoGenerationJob,
  VideoGenerationModelInfo,
  VideoGenerationRequest,
  TranscriptionRequest,
  TranscriptionResponse,
} from './types'
import type { WsHandler } from './http'
import type { ChatQueueRequest, ChatQueueStateDto, ChatResendAttachments, ChatSendRequest, ConversationDto, ConversationExecutionConfig, ConversationMessagesResponse, DebugContextSnapshot, QueuedChatMessageDto } from '@shared/types'

function memoryFolderPathId(id: string): string {
  return encodeURIComponent(encodeURIComponent(id))
}

// ---- API object (same shape as window.api from preload) ----

export const api = {
  userSettings: {
    get: () => get<{ name: string; avatarUrl: string | null }>('/api/user-settings'),
    update: (profile: { name: string; avatarUrl: string | null }) =>
      put<{ name: string; avatarUrl: string | null }>('/api/user-settings', profile),
  },
  provider: {
    list: () => get<LLMProviderConfig[]>('/api/providers'),
    add: (config: LLMProviderConfig) => post<{ id: string }>('/api/providers', config).then((r) => r.id),
    remove: (id: string) => del<void>(`/api/providers/${encodeURIComponent(id)}`),
    setLastUsed: (id: string) => put<void>('/api/providers/active', { id }),
    getLastUsed: () => get<{ id: string }>('/api/providers/active').then((r) => r.id),
    test: (id: string) => post<{ success: boolean }>(`/api/providers/${encodeURIComponent(id)}/test`).then((r) => r.success),
    listModels: (id: string, type?: ModelListType) => {
      const params = type ? `?type=${type}` : ''
      return get<string[]>(`/api/providers/${encodeURIComponent(id)}/models${params}`)
    },
    listModelItems: (id: string, type?: ModelListType) => {
      const params = new URLSearchParams({ details: 'true' })
      if (type) params.set('type', type)
      return get<ModelListItem[]>(`/api/providers/${encodeURIComponent(id)}/models?${params}`)
    },
    listVideoModels: (id: string) =>
      get<VideoGenerationModelInfo[]>(`/api/providers/${encodeURIComponent(id)}/videos/models`),
    generateVideo: (id: string, request: VideoGenerationRequest) =>
      post<VideoGenerationJob>(`/api/providers/${encodeURIComponent(id)}/videos`, request),
    getVideoJob: (id: string, jobId: string) =>
      get<VideoGenerationJob>(`/api/providers/${encodeURIComponent(id)}/videos/${encodeURIComponent(jobId)}`),
    getVideoContentUrl: (id: string, jobId: string, index = 0) =>
      `${BASE_URL}/api/providers/${encodeURIComponent(id)}/videos/${encodeURIComponent(jobId)}/content?index=${encodeURIComponent(String(index))}`,
    transcribeAudio: (id: string, request: TranscriptionRequest) =>
      post<TranscriptionResponse>(`/api/providers/${encodeURIComponent(id)}/transcriptions`, request),
    getModelInfo: (providerId: string, modelId: string) =>
      get<ModelInfo>(`/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/info`),
    loadSaved: () => Promise.resolve() // no-op in web — server loads on startup
  },

  chat: {
    createConversation: (title?: string, agentId?: string, maWorkspaceId?: string) =>
      post<ConversationDto>(
        '/api/chat/conversations',
        { title, agentId, maWorkspaceId }
      ),
    listConversations: (agentId?: string | null, maWorkspaceId?: string | null) => {
      const params = new URLSearchParams()
      if (maWorkspaceId) {
        params.set('maWorkspaceId', maWorkspaceId)
      } else if (agentId !== undefined) {
        params.set('agentId', agentId ?? '')
      }
      const qs = params.toString()
      return get<{ id: string; title: string; agent_id: string | null; ma_workspace_id: string | null; origin: string; pinned: number; last_read_at: number | null; created_at: number; updated_at: number; last_user_message: string | null }[]>(
        `/api/chat/conversations${qs ? `?${qs}` : ''}`
      )
    },
    listConversationsPaginated: (limit: number, offset: number, sort?: 'updated' | 'sidebar', search?: string, agentId?: string | null, filters?: string[]) => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
      if (sort) params.set('sort', sort)
      if (search) params.set('search', search)
      if (agentId !== undefined) params.set('agentId', agentId ?? '')
      if (filters?.length && !filters.includes('all')) params.set('filters', filters.join(','))
      return get<{ items: { id: string; title: string; agent_id: string | null; ma_workspace_id: string | null; origin: string; pinned: number; last_read_at: number | null; created_at: number; updated_at: number; last_user_message: string | null }[]; total: number }>(
        `/api/chat/conversations?${params}`
      )
    },
    listUploads: (limit: number, offset: number, search?: string) => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
      if (search?.trim()) params.set('search', search.trim())
      return get<{ items: ConversationUpload[]; total: number }>(`/api/chat/uploads?${params}`)
    },
    resolveUploads: (ids: string[]) =>
      post<{ files: { id: string; name: string; existingAttachmentId: string }[] }>('/api/chat/uploads/resolve', { ids }),
    resolveArtifacts: (artifacts: { id: string; href: string; label: string; kind: 'file' | 'image' | 'video' | 'audio' }[]) =>
      post<{
        images: { id: string; name: string; url: string }[]
        audio: { id: string; name: string; url: string }[]
        files: { id: string; name: string; content: string }[]
      }>('/api/chat/artifacts/resolve', { artifacts }),
    getMessages: (conversationId: string) =>
      get<ConversationMessagesResponse>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`),
    getDebugContext: (conversationId: string) =>
      get<DebugContextSnapshot>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/debug-context`),
    getExecutionSteps: (conversationId: string) =>
      get<ExecutionStepRecord[]>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/steps`),
    getPendingHITL: (conversationId: string) =>
      get<{ taskId: string; toolCalls: { name: string; arguments: string }[] }[]>(
        `/api/chat/conversations/${encodeURIComponent(conversationId)}/hitl`
      ),
    getPlanningState: (conversationId: string) =>
      get<PlanningState | null>(
        `/api/chat/conversations/${encodeURIComponent(conversationId)}/planning-state`
      ),
    deleteConversation: (conversationId: string) =>
      del<void>(`/api/chat/conversations/${encodeURIComponent(conversationId)}`),
    deleteAllConversations: (agentId?: string | null) => {
      const params = new URLSearchParams()
      if (agentId !== undefined) params.set('agentId', agentId ?? '')
      const qs = params.toString()
      return del<void>(`/api/chat/conversations${qs ? `?${qs}` : ''}`)
    },
    updateTitle: (conversationId: string, title: string) =>
      patch<void>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/title`, { title }),
    pinConversation: (conversationId: string, pinned: boolean) =>
      patch<void>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/pin`, { pinned }),
    markConversationRead: (conversationId: string) =>
      patch<void>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/read`),
    send: (conversationId: string, request: ChatSendRequest) =>
      post<void>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/send`, request),
    stageAttachment: (conversationId: string, file: { name: string; content: string; clientId?: string }, signal?: AbortSignal) =>
      post<StagedChatAttachment>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/attachments/stage`, file, signal),
    listStagedAttachments: (conversationId: string) =>
      get<StagedChatAttachment[]>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/attachments/stage`),
    onAttachmentStageProgress: (cb: (data: StagedChatAttachment) => void) =>
      onWsEvent('attachment:stage-progress', cb as WsHandler),
    removeStagedAttachment: (conversationId: string, attachmentId: string) =>
      del<{ success: boolean }>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/attachments/stage/${encodeURIComponent(attachmentId)}`),
    getQueue: (conversationId: string) =>
      get<ChatQueueStateDto>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/queue`),
    enqueue: (conversationId: string, request: ChatQueueRequest) =>
      post<QueuedChatMessageDto>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/queue`, request),
    updateQueued: (conversationId: string, queueId: string, request: ChatQueueRequest) =>
      put<QueuedChatMessageDto>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(queueId)}`, request),
    removeQueued: (conversationId: string, queueId: string) =>
      del<{ success: boolean }>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(queueId)}`),
    removeQueuedAttachment: (conversationId: string, queueId: string, attachmentId: string) =>
      del<{ success: boolean }>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(queueId)}/attachments/${encodeURIComponent(attachmentId)}`),
    steerQueued: (conversationId: string, queueId: string) =>
      post<{ success: boolean }>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(queueId)}/steer`),
    runNextQueued: (conversationId: string) =>
      post<{ success: boolean }>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/queue/run-next`),
    getAttachmentConfig: () =>
      get<{ inlineAttachmentTextLimit: number }>('/api/chat/attachment-config'),
    getMessageAttachments: (conversationId: string, messageId: string) =>
      get<ChatResendAttachments>(
        `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/attachments`
      ),
    updateAttachmentConfig: (inlineAttachmentTextLimit: number) =>
      post<{ success: boolean; inlineAttachmentTextLimit: number }>('/api/chat/attachment-config', { inlineAttachmentTextLimit }),
    truncateFrom: (conversationId: string, messageId: string) =>
      post<{ success: boolean; deleted: number }>(
        `/api/chat/conversations/${encodeURIComponent(conversationId)}/truncate`,
        { messageId }
      ),
    forkConversation: (conversationId: string, messageId: string) =>
      post<{ id: string; title: string; agentId: string | null; maWorkspaceId: string | null; origin: string; createdAt: number; updatedAt: number }>(
        `/api/chat/conversations/${encodeURIComponent(conversationId)}/fork`,
        { messageId }
      ),
    cancelStream: (streamId: string, conversationId?: string) => post<{ success: boolean; executionIds: string[] }>('/api/chat/cancel', { streamId: streamId || undefined, conversationId: conversationId || undefined }),
    subscribeLiveConversations: (conversationIds: string[]) => subscribeWsConversations(conversationIds),
    onChannelConversationState: (
      cb: (data: { conversationId: string; agentId: string; running: boolean }) => void
    ) => onWsEvent('channel:conversation-state', cb as WsHandler),
    onExecutionState: (cb: (data: ChatExecutionState) => void) =>
      onWsEvent('chat:execution-state', cb as WsHandler),
    onQueueChanged: (cb: (data: { conversationId: string }) => void) =>
      onWsEvent('chat:queue-changed', cb as WsHandler),

    // Stream event listeners — via WebSocket
    onStreamStart: (cb: (data: { streamId: string; conversationId: string; agentId?: string; agentName?: string; agentIconUrl?: string | null; maCodename?: string; maAgentName?: string; maInvocationId?: string }) => void) =>
      onWsEvent('chat:stream-start', cb as WsHandler),
    onStreamChunk: (
      cb: (data: { streamId: string; conversationId: string; content: string }) => void
    ) => onWsEvent('chat:stream-chunk', cb as WsHandler),
    onStreamThinking: (
      cb: (data: { streamId: string; conversationId: string; thinking: string }) => void
    ) => onWsEvent('chat:stream-thinking', cb as WsHandler),
    onStreamImages: (
      cb: (data: { streamId: string; conversationId: string; images: string[] }) => void
    ) => onWsEvent('chat:stream-images', cb as WsHandler),
    onStreamVideos: (
      cb: (data: { streamId: string; conversationId: string; videos: string[] }) => void
    ) => onWsEvent('chat:stream-videos', cb as WsHandler),
    onStreamEnd: (
      cb: (data: {
        streamId: string
        conversationId: string
        cancelled?: boolean
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
        model?: string
        contextWindow?: number
        contextTokens?: number
      }) => void
    ) => onWsEvent('chat:stream-end', cb as WsHandler),
    onStreamReset: (cb: (data: { streamId: string; conversationId: string }) => void) =>
      onWsEvent('chat:stream-reset', cb as WsHandler),
    onStreamDiscard: (cb: (data: { streamId: string; conversationId: string }) => void) =>
      onWsEvent('chat:stream-discard', cb as WsHandler),
    onStreamUsage: (
      cb: (data: { conversationId: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number }; model?: string; contextWindow?: number; contextTokens?: number }) => void
    ) => onWsEvent('chat:stream-usage', cb as WsHandler),
    onStreamError: (
      cb: (data: { streamId: string; conversationId: string; error: string }) => void
    ) => onWsEvent('chat:stream-error', cb as WsHandler),

    // Sub-agent stream events — dedicated handlers so the UI can manage
    // sub-agent streaming separately from the primary orchestrator stream.
    onSubAgentStreamStart: (cb: (data: { streamId: string; conversationId: string; agentId?: string; agentName?: string; agentIconUrl?: string | null; maCodename?: string; maAgentName?: string; maInvocationId?: string }) => void) =>
      onWsEvent('chat:subagent-stream-start', cb as WsHandler),
    onSubAgentStreamChunk: (
      cb: (data: { streamId: string; conversationId: string; content: string }) => void
    ) => onWsEvent('chat:subagent-stream-chunk', cb as WsHandler),
    onSubAgentStreamThinking: (
      cb: (data: { streamId: string; conversationId: string; thinking: string }) => void
    ) => onWsEvent('chat:subagent-stream-thinking', cb as WsHandler),
    onSubAgentStreamImages: (
      cb: (data: { streamId: string; conversationId: string; images: string[] }) => void
    ) => onWsEvent('chat:subagent-stream-images', cb as WsHandler),
    onSubAgentStreamEnd: (
      cb: (data: { streamId: string; conversationId: string; cancelled?: boolean; model?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }) => void
    ) => onWsEvent('chat:subagent-stream-end', cb as WsHandler),

    onTitleUpdated: (
      cb: (data: { conversationId: string; title: string }) => void
    ) => onWsEvent('chat:title-updated', cb as WsHandler),
    onNewMessage: (
      cb: (data: { conversationId: string; streamId?: string; message: { id: string; conversationId: string; role: string; content: string; createdAt: number; fileAttachments?: { name: string; href?: string }[]; agentId?: string; agentName?: string; agentIconUrl?: string | null; maCodename?: string; maAgentName?: string; maInvocationId?: string } }) => void
    ) => onWsEvent('chat:new-message', cb as WsHandler),
    onPostAction: (
      cb: (data: { conversationId: string; action: string; status: 'started' | 'completed' }) => void
    ) => onWsEvent('chat:post-action', cb as WsHandler),
    onQuickResponses: (
      cb: (data: { conversationId: string; messageId: string | null; suggestions: string[] }) => void
    ) => onWsEvent('chat:quick-responses', cb as WsHandler),
    onCompactEvent: (
      cb: (data: { conversationId: string; messageId: string; summary: string; compactedMessageCount: number; model: string; createdAt: number }) => void
    ) => onWsEvent('chat:compact-event', cb as WsHandler),
    onCompactStart: (
      cb: (data: { conversationId: string }) => void
    ) => onWsEvent('chat:compact-start', cb as WsHandler),
    onCompactError: (
      cb: (data: { conversationId: string; error: string }) => void
    ) => onWsEvent('chat:compact-error', cb as WsHandler),
    getPostActions: (conversationId: string) =>
      get<{ actions: string[]; quickResponses: { messageId: string | null; suggestions: string[] } }>(`/api/chat/post-actions?conversationId=${encodeURIComponent(conversationId)}`),
    cancelPostActions: (conversationId: string) =>
      post<{ success: boolean }>('/api/chat/post-actions/cancel', { conversationId })
  },

  agent: {
    onHITLRequest: (cb: (data: unknown) => void) =>
      onWsEvent('agent:hitl-request', cb),
    onHITLResolved: (cb: (data: unknown) => void) =>
      onWsEvent('agent:hitl-resolved', cb),
    respondHITL: (taskId: string, approved: boolean, reason?: string, approvalType?: 'once' | 'session' | 'always', conversationId?: string, toolNames?: string[]) => {
      sendWsMessage('hitl:response', { taskId, approved, reason, approvalType, conversationId, toolNames })
      return Promise.resolve()
    },
    getToolApprovals: () =>
      get<Record<string, boolean>>('/api/agents/tool-approvals'),
    setToolApproval: (toolName: string, autoApprove: boolean) =>
      put<{ success: boolean }>(`/api/agents/tool-approvals/${encodeURIComponent(toolName)}`, { autoApprove }),
    setToolApprovalsBulk: (approvals: Record<string, boolean>) =>
      put<{ success: boolean }>('/api/agents/tool-approvals', approvals),
    resetToolApprovalsToDefaults: (toolNames: string[]) =>
      post<{ success: boolean }>('/api/agents/tool-approvals/defaults', { toolNames }),
    listTools: () =>
      get<{ key: string; name: string; executionName: string; description: string; parameters: Record<string, unknown>; annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }; autoApprove: boolean; usesDefaultApproval: boolean; namespace: { id: string; label: string }; ambiguous: boolean }[]>('/api/agents/tools'),
    listPolicyTools: () =>
      get<{ key: string; name: string; executionName: string; description: string; parameters: Record<string, unknown>; annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }; autoApprove: boolean; usesDefaultApproval: boolean; namespace: { id: string; label: string }; ambiguous: boolean }[]>('/api/agents/tools'),
    onExecutionUpdate: (cb: (data: unknown) => void) =>
      onWsEvent('agent:execution-update', cb),
    onPlanningStateUpdated: (cb: (data: unknown) => void) =>
      onWsEvent('planning:state-updated', cb)
  },

  agents: {
    list: () =>
      get<AgentDefinition[]>('/api/agents'),
    get: (id: string) =>
      get<AgentDefinition>(`/api/agents/${encodeURIComponent(id)}`),
    create: (data: Partial<Omit<AgentDefinition, 'id' | 'createdAt' | 'updatedAt'>>) =>
      post<AgentDefinition>('/api/agents', data),
    update: (id: string, data: Partial<Omit<AgentDefinition, 'id' | 'createdAt' | 'updatedAt'>>) =>
      put<AgentDefinition>(`/api/agents/${encodeURIComponent(id)}`, data),
    remove: (id: string) =>
      del<{ success: boolean }>(`/api/agents/${encodeURIComponent(id)}`),
    duplicate: (id: string) =>
      post<AgentDefinition>(`/api/agents/${encodeURIComponent(id)}/duplicate`)
  },

  memory: {
    getLimits: () => get<RuntimeLimits>('/api/memory/limits'),
    getDreamConfig: () => get<DreamConfig>('/api/memory/dream/config'),
    configureDream: (config: Pick<DreamConfig, 'enabled' | 'providerId' | 'model'>) => post<DreamConfig>('/api/memory/dream/configure', config),
    cancelDreamRun: (id: string) => post<{ success: boolean }>(`/api/memory/dream/runs/${encodeURIComponent(id)}/cancel`, {}),
    onDreamUpdated: (cb: (data: { id: string; status: string }) => void) => onWsEvent('memory:dream-updated', cb as WsHandler),
    search: (query: string, topK?: number, folderId?: string) =>
      post<unknown[]>('/api/memory/search', { query, topK, folderId }),
    aggregate: (
      query: string,
      opts?: { conversationId?: string }
    ) =>
      post<{
        permanent: unknown[]
        formatted: string
      }>('/api/memory/aggregate', { query, opts }),
    getHistory: (conversationId: string) =>
      get<unknown[]>(`/api/memory/history/${encodeURIComponent(conversationId)}`),
    configureEmbeddings: (opts: {
      providerId?: string
      baseUrl?: string
      apiKey?: string
      model?: string
      dimensions?: number
      reembed?: boolean
    }) => post<{ success: boolean; vectorsDropped: boolean; reembedded: boolean; reembeddedCount: number; dimensions: number }>('/api/memory/embeddings/configure', opts),
    getEmbeddingConfig: () =>
      get<{ providerId?: string; model: string; dimensions: number }>('/api/memory/embeddings/config'),
    getDeepResearchConfig: () =>
      get<{ providerId?: string; model?: string }>('/api/memory/deep-research/config'),
    configureDeepResearch: (opts: { providerId?: string; model?: string }) =>
      post<{ success: boolean; providerId?: string; model?: string }>('/api/memory/deep-research/configure', opts),
    dropVectors: () =>
      post<{ success: boolean }>('/api/memory/embeddings/drop', {}),
    probeEmbedding: (opts: { providerId?: string; model: string }) =>
      post<{ dimensions: number }>('/api/memory/embeddings/probe', opts),
    getChunkingConfig: () =>
      get<{ chunkSize: number; chunkOverlap: number }>('/api/memory/chunking/config'),
    configureChunking: (opts: { chunkSize: number; chunkOverlap: number }) =>
      post<{ success: boolean; chunkSize: number; chunkOverlap: number }>('/api/memory/chunking/configure', opts),
    getRerankerConfig: () =>
      get<{ enabled: boolean; providerId?: string; model: string; candidateCount: number }>('/api/memory/reranker/config'),
    configureReranker: (opts: { enabled: boolean; providerId?: string; model: string; candidateCount: number }) =>
      post<{ success: boolean; enabled: boolean; providerId?: string; model: string; candidateCount: number }>('/api/memory/reranker/configure', opts),
    getGraph: (query?: string, limit?: number, view?: 'relationships' | 'visual', nodeIds?: string[], minImportance?: number | null, folderIds?: string[]) => {
      const params = new URLSearchParams()
      if (query) params.set('query', query)
      if (nodeIds?.length) params.set('nodeIds', nodeIds.join(','))
      if (limit) params.set('limit', String(limit))
      if (view) params.set('view', view)
      if (minImportance !== undefined && minImportance !== null) params.set('minImportance', String(minImportance))
      if (folderIds) params.set('folderIds', folderIds.length ? folderIds.join(',') : '__none__')
      const qs = params.toString()
      return get<KnowledgeGraph>(`/api/memory/knowledge/graph${qs ? `?${qs}` : ''}`)
    },
    getGraphSuggestions: (query: string, limit?: number, folderIds?: string[]) => {
      const params = new URLSearchParams()
      params.set('query', query)
      if (limit) params.set('limit', String(limit))
      if (folderIds) params.set('folderIds', folderIds.length ? folderIds.join(',') : '__none__')
      return get<KnowledgeGraphSuggestionsResponse>(`/api/memory/knowledge/graph/suggestions?${params.toString()}`)
    },
    updateGraphNode: (id: string, data: { name?: string; type?: KnowledgeGraph['nodes'][number]['type']; aliases?: string[]; importance?: number }) =>
      patch<KnowledgeGraph['nodes'][number]>(`/api/memory/knowledge/graph/nodes/${encodeURIComponent(id)}`, data),
    deleteGraphNode: (id: string) =>
      del<{ success: boolean }>(`/api/memory/knowledge/graph/nodes/${encodeURIComponent(id)}`),
    deleteGraphNodes: (ids: string[]) =>
      post<{ success: boolean; deleted: number }>('/api/memory/knowledge/graph/nodes/delete', { ids }),
    updateGraphEdge: (id: string, data: { relation?: string; note?: string; importance?: number }) =>
      patch<KnowledgeGraph['edges'][number]>(`/api/memory/knowledge/graph/edges/${encodeURIComponent(id)}`, data),
    deleteGraphEdge: (id: string) =>
      del<{ success: boolean; orphanedNodeIds: string[] }>(`/api/memory/knowledge/graph/edges/${encodeURIComponent(id)}`),
    deleteGraphEdges: (ids: string[]) =>
      post<{ success: boolean; deleted: number }>('/api/memory/knowledge/graph/edges/delete', { ids }),
    clearGraph: () =>
      del<{ success: boolean; nodesDeleted: number; edgesDeleted: number }>('/api/memory/knowledge/graph'),
    getKnowledgeStats: () =>
      get<MemoryKnowledgeStats>('/api/memory/knowledge/stats'),
    getKnowledgeSourceChunk: (textUnitId: string) =>
      get<KnowledgeSourceChunk>(`/api/memory/knowledge/chunks/${encodeURIComponent(textUnitId)}`),
    onReembedProgress: (cb: (data: { current: number; total: number; status: string }) => void) =>
      onWsEvent('memory:reembed-progress', cb as WsHandler),
    onGraphReset: (cb: (data: { resetAt: number }) => void) =>
      onWsEvent('memory:knowledge-reset', cb as WsHandler)
  },

  memoryFolders: {
    list: () =>
      get<MemoryFolder[]>('/api/memory-folders'),
    create: (name: string, description?: string, parentFolderPath?: string) =>
      post<MemoryFolder>('/api/memory-folders', { name, description, parentFolderPath }),
    update: (id: string, data: { name?: string; description?: string; folderPath?: string }) =>
      put<MemoryFolder>(`/api/memory-folders/${memoryFolderPathId(id)}`, data),
    remove: (id: string) =>
      del<{ success: boolean }>(`/api/memory-folders/${memoryFolderPathId(id)}`),
    reorder: (ids: string[]) =>
      put<{ success: boolean }>('/api/memory-folders/reorder', { ids }),
    listAllJobs: () =>
      get<MemoryIndexJob[]>('/api/memory-folders/jobs'),
    /** List files in the space folder with their index status. Hash computation is async server-side. */
    listFiles: (folderId: string) =>
      get<MemoryFileStatus[]>(`/api/memory-folders/${memoryFolderPathId(folderId)}/files`),
    searchFiles: (query: string, opts?: { folderId?: string; semantic?: boolean }) => {
      const params = new URLSearchParams({ query })
      if (opts?.folderId) params.set('folderId', opts.folderId)
      if (opts?.semantic) params.set('semantic', 'true')
      return get<MemoryFileSearchResult[]>(`/api/memory-folders/file-search?${params.toString()}`)
    },
    getDocumentKnowledgePreview: (folderId: string, fileName: string) =>
      get<MemoryDocumentKnowledgePreview>(
        `/api/memory-folders/${memoryFolderPathId(folderId)}/files/${encodeURIComponent(fileName)}/knowledge-preview`
      ),
    getDocumentAnalysis: (folderId: string, fileName: string) =>
      get<MemoryDocumentAnalysis>(
        `/api/memory-folders/${memoryFolderPathId(folderId)}/files/${encodeURIComponent(fileName)}/analysis`
      ),
    listJobs: (folderId: string) =>
      get<MemoryIndexJob[]>(`/api/memory-folders/${memoryFolderPathId(folderId)}/jobs`),
    rebuildKnowledge: (folderId: string) =>
      post<{ success: boolean; scheduled: number; jobs: MemoryIndexJob[]; skipped: Array<{ fileName: string; reason: string }> }>(
        `/api/memory-folders/${memoryFolderPathId(folderId)}/knowledge/rebuild`,
        {}
      ),
    getJob: (jobId: string) =>
      get<MemoryIndexJob>(`/api/memory-folders/jobs/${encodeURIComponent(jobId)}`),
    cancelJob: (jobId: string) =>
      post<MemoryIndexJob>(`/api/memory-folders/jobs/${encodeURIComponent(jobId)}/cancel`, {}),
    discardJob: (jobId: string) =>
      del<{ success: boolean }>(`/api/memory-folders/jobs/${encodeURIComponent(jobId)}`),
    dismissJobFailures: (folderId?: string) =>
      del<{ success: boolean; dismissed: number }>(
        `/api/memory-folders/jobs/failures${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''}`
      ),
    onJobUpdated: (cb: (data: MemoryIndexJob) => void) =>
      onWsEvent('memory:job-updated', cb as WsHandler),
    reindexFile: (folderId: string, fileName: string) =>
      post<{ success: boolean; chunksStored: number; fileName: string }>(
        `/api/memory-folders/${memoryFolderPathId(folderId)}/reingest-file`,
        { fileName }
      ),
    startReindexFile: (folderId: string, fileName: string) =>
      post<MemoryIndexJob<{ success: boolean; chunksStored: number; fileName: string }>>(
        `/api/memory-folders/${memoryFolderPathId(folderId)}/files/${encodeURIComponent(fileName)}/reindex-job`,
        {}
      ),
    extractKnowledgeFromFile: (folderId: string, fileName: string) =>
      post<{ success: boolean; fileName: string; insertedOrUpdated: number; deleted: number; deepResearchedAt: number; tags: string[] }>(
        `/api/memory-folders/${memoryFolderPathId(folderId)}/files/${encodeURIComponent(fileName)}/deep-research`,
        {}
      ),
    startDeepResearchFile: (folderId: string, fileName: string) =>
      post<MemoryIndexJob<{ success: boolean; fileName: string; insertedOrUpdated: number; deleted: number; deepResearchedAt: number; tags: string[] }>>(
        `/api/memory-folders/${memoryFolderPathId(folderId)}/files/${encodeURIComponent(fileName)}/deep-research-job`,
        {}
      ),
    deleteFile: (folderId: string, fileName: string) =>
      del<{ success: boolean }>(
        `/api/memory-folders/${memoryFolderPathId(folderId)}/files/${encodeURIComponent(fileName)}`
      ),
    getFileContent: (folderId: string, fileName: string) =>
      get<{ fileName: string; content: string; revision: string; documentRef?: string }>(
        `/api/memory-folders/${memoryFolderPathId(folderId)}/files/${encodeURIComponent(fileName)}/content`
      ),
    updateFileContent: (folderId: string, fileName: string, content: string, expectedRevision?: string) =>
      put<{ success: boolean; fileName: string; revision: string }>(
        `/api/memory-folders/${memoryFolderPathId(folderId)}/files/${encodeURIComponent(fileName)}/content`,
        { content, expectedRevision }
      ),
    renameFile: (folderId: string, fileName: string, nextFileName: string) =>
      put<{ success: boolean; fileName: string }>(
        `/api/memory-folders/${memoryFolderPathId(folderId)}/files/${encodeURIComponent(fileName)}/name`,
        { fileName: nextFileName }
      ),
    listRevisions: (documentRef: string) =>
      get<import('./types').MemoryRevisionSummary[]>(`/api/memory-folders/documents/${encodeURIComponent(documentRef)}/revisions`),
    getRevision: (documentRef: string, revisionId: string) =>
      get<import('./types').MemoryRevisionSummary & { content: string; documentId: string }>(`/api/memory-folders/documents/${encodeURIComponent(documentRef)}/revisions/${encodeURIComponent(revisionId)}`),
    getRevisionDiff: (documentRef: string, from: string, to: string) =>
      get<{ format: 'unified'; diff: string; segments: import('./types').MemoryDiffSegment[] }>(`/api/memory-folders/documents/${encodeURIComponent(documentRef)}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    restoreRevision: (documentRef: string, revisionId: string, expectedRevision?: string) =>
      post<{ success: boolean; documentRef: string; revision: string; chunksStored: number }>(`/api/memory-folders/documents/${encodeURIComponent(documentRef)}/revisions/${encodeURIComponent(revisionId)}/restore`, { expectedRevision }),
    listDeleted: () =>
      get<Array<{ documentRef: string; folderId: string; fileName: string; revision: string; deletedAt: number }>>('/api/memory-folders/deleted'),
    listRecentChanges: (limit = 20) =>
      get<import('./types').RecentMemoryChange[]>(`/api/memory-folders/recent-changes?limit=${limit}`),
    ingestFile: (folderId: string, fileName: string, content: string) =>
      post<{ success: boolean; chunksStored: number; fileName: string; job?: MemoryIndexJob<{ success: boolean; chunksStored: number; fileName: string }> }>(
        `/api/memory-folders/${memoryFolderPathId(folderId)}/ingest-file`, { fileName, content }
      ),
    reingestFile: (folderId: string, fileName: string) =>
      post<{ success: boolean; chunksStored: number; fileName: string }>(
        `/api/memory-folders/${memoryFolderPathId(folderId)}/reingest-file`, { fileName }
      ),
    deleteDocuments: (folderId: string, sourceFiles: string[]) =>
      post<{ success: boolean }>(
        `/api/memory-folders/${memoryFolderPathId(folderId)}/delete-documents`, { sourceFiles }
      ),
    forgetMemories: (folderId: string, sourceFiles: string[]) =>
      post<{ success: boolean; filesReset: number; chunksDeleted: number; graphEdgesDeleted: number }>(
        `/api/memory-folders/${memoryFolderPathId(folderId)}/drop-indexes`, { sourceFiles }
      ),
    moveDocuments: (folderId: string, sourceFiles: string[], targetFolderId: string) =>
      post<{ success: boolean; moved: number }>(
        `/api/memory-folders/${memoryFolderPathId(folderId)}/move-documents`, { sourceFiles, targetFolderId }
      ),
  },

  mcp: {
    listServers: () =>
      get<McpServerInfo[]>('/api/mcp/servers'),
    addServer: (config: { name?: string; originalName?: string; customName?: string | null; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean; icon_url?: string; origin?: string; description?: string; env_hints?: { name: string; description?: string; required: boolean; sensitive?: boolean }[] }) =>
      post<{ id: string; connected: boolean; toolCount?: number; error?: string; pendingAuthUrl?: string }>('/api/mcp/servers', config),
    updateServer: (id: string, config: { name?: string; originalName?: string; customName?: string | null; command?: string; args?: string[]; env?: Record<string, string>; description?: string }) =>
      put<{ success: boolean; connected: boolean; toolCount?: number; error?: string }>(`/api/mcp/servers/${encodeURIComponent(id)}`, config),
    removeServer: (id: string) =>
      del<{ success: boolean }>(`/api/mcp/servers/${encodeURIComponent(id)}`),
    toggleServer: (id: string) =>
      post<{ enabled: boolean; connected: boolean; toolCount?: number; error?: string }>(`/api/mcp/servers/${encodeURIComponent(id)}/toggle`),
    reconnectServer: (id: string) =>
      post<{ connected: boolean; toolCount?: number; error?: string }>(`/api/mcp/servers/${encodeURIComponent(id)}/reconnect`),
    reauthServer: (id: string) =>
      post<{ connected: boolean; authRequired?: boolean; toolCount?: number; error?: string; clearedTokenFiles?: number }>(`/api/mcp/servers/${encodeURIComponent(id)}/reauth`),
    searchRegistry: (opts?: { search?: string; cursor?: string; limit?: number; registry?: string; signal?: AbortSignal }) => {
      const params = new URLSearchParams()
      if (opts?.search) params.set('search', opts.search)
      if (opts?.cursor) params.set('cursor', opts.cursor)
      if (opts?.limit) params.set('limit', String(opts.limit))
      if (opts?.registry) params.set('registry', opts.registry)
      const qs = params.toString()
      return get<McpRegistryResponse>(`/api/mcp/registry${qs ? `?${qs}` : ''}`, opts?.signal)
    },
    onAuthNeeded: (cb: (data: { serverId: string; serverName: string; authUrl: string }) => void) =>
      onWsEvent('mcp-auth-needed', cb as WsHandler),
    onAuthComplete: (cb: (data: { serverId: string; serverName: string; toolCount: number }) => void) =>
      onWsEvent('mcp-auth-complete', cb as WsHandler)
  },

  notifications: {
    list: (unreadOnly?: boolean) => {
      const params = unreadOnly ? '?unreadOnly=true' : ''
      return get<AppNotification[]>(`/api/notifications${params}`)
    },
    markRead: (id: string) =>
      patch<{ success: boolean }>(`/api/notifications/${encodeURIComponent(id)}/read`),
    markAllRead: () =>
      post<{ success: boolean }>('/api/notifications/read-all'),
    remove: (id: string) =>
      del<{ success: boolean }>(`/api/notifications/${encodeURIComponent(id)}`),
    removeAll: () =>
      del<{ success: boolean }>('/api/notifications'),
    unreadCount: () =>
      get<{ count: number }>('/api/notifications/unread-count').then((r) => r.count),
    onCreated: (cb: (data: AppNotification) => void) =>
      onWsEvent('notification:created', cb as WsHandler)
  },

  activity: {
    list: (opts?: { limit?: number; offset?: number; types?: ActivityKind[]; search?: string }) => {
      const params = new URLSearchParams()
      if (opts?.limit) params.set('limit', String(opts.limit))
      if (opts?.offset) params.set('offset', String(opts.offset))
      if (opts?.types?.length) params.set('types', opts.types.join(','))
      if (opts?.search?.trim()) params.set('search', opts.search.trim())
      const qs = params.toString()
      return get<{ items: ActivityItem[]; hasMore?: boolean; total?: number; totalsByKind?: ActivityTotalsByKind }>(`/api/activity${qs ? `?${qs}` : ''}`)
    },
    stopAll: () => post<StopAllActivityResult>('/api/activity/stop-all', {}),
  },

  instances: {
    list: () =>
      get<AgentInstance[]>('/api/instances'),
    stop: (id: string) =>
      post<{ success: boolean }>(`/api/instances/${encodeURIComponent(id)}/stop`),
  },

  cronJobs: {
    list: () =>
      get<CronJob[]>('/api/cron-jobs'),
    create: (input: { name?: string; agentId: string; schedule: string; prompt: string; enabled?: boolean; oneOff?: boolean; outputChannelId?: string; notificationMode?: 'always' | 'conditional'; notificationCondition?: string; executionConfig?: ConversationExecutionConfig }) =>
      post<CronJob>('/api/cron-jobs', input),
    update: (id: string, input: { name?: string; agentId?: string; schedule?: string; prompt?: string; enabled?: boolean; oneOff?: boolean; outputChannelId?: string; notificationMode?: 'always' | 'conditional'; notificationCondition?: string }) =>
      put<CronJob>(`/api/cron-jobs/${encodeURIComponent(id)}`, input),
    delete: (id: string) =>
      del<{ success: boolean }>(`/api/cron-jobs/${encodeURIComponent(id)}`),
    runNow: (id: string) =>
      post<{ queued: boolean }>(`/api/cron-jobs/${encodeURIComponent(id)}/run`),
  },

  system: {
    health: () => get<{ status: string; name: string; version: string; timestamp: string; uptimeSeconds: number }>('/api/health'),
  },

  backup: {
    getSummary: () =>
      get<{ modules: Record<string, { count: number; details?: Record<string, number> }> }>('/api/backup/summary'),
    exportBackup: async (modules: string[]): Promise<Blob> => {
      const params = new URLSearchParams({ modules: modules.join(',') })
      const res = await fetch(`${BASE_URL}/api/backup/export?${params}`)
      if (!res.ok) throw new Error(`Export failed: ${res.statusText}`)
      return res.blob()
    },
    importBackup: async (file: File, modules?: string[]): Promise<{ success: boolean; results: Record<string, { restored: number; errors: string[] }> }> => {
      const form = new FormData()
      form.append('file', file)
      if (modules) form.append('modules', modules.join(','))
      const res = await fetch(`${BASE_URL}/api/backup/import`, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`Import failed: ${res.statusText}`)
      return res.json()
    },
    previewBackup: async (file: File): Promise<{ version: number; createdAt: string; modules: Record<string, { count: number }> }> => {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`${BASE_URL}/api/backup/preview`, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`Preview failed: ${res.statusText}`)
      return res.json()
    },
    resetApp: (modules?: string[]) =>
      post<{ success: boolean; results?: Record<string, { reset: boolean; errors: string[] }> }>('/api/backup/reset', modules ? { modules } : undefined),
    onRestoreProgress: (cb: (data: { module: string; status: 'started' | 'completed' | 'failed'; current: number; total: number }) => void) =>
      onWsEvent('backup:restore-progress', cb as WsHandler)
  },

  channels: {
    list: () =>
      get<ChannelDefinition[]>('/api/channels'),
    get: (id: string) =>
      get<ChannelDefinition>(`/api/channels/${encodeURIComponent(id)}`),
    create: (data: { name: string; type: ChannelType; agentId: string; config: Record<string, unknown>; enabled?: boolean }) =>
      post<ChannelDefinition>('/api/channels', data),
    update: (id: string, data: { name?: string; agentId?: string; config?: Record<string, unknown>; enabled?: boolean }) =>
      put<ChannelDefinition>(`/api/channels/${encodeURIComponent(id)}`, data),
    remove: (id: string) =>
      del<{ success: boolean }>(`/api/channels/${encodeURIComponent(id)}`),
    toggle: (id: string) =>
      post<ChannelDefinition>(`/api/channels/${encodeURIComponent(id)}/toggle`),
    test: (id: string) =>
      post<{ success: boolean; username?: string; error?: string }>(`/api/channels/${encodeURIComponent(id)}/test`),
    testConfig: (data: { type: ChannelType; agentId: string; config: Record<string, unknown> }) =>
      post<{ success: boolean; username?: string; error?: string }>('/api/channels/test', data),
    targets: (id: string) =>
      get<{ target: string; label: string; channelKey: string }[]>(`/api/channels/${encodeURIComponent(id)}/targets`),
  },


  metrics: {
    get: (days = 30) =>
      get<MetricsSummary>(`/api/metrics?days=${days}`),
    reset: () =>
      del<{ success: boolean }>('/api/metrics'),
  },
}
