// ── Provider / Chat ─────────────────────────────────────────────────────────

export interface LLMProviderConfig {
    id: string
    name: string
    type: 'openai' | 'anthropic' | 'google' | 'lmstudio' | 'grok' | 'ollama' | 'openrouter' | 'groq' | 'mistral'
    baseUrl: string
    apiKey?: string
    defaultModel: string
    availableModels: string[]
    supportsStreaming: boolean
    supportsToolCalls: boolean
    supportsVision: boolean
}

export interface StoredMessage {
    id: string
    conversationId: string
    role: string
    content: string
    thinking?: string
    toolCalls?: unknown[]
    toolCallId?: string
    imageDataUrls?: string[]
    audioDataUrls?: string[]
    fileAttachments?: { name: string }[]
    agentId?: string
    agentName?: string
    agentIconUrl?: string | null
    provider?: string
    model?: string
    promptTokens?: number
    completionTokens?: number
    contextTokens?: number
    latencyMs?: number
    createdAt: number
}

// ── MCP ─────────────────────────────────────────────────────────────────────

export interface McpServerInfo {
    id: string
    name: string
    originalName: string
    customName?: string | null
    command: string
    args: string[]
    env: Record<string, string>
    description: string
    enabled: boolean
    connected: boolean
    toolCount: number
    icon_url?: string
    origin?: string
    pendingAuthUrl?: string
    envHints?: { name: string; description?: string; required: boolean; sensitive?: boolean }[]
    serverInfo?: { title?: string; description?: string; websiteUrl?: string } | null
}

export interface McpRegistryServer {
    server: {
        name: string
        description?: string
        title?: string
        version: string
        repository?: { url: string; source: string }
        websiteUrl?: string
        icons?: { src: string; mimeType: string }[]
        isRemote?: boolean
        isLocal?: boolean
        packages?: {
            registryType: string
            identifier: string
            version: string
            transport: { type: string }
            arguments?: {
                value?: string
                fromEnv?: string
            }[]
            environmentVariables?: {
                name: string
                description?: string
                isRequired: boolean
                format?: string
            }[]
        }[]
        remotes?: {
            type: string
            url: string
            headers?: { name: string; description?: string; isRequired: boolean; isSecret: boolean }[]
        }[]
    }
    _meta: {
        'io.modelcontextprotocol.registry/official'?: {
            status: string
            isLatest: boolean
        }
    }
}

export interface McpRegistryResponse {
    servers: McpRegistryServer[]
    metadata: {
        nextCursor?: string
        count: number
    }
}

// ── Agents ──────────────────────────────────────────────────────────────────

export interface AgentDefinition {
    id: string
    name: string
    internalName: string
    description: string
    category: string
    iconUrl: string | null
    providerId: string
    model: string
    systemPrompt: string
    cronPrompt: string
    tools: string[]
    skills: string[]
    subAgents?: SubAgentAssignment[]
    autoApproveTools: boolean
    autoToolRouting: boolean
    autoMemory: boolean
    autoSkillRouting: boolean
    skillRouterProviderId: string
    skillRouterModel: string
    generateTitle: boolean
    thinkingEnabled: boolean
    maxContextTokens: number | null
    sortOrder: number
    memorySpaces: string[]
    createdAt: number
    updatedAt: number
}

export interface SkillDefinition {
    id: string
    name: string
    description: string
    category: string
    content: string
    enabled: boolean
    createdAt: number
    updatedAt: number
}

export interface SubAgentAssignment {
    agentId: string
}

// ── Notifications ───────────────────────────────────────────────────────────

export interface AppNotification {
    id: string
    agentId: string
    conversationId: string | null
    title: string
    body: string
    severity: 'info' | 'warning' | 'critical'
    read: boolean
    createdAt: number
}

// ── Memory ──────────────────────────────────────────────────────────────────

export interface MemorySpace {
    id: string
    name: string
    description: string
    folderPath: string
    relativePath: string
    depth?: number
    parentRelativePath?: string | null
    sortOrder: number
    isDefault: boolean
    createdAt: number
    fileCount: number
}

export interface MemoryFileStatus {
    fileName: string
    extension: string
    size: number
    modifiedAt: number
    supported: boolean
    textDirect: boolean
    /** 'indexed' | 'needs_reindex' | 'not_indexed' | 'unsupported' */
    status: 'indexed' | 'needs_reindex' | 'not_indexed' | 'unsupported'
    chunkCount?: number
    lastIndexedAt?: number
    entityIndexed: boolean
    entityIndexedAt?: number
}

