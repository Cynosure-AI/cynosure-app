import { BASE_URL, get, post, put, patch, del, onWsEvent, sendWsMessage, subscribeWsConversations } from './http'
import type {
  LLMProviderConfig, McpServerInfo, McpRegistryResponse,
  AgentDefinition, AppNotification, MemorySpace, MemoryFileStatus, MemoryIndexJob,
  AgentInstance, ActivityItem, ActivityKind, CronJob, ExecutionStepRecord, ChannelDefinition, ChannelType, EntityGraphResponse, EntityGraphSuggestionsResponse,
  MetricsSummary, PlanningState,
  ModelListType,
  ModelInfo,
  ModelListItem,
  VideoGenerationJob,
  VideoGenerationModelInfo,
  VideoGenerationRequest,
} from './types'
import type { WsHandler } from './http'
import type { ChatSendRequest, ConversationDto, ConversationMessagesResponse } from '@shared/types'

// ---- API object (same shape as window.api from preload) ----

export const api = {
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
    listConversationsPaginated: (limit: number, offset: number, sort?: 'updated', search?: string) => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
      if (sort) params.set('sort', sort)
      if (search) params.set('search', search)
      return get<{ items: { id: string; title: string; agent_id: string | null; ma_workspace_id: string | null; origin: string; pinned: number; last_read_at: number | null; created_at: number; updated_at: number; last_user_message: string | null }[]; total: number }>(
        `/api/chat/conversations?${params}`
      )
    },
    getMessages: (conversationId: string) =>
      get<ConversationMessagesResponse>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`),
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
    getAttachmentConfig: () =>
      get<{ inlineAttachmentTextLimit: number }>('/api/chat/attachment-config'),
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
    cancelStream: (streamId: string, conversationId?: string) => post<void>('/api/chat/cancel', { streamId: streamId || undefined, conversationId: conversationId || undefined }),
    subscribeLiveConversations: (conversationIds: string[]) => subscribeWsConversations(conversationIds),

    // Stream event listeners — via WebSocket
    onStreamStart: (cb: (data: { streamId: string; conversationId: string; agentId?: string; agentName?: string; agentIconUrl?: string | null }) => void) =>
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
    onStreamUsage: (
      cb: (data: { conversationId: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number }; model?: string; contextWindow?: number; contextTokens?: number }) => void
    ) => onWsEvent('chat:stream-usage', cb as WsHandler),
    onStreamError: (
      cb: (data: { streamId: string; conversationId: string; error: string }) => void
    ) => onWsEvent('chat:stream-error', cb as WsHandler),

    // Sub-agent stream events — dedicated handlers so the UI can manage
    // sub-agent streaming separately from the primary orchestrator stream.
    onSubAgentStreamStart: (cb: (data: { streamId: string; conversationId: string; agentId?: string; agentName?: string; agentIconUrl?: string | null }) => void) =>
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
      cb: (data: { streamId: string; conversationId: string; model?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }) => void
    ) => onWsEvent('chat:subagent-stream-end', cb as WsHandler),

    onTitleUpdated: (
      cb: (data: { conversationId: string; title: string }) => void
    ) => onWsEvent('chat:title-updated', cb as WsHandler),
    onNewMessage: (
      cb: (data: { conversationId: string; message: { id: string; conversationId: string; role: string; content: string; createdAt: number } }) => void
    ) => onWsEvent('chat:new-message', cb as WsHandler),
    onPostAction: (
      cb: (data: { conversationId: string; action: string; status: 'started' | 'completed' }) => void
    ) => onWsEvent('chat:post-action', cb as WsHandler),
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
      get<{ actions: string[] }>(`/api/chat/post-actions?conversationId=${encodeURIComponent(conversationId)}`),
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
    listTools: () =>
      get<{ key: string; name: string; executionName: string; description: string; parameters: Record<string, unknown>; autoApprove: boolean; namespace: { id: string; label: string }; ambiguous: boolean }[]>('/api/agents/tools'),
    listPolicyTools: () =>
      get<{ key: string; name: string; executionName: string; description: string; parameters: Record<string, unknown>; autoApprove: boolean; namespace: { id: string; label: string }; ambiguous: boolean }[]>('/api/agents/tools?includePolicyBuiltIns=true'),
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
    search: (query: string, topK?: number, spaceId?: string) =>
      post<unknown[]>('/api/memory/search', { query, topK, spaceId }),
    deleteEntries: (ids: string[]) =>
      post<{ success: boolean; deleted: number }>('/api/memory/entries/delete', { ids }),
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
    getEntityExtractionConfig: () =>
      get<{ providerId?: string; model?: string }>('/api/memory/entity-extraction/config'),
    configureEntityExtraction: (opts: { providerId?: string; model?: string }) =>
      post<{ success: boolean; providerId?: string; model?: string }>('/api/memory/entity-extraction/configure', opts),
    dropVectors: () =>
      post<{ success: boolean }>('/api/memory/embeddings/drop', {}),
    probeEmbedding: (opts: { providerId?: string; model: string }) =>
      post<{ dimensions: number }>('/api/memory/embeddings/probe', opts),
    getChunkingConfig: () =>
      get<{ chunkSize: number; chunkOverlap: number }>('/api/memory/chunking/config'),
    configureChunking: (opts: { chunkSize: number; chunkOverlap: number }) =>
      post<{ success: boolean; chunkSize: number; chunkOverlap: number }>('/api/memory/chunking/configure', opts),
    getParserConfig: () =>
      get<{ ocrEnabled: boolean; ocrLanguage: string }>('/api/memory/parser/config'),
    configureParser: (opts: { ocrEnabled: boolean; ocrLanguage?: string }) =>
      post<{ success: boolean; ocrEnabled: boolean; ocrLanguage: string }>('/api/memory/parser/configure', opts),
    getRerankerConfig: () =>
      get<{ enabled: boolean; providerId?: string; model: string; candidateCount: number; minMatchThreshold: number }>('/api/memory/reranker/config'),
    configureReranker: (opts: { enabled: boolean; providerId?: string; model: string; candidateCount: number; minMatchThreshold: number }) =>
      post<{ success: boolean; enabled: boolean; providerId?: string; model: string; candidateCount: number; minMatchThreshold: number }>('/api/memory/reranker/configure', opts),
    getGraph: (query?: string, limit?: number, view?: 'relationships' | 'visual', nodeId?: string) => {
      const params = new URLSearchParams()
      if (query) params.set('query', query)
      if (nodeId) params.set('nodeId', nodeId)
      if (limit) params.set('limit', String(limit))
      if (view) params.set('view', view)
      const qs = params.toString()
      return get<EntityGraphResponse>(`/api/memory/graph${qs ? `?${qs}` : ''}`)
    },
    getGraphSuggestions: (query: string, limit?: number) => {
      const params = new URLSearchParams()
      params.set('query', query)
      if (limit) params.set('limit', String(limit))
      return get<EntityGraphSuggestionsResponse>(`/api/memory/graph/suggestions?${params.toString()}`)
    },
    updateGraphNode: (id: string, data: { name?: string; type?: EntityGraphResponse['nodes'][number]['type']; aliases?: string[]; importance?: number }) =>
      patch<EntityGraphResponse['nodes'][number]>(`/api/memory/graph/nodes/${encodeURIComponent(id)}`, data),
    deleteGraphNode: (id: string) =>
      del<{ success: boolean }>(`/api/memory/graph/nodes/${encodeURIComponent(id)}`),
    updateGraphEdge: (id: string, data: { relation?: string; evidence?: string; confidence?: number; importance?: number }) =>
      patch<EntityGraphResponse['edges'][number]>(`/api/memory/graph/edges/${encodeURIComponent(id)}`, data),
    deleteGraphEdge: (id: string) =>
      del<{ success: boolean; orphanedNodeIds: string[] }>(`/api/memory/graph/edges/${encodeURIComponent(id)}`),
    clearGraph: () =>
      del<{ success: boolean; nodesDeleted: number; edgesDeleted: number }>('/api/memory/graph'),
    onReembedProgress: (cb: (data: { current: number; total: number; status: string }) => void) =>
      onWsEvent('memory:reembed-progress', cb as WsHandler)
  },

  memorySpaces: {
    list: () =>
      get<MemorySpace[]>('/api/memory-spaces'),
    create: (name: string, description?: string, parentRelativePath?: string) =>
      post<MemorySpace>('/api/memory-spaces', { name, description, parentRelativePath }),
    update: (id: string, data: { name?: string; description?: string; relativePath?: string }) =>
      put<MemorySpace>(`/api/memory-spaces/${encodeURIComponent(id)}`, data),
    remove: (id: string) =>
      del<{ success: boolean }>(`/api/memory-spaces/${encodeURIComponent(id)}`),
    reorder: (ids: string[]) =>
      put<{ success: boolean }>('/api/memory-spaces/reorder', { ids }),
    listAllJobs: () =>
      get<MemoryIndexJob[]>('/api/memory-spaces/jobs'),
    /** List files in the space folder with their index status. Hash computation is async server-side. */
    listFiles: (spaceId: string) =>
      get<MemoryFileStatus[]>(`/api/memory-spaces/${encodeURIComponent(spaceId)}/files`),
    listJobs: (spaceId: string) =>
      get<MemoryIndexJob[]>(`/api/memory-spaces/${encodeURIComponent(spaceId)}/jobs`),
    getJob: (jobId: string) =>
      get<MemoryIndexJob>(`/api/memory-spaces/jobs/${encodeURIComponent(jobId)}`),
    cancelJob: (jobId: string) =>
      post<MemoryIndexJob>(`/api/memory-spaces/jobs/${encodeURIComponent(jobId)}/cancel`, {}),
    onJobUpdated: (cb: (data: MemoryIndexJob) => void) =>
      onWsEvent('memory:job-updated', cb as WsHandler),
    reindexFile: (spaceId: string, fileName: string) =>
      post<{ success: boolean; chunksStored: number; fileName: string }>(
        `/api/memory-spaces/${encodeURIComponent(spaceId)}/reingest-file`,
        { fileName }
      ),
    startReindexFile: (spaceId: string, fileName: string) =>
      post<MemoryIndexJob<{ success: boolean; chunksStored: number; fileName: string }>>(
        `/api/memory-spaces/${encodeURIComponent(spaceId)}/files/${encodeURIComponent(fileName)}/reindex-job`,
        {}
      ),
    entityIndexFile: (spaceId: string, fileName: string) =>
      post<{ success: boolean; fileName: string; insertedOrUpdated: number; deleted: number; entityIndexedAt: number }>(
        `/api/memory-spaces/${encodeURIComponent(spaceId)}/files/${encodeURIComponent(fileName)}/entity-index`,
        {}
      ),
    startEntityIndexFile: (spaceId: string, fileName: string) =>
      post<MemoryIndexJob<{ success: boolean; fileName: string; insertedOrUpdated: number; deleted: number; entityIndexedAt: number }>>(
        `/api/memory-spaces/${encodeURIComponent(spaceId)}/files/${encodeURIComponent(fileName)}/entity-index-job`,
        {}
      ),
    deleteFile: (spaceId: string, fileName: string) =>
      del<{ success: boolean }>(
        `/api/memory-spaces/${encodeURIComponent(spaceId)}/files/${encodeURIComponent(fileName)}`
      ),
    getFileContent: (spaceId: string, fileName: string) =>
      get<{ fileName: string; content: string }>(
        `/api/memory-spaces/${encodeURIComponent(spaceId)}/files/${encodeURIComponent(fileName)}/content`
      ),
    updateFileContent: (spaceId: string, fileName: string, content: string) =>
      put<{ success: boolean; chunksStored: number; fileName: string }>(
        `/api/memory-spaces/${encodeURIComponent(spaceId)}/files/${encodeURIComponent(fileName)}/content`,
        { content }
      ),
    /** Legacy: list indexed source files from LanceDB (no disk status). */
    listGroups: (spaceId: string) =>
      get<{ sourceFile: string; chunkCount: number; createdAt: number }[]>(
        `/api/memory-spaces/${encodeURIComponent(spaceId)}/groups`
      ),
    listEntries: (spaceId: string, sourceFile?: string) => {
      const params = new URLSearchParams()
      if (sourceFile) params.set('sourceFile', sourceFile)
      const qs = params.toString()
      return get<{ id: string; text: string; source: string; sourceFile?: string; chunkIndex?: number; createdAt: number }[]>(
        `/api/memory-spaces/${encodeURIComponent(spaceId)}/entries${qs ? `?${qs}` : ''}`
      )
    },
    ingestFile: (spaceId: string, fileName: string, content: string) =>
      post<{ success: boolean; chunksStored: number; fileName: string }>(
        `/api/memory-spaces/${encodeURIComponent(spaceId)}/ingest-file`, { fileName, content }
      ),
    reingestFile: (spaceId: string, fileName: string) =>
      post<{ success: boolean; chunksStored: number; fileName: string }>(
        `/api/memory-spaces/${encodeURIComponent(spaceId)}/reingest-file`, { fileName }
      ),
    deleteGroups: (spaceId: string, sourceFiles: string[]) =>
      post<{ success: boolean }>(
        `/api/memory-spaces/${encodeURIComponent(spaceId)}/delete-groups`, { sourceFiles }
      ),
    moveGroups: (spaceId: string, sourceFiles: string[], targetSpaceId: string) =>
      post<{ success: boolean; moved: number }>(
        `/api/memory-spaces/${encodeURIComponent(spaceId)}/move-groups`, { sourceFiles, targetSpaceId }
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
      return get<{ items: ActivityItem[]; hasMore?: boolean; total?: number }>(`/api/activity${qs ? `?${qs}` : ''}`)
    },
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
    create: (input: { name?: string; agentId: string; schedule: string; prompt: string; enabled?: boolean; oneOff?: boolean; outputChannelId?: string; notificationMode?: 'always' | 'conditional'; notificationCondition?: string }) =>
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
    resetApp: () =>
      post<{ success: boolean }>('/api/backup/reset')
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
