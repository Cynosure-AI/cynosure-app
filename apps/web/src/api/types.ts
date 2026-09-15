import type { ConversationExecutionConfig } from '@shared/types'

// ── Provider / Chat ─────────────────────────────────────────────────────────

export interface LLMProviderConfig {
    id: string
    name: string
    type: 'openai' | 'anthropic' | 'google' | 'lmstudio' | 'grok' | 'ollama' | 'openrouter' | 'requesty' | 'groq' | 'mistral'
    baseUrl: string
    apiKey?: string
    defaultModel: string
    availableModels: string[]
    supportsStreaming: boolean
    supportsToolCalls: boolean
    supportsVision: boolean
}

export type ModelListType = 'llm' | 'embedding' | 'image' | 'video' | 'reranker' | 'transcription'

export interface ModelPricing {
    prompt?: number
    completion?: number
    request?: number
    image?: number
    audio?: number
    webSearch?: number
    internalReasoning?: number
    inputCacheRead?: number
    inputCacheWrite?: number
    skus?: Record<string, number>
    tiers?: ModelPricingTier[]
}

export interface ModelPricingTier {
    prompt?: number
    completion?: number
    inputCacheRead?: number
    inputCacheWrite?: number
    minPromptTokens?: number
    utcStart?: number
    utcEnd?: number
}

export interface ModelListItem {
    id: string
    name?: string
    contextLength?: number
    inputModalities?: string[]
    outputModalities?: string[]
    supportsToolCalls?: boolean
    pricing?: ModelPricing
}

export interface ModelInfo {
    id: string
    contextLength?: number
    inputModalities?: string[]
    outputModalities?: string[]
    supportsToolCalls?: boolean
    cost?: { input: number; output: number }
    pricing?: ModelPricing
}

export interface VideoGenerationFrameImage {
    type: 'image_url'
    image_url: { url: string }
    frame_type: 'first_frame' | 'last_frame'
}

export interface VideoGenerationReferenceImage {
    type: 'image_url'
    image_url: { url: string }
}

export interface VideoGenerationRequest {
    model: string
    prompt: string
    duration?: number
    resolution?: string
    aspect_ratio?: string
    size?: string
    frame_images?: VideoGenerationFrameImage[]
    input_references?: VideoGenerationReferenceImage[]
    generate_audio?: boolean
    seed?: number
    callback_url?: string
    provider?: Record<string, unknown>
}

export type VideoGenerationStatus =
    | 'pending'
    | 'in_progress'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'expired'

export interface VideoGenerationJob {
    id: string
    generation_id?: string | null
    polling_url?: string
    status: VideoGenerationStatus | string
    model?: string | null
    unsigned_urls?: string[]
    usage?: {
        cost?: number
        is_byok?: boolean
    }
    error?: string
}

export interface VideoGenerationModelInfo {
    id: string
    canonical_slug?: string
    name?: string
    description?: string
    created?: number
    supported_resolutions?: string[] | null
    supported_aspect_ratios?: string[] | null
    supported_sizes?: string[] | null
    supported_frame_images?: string[] | null
    pricing_skus?: Record<string, string> | null
    allowed_passthrough_parameters?: string[] | null
}

export interface TranscriptionRequest {
    model: string
    inputAudio: {
        data: string
        format?: string
    }
    language?: string
    temperature?: number
    provider?: Record<string, unknown>
}

export interface TranscriptionResponse {
    text: string
    usage?: {
        cost?: number
        input_tokens?: number
        output_tokens?: number
        seconds?: number
        total_tokens?: number
    }
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
    videoDataUrls?: string[]
    audioDataUrls?: string[]
    structuredContent?: unknown
    fileAttachments?: { name: string; href?: string }[]
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
    subAgents?: SubAgentAssignment[]
    autoApproveTools: boolean
    autoToolRouting: boolean
    autoMemory: boolean
    dreamingEnabled: boolean
    autoRouterProviderId: string
    autoRouterModel: string
    generateTitle: boolean
    thinkingEnabled: boolean
    reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    maxContextTokens: number | null
    sortOrder: number
    tags: string[]
    favorite: boolean
    memoryFolders: string[]
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
    priority: 'notice' | 'action' | 'alert'
    read: boolean
    createdAt: number
}

