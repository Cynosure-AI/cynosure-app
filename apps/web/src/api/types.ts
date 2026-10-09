import type { ChatEvent, ConversationExecutionConfig } from '@shared/types'

// ── Provider / Chat ─────────────────────────────────────────────────────────

export interface LLMProviderConfig {
    id: string
    name: string
    type: 'openai' | 'anthropic' | 'google' | 'lmstudio' | 'grok' | 'ollama' | 'openrouter' | 'requesty' | 'groq' | 'mistral' | 'unsloth'
    baseUrl: string
    apiKey?: string
    defaultModel: string
    availableModels: string[]
    supportsStreaming: boolean
    supportsToolCalls: boolean
    supportsVision: boolean
}

export type ModelListType = 'llm' | 'embedding' | 'image' | 'video' | 'reranker' | 'transcription' | 'decision'

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
    supported_durations?: number[] | null
    supported_resolutions?: string[] | null
    supported_aspect_ratios?: string[] | null
    supported_sizes?: string[] | null
    supported_frame_images?: string[] | null
    pricing_skus?: Record<string, string> | null
    allowed_passthrough_parameters?: string[] | null
}

export interface ImageGenerationModelInfo {
    id: string
    supported_parameters?: Record<string, { type: string; values?: string[]; min?: number; max?: number }>
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
            headers?: {
                name: string
                description?: string
                isRequired: boolean
                isSecret: boolean
                /** Value template such as `Bearer {TOKEN}`; `{TOKEN}` is filled from `variables`. */
                value?: string
                variables?: Record<string, { description?: string; isRequired?: boolean; isSecret?: boolean }>
            }[]
        }[]
    }
    _meta: {
        /** Present on entries from the curated "recommended" list. */
        'ai.cynosure/recommended'?: {
            category?: string
            publisher?: string
        }
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
    status: 'processing' | 'ready' | 'failed'
    progressCurrent: number
    progressTotal: number
    error?: string
    staged: boolean
}

export interface StagedChatAttachment {
    id: string
    conversationId: string
    clientId?: string
    name: string
    status: 'processing' | 'ready' | 'failed'
    progressCurrent: number
    progressTotal: number
    chunkCount: number
    error?: string
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
    dreamChanges?: Array<{
        tool: string
        output: string
        summary: string
        status: 'success'
        memoryFolderId?: string
        memoryFileName?: string
        diffSegments?: MemoryDiffSegment[]
    }>
}

export type ActivityTotalsByKind = Record<ActivityKind, number>

// ── Memory ──────────────────────────────────────────────────────────────────

export interface MemoryFolder {
    id: string
    name: string
    description: string
    directoryPath: string
    folderPath: string
    depth?: number
    parentFolderPath?: string | null
    sortOrder: number
    isUncategorized: boolean
    /** Excluded from automatic root-scope memory routing; manual selection still works. */
    autoMemoryExcluded?: boolean
    createdAt: number
    fileCount: number
    /** Direct files contained by descendant folders (excluding this folder). */
    descendantFileCount?: number
    /** Direct files whose current contents are present in the search index. */
    indexedFileCount?: number
    /** Indexed files contained by descendant folders (excluding this folder). */
    descendantIndexedFileCount?: number
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
    dreamedAt?: number
}

export type { RuntimeLimits } from '@shared/runtime-limits'

export interface MemoryFileSearchResult extends MemoryFileStatus {
    folderId: string
    folderName: string
    folderPath: string
    matchedFields: Array<'fileName' | 'folder' | 'content'>
    /** Best cosine similarity among the document's matching chunks (0–1). */
    similarity?: number
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

export interface RecentMemoryChange extends MemoryRevisionSummary {
    documentRef: string
    folderId: string
    fileName: string
    status: 'active' | 'deleted'
    segments: MemoryDiffSegment[]
}

/** The indexed chunks of one document, for the editor's chunk-boundary view. */
export interface MemoryDocumentChunks {
    chunks: Array<{
        chunkIndex: number
        text: string
    }>
}

export interface MemoryIndexJob<T = unknown> {
    id: string
    kind: 'reindex' | 'tool-embeddings'
    folderId: string
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

export type ChatExecutionState = Pick<Extract<ChatEvent, { type: 'execution-state' }>,
    'executionId' | 'conversationId' | 'agentId' | 'state'>

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
    projectId?: string | null
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
        /** Input tokens served from provider prompt caches (subset of promptTokens). */
        cacheReadTokens: number
        /** Input tokens written to provider prompt caches (subset of promptTokens). */
        cacheWriteTokens: number
        totalTokens: number
        avgLatencyMs: number
        estimatedCost: number | null
        chatEstimatedCost: number | null
        memoryEstimatedCost: number | null
        autoRoutingEstimatedCost: number | null
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
        kind: 'embedding' | 'reranker' | 'deep-research' | 'task-context' | 'memory-router' | 'tool-router' | 'dreaming'
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

export interface MemoryRerankerConfig {
    enabled: boolean
    providerId?: string
    model: string
    /** Curates memory when reranking is off; empty uses the conversation model. */
    curationProviderId?: string
    curationModel: string
}

export interface DreamConfig {
    enabled: boolean
    providerId: string
    model: string
    windowId: string
    enabledAt: number
    startSequence: number
}

/** Reported by /api/health when the server is up but could not start normally. */
export interface ServerStartupError {
    code: 'database_version_mismatch' | 'database_open_failed'
    message: string
    databasePath?: string
    databaseVersion?: number
    supportedVersion?: number
}
