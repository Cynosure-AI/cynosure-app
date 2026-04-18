import { BASE_URL, get, post, put, patch, del, onWsEvent, sendWsMessage } from './http'
import type {
  LLMProviderConfig, StoredMessage, McpServerInfo, McpRegistryResponse,
  AgentDefinition, SubAgentAssignment, AppNotification, MemorySpace,
  AgentInstance, CronJob, ExecutionStepRecord, ChannelDefinition, ChannelType,
  FileWatcher, MetricsSummary,
} from './types'
import type { WsHandler } from './http'

// Re-export everything so existing `import { … } from '../api/client'` keeps working
export { wsConnected } from './http'
export type {
  LLMProviderConfig, StoredMessage, McpServerInfo, McpRegistryServer, McpRegistryResponse,
  AgentDefinition, SubAgentAssignment, AppNotification, MemorySpace,
  AgentInstance, CronJob, ExecutionStepRecord, ChannelType, ChannelDefinition,
  FileWatcher, MetricsSummary,
} from './types'

// ---- API object (same shape as window.api from preload) ----

export const api = {
  provider: {
    list: () => get<LLMProviderConfig[]>('/api/providers'),
    add: (config: LLMProviderConfig) => post<{ id: string }>('/api/providers', config).then((r) => r.id),
    remove: (id: string) => del<void>(`/api/providers/${encodeURIComponent(id)}`),
    setLastUsed: (id: string) => put<void>('/api/providers/active', { id }),
    getLastUsed: () => get<{ id: string }>('/api/providers/active').then((r) => r.id),
    test: (id: string) => post<{ success: boolean }>(`/api/providers/${encodeURIComponent(id)}/test`).then((r) => r.success),
    listModels: (id: string, type?: 'llm' | 'embedding') => {
      const params = type ? `?type=${type}` : ''
      return get<string[]>(`/api/providers/${encodeURIComponent(id)}/models${params}`)
    },
    getModelInfo: (providerId: string, modelId: string) =>
      get<{ id: string; contextLength?: number }>(`/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/info`),
    loadSaved: () => Promise.resolve() // no-op in web — server loads on startup
  },

  chat: {
    createConversation: (title?: string, agentId?: string, maWorkspaceId?: string) =>
      post<{ id: string; title: string; agentId: string | null; maWorkspaceId: string | null; origin: string; createdAt: number; updatedAt: number }>(
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
      return get<{ id: string; title: string; agent_id: string | null; ma_workspace_id: string | null; origin: string; pinned: number; created_at: number; updated_at: number; last_user_message: string | null }[]>(
        `/api/chat/conversations${qs ? `?${qs}` : ''}`
      )
    },
    listConversationsPaginated: (limit: number, offset: number) => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
      return get<{ items: { id: string; title: string; agent_id: string | null; ma_workspace_id: string | null; origin: string; pinned: number; created_at: number; updated_at: number; last_user_message: string | null }[]; total: number }>(
        `/api/chat/conversations?${params}`
      )
    },
    getMessages: (conversationId: string) =>
      get<{
        messages: StoredMessage[]
        lastContextTokens: number | null
        chatConfig?: {
          allowedTools?: string[]
          subAgents?: { agentId: string; codename: string; role: string }[]
          memorySpaceIds?: string[]
          systemPrompt?: string
          model?: string
          providerId?: string
          overrideSubAgents?: boolean
          thinkingEnabled?: boolean
        }
      }>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`),
    getExecutionSteps: (conversationId: string) =>
      get<ExecutionStepRecord[]>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/steps`),
    getPendingHITL: (conversationId: string) =>
      get<{ taskId: string; toolCalls: { name: string; arguments: string }[] } | null>(
        `/api/chat/conversations/${encodeURIComponent(conversationId)}/hitl`
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
    send: (
      conversationId: string,
      content: string,
      model?: string,
      providerOverride?: string,
      imageDataUrls?: string[],
      allowedTools?: string[],
      files?: { name: string; content: string }[],
      systemPrompt?: string,
      generateTitle?: boolean,
      messageId?: string,
      audioDataUrls?: string[],
      subAgents?: SubAgentAssignment[],
      memorySpaceIds?: string[],
      overrideSubAgents?: boolean,
      thinkingEnabled?: boolean,
      contextStrategy?: string
    ) =>
      post<void>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/send`, {
        content,
        messageId,
        model,
        providerOverride,
        imageDataUrls,
        audioDataUrls,
        allowedTools,
        files,
        systemPrompt,
        generateTitle,
        subAgents,
        memorySpaceIds,
        overrideSubAgents,
        thinkingEnabled,
        contextStrategy
      }),
    truncateFrom: (conversationId: string, messageId: string) =>
      post<{ success: boolean; deleted: number }>(
        `/api/chat/conversations/${encodeURIComponent(conversationId)}/truncate`,
        { messageId }
      ),
    cancelStream: (streamId: string, conversationId?: string) => post<void>('/api/chat/cancel', { streamId: streamId || undefined, conversationId: conversationId || undefined }),

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
    onStreamEnd: (
      cb: (data: {
        streamId: string
        conversationId: string
        cancelled?: boolean
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
        model?: string
        contextWindow?: number
      }) => void
    ) => onWsEvent('chat:stream-end', cb as WsHandler),
    onStreamReset: (cb: (data: { streamId: string; conversationId: string }) => void) =>
      onWsEvent('chat:stream-reset', cb as WsHandler),
    onStreamUsage: (
      cb: (data: { conversationId: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number }; model?: string; contextWindow?: number }) => void
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
      get<Record<string, boolean>>('/api/agent/tool-approvals'),
    setToolApproval: (toolName: string, autoApprove: boolean) =>
      put<{ success: boolean }>(`/api/agent/tool-approvals/${encodeURIComponent(toolName)}`, { autoApprove }),
    setToolApprovalsBulk: (approvals: Record<string, boolean>) =>
      put<{ success: boolean }>('/api/agent/tool-approvals', approvals),
    listTools: () =>
      get<{ name: string; description: string; autoApprove: boolean; namespace: { id: string; label: string } }[]>('/api/agent/tools'),
    onExecutionUpdate: (cb: (data: unknown) => void) =>
      onWsEvent('agent:execution-update', cb)
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
    search: (query: string, topK?: number) =>
      post<unknown[]>('/api/memory/search', { query, topK }),
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
    }) => post<{ success: boolean; vectorsDropped: boolean; reembedded: boolean; reembeddedCount: number }>('/api/memory/embeddings/configure', opts),
    getEmbeddingConfig: () =>
      get<{ providerId?: string; model: string; dimensions: number }>('/api/memory/embeddings/config'),
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
    onReembedProgress: (cb: (data: { current: number; total: number; status: string }) => void) =>
      onWsEvent('memory:reembed-progress', cb as WsHandler)
  },

  memorySpaces: {
    list: () =>
      get<MemorySpace[]>('/api/memory-spaces'),
    create: (name: string, description?: string) =>
      post<MemorySpace>('/api/memory-spaces', { name, description }),
    update: (id: string, data: { name?: string; description?: string }) =>
      put<MemorySpace>(`/api/memory-spaces/${encodeURIComponent(id)}`, data),
    remove: (id: string) =>
      del<{ success: boolean }>(`/api/memory-spaces/${encodeURIComponent(id)}`),
    reorder: (ids: string[]) =>
      put<{ success: boolean }>('/api/memory-spaces/reorder', { ids }),
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
    reingestFile: (spaceId: string, sourceFile: string, content: string) =>
      post<{ success: boolean; chunksStored: number; fileName: string }>(
        `/api/memory-spaces/${encodeURIComponent(spaceId)}/reingest-file`, { sourceFile, content }
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
    addServer: (config: { name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean; icon_url?: string; origin?: string }) =>
      post<{ id: string; connected: boolean; toolCount?: number; error?: string; pendingAuthUrl?: string }>('/api/mcp/servers', config),
    updateServer: (id: string, config: { name?: string; command?: string; args?: string[]; env?: Record<string, string> }) =>
      put<{ success: boolean; connected: boolean; toolCount?: number; error?: string }>(`/api/mcp/servers/${encodeURIComponent(id)}`, config),
    removeServer: (id: string) =>
      del<{ success: boolean }>(`/api/mcp/servers/${encodeURIComponent(id)}`),
    toggleServer: (id: string) =>
      post<{ enabled: boolean; connected: boolean; toolCount?: number; error?: string }>(`/api/mcp/servers/${encodeURIComponent(id)}/toggle`),
    reconnectServer: (id: string) =>
      post<{ connected: boolean; toolCount?: number; error?: string }>(`/api/mcp/servers/${encodeURIComponent(id)}/reconnect`),
    reauthServer: (id: string) =>
      post<{ connected: boolean; authRequired?: boolean; toolCount?: number; error?: string; clearedTokenFiles?: number }>(`/api/mcp/servers/${encodeURIComponent(id)}/reauth`),
    searchRegistry: (opts?: { search?: string; cursor?: string; limit?: number; registry?: string }) => {
      const params = new URLSearchParams()
      if (opts?.search) params.set('search', opts.search)
      if (opts?.cursor) params.set('cursor', opts.cursor)
      if (opts?.limit) params.set('limit', String(opts.limit))
      if (opts?.registry) params.set('registry', opts.registry)
      const qs = params.toString()
      return get<McpRegistryResponse>(`/api/mcp/registry${qs ? `?${qs}` : ''}`)
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

  instances: {
    list: () =>
      get<AgentInstance[]>('/api/instances'),
    stop: (id: string) =>
      post<{ success: boolean }>(`/api/instances/${encodeURIComponent(id)}/stop`),
  },

  cronJobs: {
    list: () =>
      get<CronJob[]>('/api/cron-jobs'),
    create: (input: { name?: string; agentId: string; schedule: string; prompt: string; enabled?: boolean; oneOff?: boolean; modelOverride?: string; providerOverride?: string }) =>
      post<CronJob>('/api/cron-jobs', input),
    update: (id: string, input: { name?: string; schedule?: string; prompt?: string; enabled?: boolean; oneOff?: boolean; modelOverride?: string; providerOverride?: string }) =>
      put<CronJob>(`/api/cron-jobs/${encodeURIComponent(id)}`, input),
    delete: (id: string) =>
      del<{ success: boolean }>(`/api/cron-jobs/${encodeURIComponent(id)}`),
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
  },

  fileWatchers: {
    list: () =>
      get<FileWatcher[]>('/api/file-watchers'),
    create: (input: { name?: string; agentId: string; paths: string[]; ignorePatterns?: string[]; prompt?: string; debounceMs?: number; enabled?: boolean; modelOverride?: string; providerOverride?: string }) =>
      post<FileWatcher>('/api/file-watchers', input),
    update: (id: string, input: { name?: string; paths?: string[]; ignorePatterns?: string[]; prompt?: string; debounceMs?: number; enabled?: boolean; modelOverride?: string; providerOverride?: string }) =>
      put<FileWatcher>(`/api/file-watchers/${encodeURIComponent(id)}`, input),
    delete: (id: string) =>
      del<{ success: boolean }>(`/api/file-watchers/${encodeURIComponent(id)}`),
    start: (id: string) =>
      post<{ success: boolean }>(`/api/file-watchers/${encodeURIComponent(id)}/start`),
    stop: (id: string) =>
      post<{ success: boolean }>(`/api/file-watchers/${encodeURIComponent(id)}/stop`),
    cancel: (id: string) =>
      post<{ success: boolean }>(`/api/file-watchers/${encodeURIComponent(id)}/cancel`),
  },

  metrics: {
    get: (days = 30) =>
      get<MetricsSummary>(`/api/metrics?days=${days}`),
    reset: () =>
      del<{ success: boolean }>('/api/metrics'),
  },
}