// ── Activity ────────────────────────────────────────────────────────────────

export type ActivityKind = 'instance' | 'artifact' | 'cron' | 'memory' | 'chat' | 'channels' | 'dream'

export interface ActivityArtifact {
    href: string
    label: string
    kind: 'file' | 'image' | 'video' | 'audio'
    ext: string
}

export interface ConversationUpload {
    id: string
    name: string
    href: string
    ext: string
    sizeBytes: number
    chunkCount: number
    createdAt: number
    conversationId: string
    conversationTitle: string
    agentId: string | null
    agentName: string | null
}

export interface ActivityItem {
    id: string
    kind: ActivityKind
    title: string
    description: string
    createdAt: number
    agentId: string | null
    agentName: string | null
    agentIconUrl: string | null
    conversationId: string | null
    conversationTitle?: string | null
    status?: string
    severity?: string
    sourceId?: string
    sourceLabel?: string
    instanceType?: AgentInstance['type']
    model?: string | null
    artifacts?: ActivityArtifact[]
    memoryFolderId?: string
    memoryFileName?: string
    dreamChanges?: Array<{ tool: string; output: string; memoryFolderId?: string; memoryFileName?: string }>
}

export type ActivityTotalsByKind = Record<ActivityKind, number>

// ── Memory ──────────────────────────────────────────────────────────────────

export interface MemoryFolder {
    id: string
    name: string
    description: string
    directoryPath: string
    categoryPath: string
    depth?: number
    parentCategoryPath?: string | null
    sortOrder: number
    isUncategorized: boolean
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
    /** Approximate count based on file size and the active chunking settings. */
    estimatedChunkCount?: number
    lastIndexedAt?: number
    deepResearched: boolean
    analysisStatus: 'not_analyzed' | 'current' | 'needs_refresh'
    /** Server-enforced maximum chunk count for Deep Research eligibility. */
    analysisChunkLimit: number
    deepResearchedAt?: number
    dreamedAt?: number
    tags: string[]
}

export type { RuntimeLimits } from '@shared/runtime-limits'

export interface MemoryFileSearchResult extends MemoryFileStatus {
    categoryId: string
    categoryName: string
    categoryPath: string
    matchedFields: Array<'fileName' | 'folder' | 'tags' | 'summary' | 'content'>
}

export interface MemoryRevisionSummary {
    id: string
    revisionNumber: number
    contentHash: string
    source: 'ai' | 'dream' | 'user' | 'filesystem' | 'import' | 'restore'
    conversationId?: string
    agentId?: string
    messageIds: string[]
    createdAt: number
}

export interface MemoryDiffSegment {
    type: 'unchanged' | 'added' | 'removed'
    text: string
}

export interface MemoryDocumentKnowledgePreview {
    items: Array<{
        kind: 'relationship' | 'entity'
        label: string
    }>
    total: number
}

export interface MemoryDocumentAnalysis {
    status: 'not_analyzed' | 'current' | 'needs_refresh' | 'too_large'
    chunkCount?: number
    maxChunks?: number
    pipelineVersion?: string
    promptVersion?: string
    chunks: Array<{
        chunkIndex: number
        text: string
        sectionPath: string
        summary: string
        tags: string[]
    }>
    items: Array<{
        kind: 'relationship' | 'entity'
        label: string
        chunkIndex: number
        importance?: number
    }>
    itemTotal: number
}

export interface MemoryIndexJob<T = unknown> {
    id: string
    kind: 'reindex' | 'deep-research' | 'tool-embeddings'
    categoryId: string
    fileName: string
    status: 'queued' | 'running' | 'retrying' | 'completed' | 'cancelled' | 'error' | 'dead_letter'
    createdAt: number
    updatedAt: number
    attempt: number
    maxAttempts: number
    nextAttemptAt?: number
    progressCurrent?: number
    progressTotal?: number
    result?: T
    error?: string
}