export interface MemoryIndexJob<T = unknown> {
    id: string
    kind: 'reindex' | 'entity-index'
    spaceId: string
    fileName: string
    status: 'running' | 'completed' | 'cancelled' | 'error'
    createdAt: number
    updatedAt: number
    result?: T
    error?: string
}

export interface EntityGraphNode {
    id: string
    name: string
    normalizedName: string
    type: 'person' | 'place' | 'organization' | 'project' | 'event' | 'date' | 'technology' | 'product' | 'artifact' | 'concept' | 'other'
    aliases: string[]
    importance: 0 | 1 | 2 | 3
    mentionCount: number
    sourceCount: number
    origins?: EntityGraphOrigin[]
    firstSeenAt: number
    lastSeenAt: number
}

export type EntityGraphNodeType = EntityGraphNode['type']

export interface EntityGraphOrigin {
    sourceKind: string
    sourceId: string
    label: string
    count: number
    lastSeenAt: number
}

export interface EntityGraphEdge {
    id: string
    fromNodeId: string
    toNodeId: string
    fromName: string
    toName: string
    relation: string
    importance: 0 | 1 | 2 | 3
    confidence: number
    evidence: string
    sourceKind: string
    sourceId: string
    mentionCount: number
    firstSeenAt: number
    lastSeenAt: number
}

export interface EntityGraphResponse {
    stats: {
        nodeCount: number
        edgeCount: number
        recentEdgeCount: number
    }
    seedNodes: EntityGraphNode[]
    nodes: EntityGraphNode[]
    edges: EntityGraphEdge[]
}

export interface EntityGraphSuggestionsResponse {
    suggestions: EntityGraphNode[]
}

// ── Instances / Cron / Channels ──────────────────────────────────────────────

export interface AgentInstance {
    id: string
    type: 'chat' | 'multi-agent' | 'cron' | 'channel'
    agentId: string
    agentName: string
    agentIconUrl: string | null
    model: string | null
    conversationId: string | null
    startedAt: number
    intervalMinutes: number
    status: 'running' | 'awaiting-approval'
}

export interface CronJob {
    id: string
    name: string
    agentId: string
    schedule: string
    prompt: string
    enabled: boolean
    oneOff: boolean
    outputChannelId: string
    notificationMode: 'always' | 'conditional'
    notificationCondition: string
    createdAt: number
    updatedAt: number
    agentName: string
    agentIconUrl: string | null
    isRunning: boolean
    nextRunAt: number | null
}

export interface ExecutionStepRecord {
    id: string
    conversationId: string
    taskId?: string
    iteration: number
    status: string
    message?: string
    plan?: string
    toolCalls?: unknown[]
    results?: { name: string; success: boolean; output: string; error?: string; images?: string[] }[]
    evaluation?: { taskComplete: boolean; success: boolean; reasoning: string }
    maCodename?: string
    maAgentName?: string
    maPhase?: string
    createdAt: number
}

export type OrchestrationTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled'
export type OrchestrationRunStatus = 'running' | 'completed' | 'cancelled' | 'error'

export interface OrchestrationTaskItem {
    id: string
    title: string
    status: OrchestrationTaskStatus
    note?: string
    updatedAt: number
}

export interface OrchestrationState {
    runId: string
    conversationId: string
    status: OrchestrationRunStatus
    objective: string
    items: OrchestrationTaskItem[]
    currentTaskId?: string
    result?: { summary?: string; error?: string }
    createdAt: number
    updatedAt: number
    completedAt?: number
}

export type ChannelType = 'telegram' | 'discord' | 'slack'


export interface ChannelDefinition {
    id: string
    name: string
    type: ChannelType
    agentId: string
    config: Record<string, unknown>
    enabled: boolean
    createdAt: number
    updatedAt: number
    status?: {
        connected: boolean
        error?: string
        username?: string
    }
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export interface MetricsSummary {
    totals: {
        conversations: number
        messages: number
        promptTokens: number
        completionTokens: number
        totalTokens: number
        avgLatencyMs: number
        estimatedCost: number | null
    }
    modelUsage: {
        provider: string
        model: string
        requestCount: number
        totalPromptTokens: number
        totalCompletionTokens: number
        estimatedCost: number | null
    }[]
    toolUsage: {
        toolName: string
        callCount: number
    }[]
    agentUsage: {
        agentId: string
        agentName: string | null
        conversationCount: number
        messageCount: number
    }[]
    dailyActivity: {
        date: string
        conversations: number
        messages: number
        tokens: number
        estimatedCost: number | null
        models: { model: string; messages: number; tokens: number }[]
    }[]
    originBreakdown: {
        origin: string
        count: number
    }[]
}