export interface MemoryKnowledgeStats {
    pipelineVersion: string
    active_runs: number
    active_text_units: number
    entities: number
    active_mentions: number
    active_assertions: number
    disputed_assertions: number
    verified_evidence: number
    unmanaged_predicates: number
    indexed_documents: number
    covered_documents: number
    projection_ready_runs: number
    projection_error_runs: number
    ambiguous_mentions: number
}

export interface KnowledgeGraphNode {
    id: string
    name: string
    normalizedName: string
    type: 'person' | 'place' | 'organization' | 'project' | 'event' | 'date' | 'technology' | 'product' | 'artifact' | 'concept' | 'other'
    aliases: string[]
    importance: 0 | 1 | 2 | 3
    mentionCount: number
    sourceCount: number
    origins?: KnowledgeGraphEvidence[]
    firstSeenAt: number
    lastSeenAt: number
}

export type KnowledgeGraphNodeType = KnowledgeGraphNode['type']

export interface KnowledgeSourceChunk {
    textUnitId: string
    href: string
    documentId: string
    fileName: string
    chunkIndex: number
    documentTitle: string
    sectionPath: string
    text: string
    notes: string[]
}

export interface KnowledgeGraphEvidence {
    sourceKind: string
    sourceId: string
    label: string
    count: number
    lastSeenAt: number
    chunks: KnowledgeSourceChunk[]
}

export interface KnowledgeGraphEdge {
    id: string
    fromNodeId: string
    toNodeId: string
    fromName: string
    toName: string
    relation: string
    importance: 0 | 1 | 2 | 3
    assertionStatus?: 'active' | 'superseded' | 'disputed' | 'retracted' | 'retired' | 'staging'
    note?: string
    sourceKind: string
    sourceId: string
    sourceDocumentId?: string
    sourceContentHash?: string
    sourceChunkIndex?: number
    sourceChunk?: KnowledgeSourceChunk
    sourceIds?: string[]
    mentionCount: number
    firstSeenAt: number
    lastSeenAt: number
}

export interface KnowledgeGraph {
    stats: {
        nodeCount: number
        edgeCount: number
        recentEdgeCount: number
    }
    seedNodes: KnowledgeGraphNode[]
    nodes: KnowledgeGraphNode[]
    edges: KnowledgeGraphEdge[]
}

export interface KnowledgeGraphSuggestionsResponse {
    suggestions: KnowledgeGraphNode[]
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

export interface ChatExecutionState {
    executionId: string
    conversationId: string
    agentId: string | null
    state: 'running' | 'stopped' | 'finished'
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
    executionConfig: ConversationExecutionConfig | null
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
    maInvocationId?: string
    maPhase?: string
    createdAt: number
}

export type PlanningTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled'
export type PlanningRunStatus = 'running' | 'completed' | 'cancelled' | 'error'

export interface StopAllActivityResult {
    success: boolean
    total: number
    counts: {
        chats: number
        cronRuns: number
        channelRuns: number
        memoryJobs: number
        dreamRuns: number
        memoryReembedding: number
        postActions: number
    }
}

export interface PlanningTaskItem {
    id: string
    title: string
    status: PlanningTaskStatus
    note?: string
    updatedAt: number
}

export interface PlanningState {
    runId: string
    conversationId: string
    status: PlanningRunStatus
    objective: string
    items: PlanningTaskItem[]
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
        chatEstimatedCost: number | null
        auxiliaryEstimatedCost: number | null
        dreamingEstimatedCost: number | null
    }
    modelUsage: {
        provider: string
        model: string
        requestCount: number
        totalPromptTokens: number
        totalCompletionTokens: number
        estimatedCost: number | null
    }[]
    auxiliaryModelUsage: {
        kind: 'embedding' | 'reranker' | 'deep-research' | 'memory-router' | 'tool-router' | 'dreaming'
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

export interface DreamConfig {
    enabled: boolean
    providerId: string
    model: string
    windowId: string
    enabledAt: number
    startSequence: number
}
