import { nanoid } from 'nanoid'
import { getEventBus } from '../../telemetry/event-bus.js'
import { getMemoryAggregator, type AggregatedMemory } from '../../memory/memory-aggregator.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage, ToolDefinition } from '../../gateway/providers/base.provider.js'
import type { MemoryRetrievalStatusDetails, RetrievedChunk } from '../../memory/parser.js'
import { getMemoryReranker, type MemoryRerankerConfig } from '../../memory/reranker.js'
import { OpenRouterProvider } from '../../gateway/providers/openrouter.provider.js'
import { recordAuxiliaryModelUsage } from '../../usage-metering.js'
import { getMemoryRetrievalOptions, type MemoryRetrievalOptions } from '../../memory/retrieval-options.js'
import type { ContextEvidence } from '@shared/types'
import { emitRoutingDecision, parseCandidateIds, recentConversationBlock, ROUTER_TURN_CHAR_LIMIT, routerQuery, runRoutingPhase, selectRoutingCandidates, type RoutingDecision } from './routing-kernel.js'

const MAX_SELECTED_MEMORIES = 5
const AUTO_MEMORY_RETRIEVAL_RESULT_COUNT = 10
const RETRIEVAL_TURN_CHAR_LIMIT = 200 // Per-turn history folded into the embedding retrieval query
const CANDIDATE_CHAR_LIMIT = 1_200
/** Reranker scores are comparable across chunks, so a relative cut removes their weak tail. */
const MIN_RELATIVE_RERANKER_SCORE = 0.65
const RANK_FUSION_CONSTANT = 60
const MEMORY_CONTEXT_SELECTION_TOOL_NAME = 'select_memory_context'
/** A decision model's probability of "directly supports" needed to inject a candidate. */
const MIN_DECISION_PROBABILITY = 0.5

export interface ApplyAutoMemoryRoutingInput {
    enabled: boolean
    conversationId: string
    userQuery?: string
    /** Original request first, followed by complementary retrieval expansions. */
    retrievalQueries?: string[]
    recentMessages?: ChatMessage[]
    gateway: LLMGateway
    providerId?: string
    model?: string
    agentId?: string
    memoryFolderIds?: string[]
    /** Extra metadata to merge into emitted EventBus events (e.g. maCodename for sub-agents). */
    eventMeta?: Record<string, unknown>
    signal?: AbortSignal
}

interface MemoryContextSelection {
    memoryIds: string[]
    answerable: boolean
    correctiveQuery?: string
}

interface MemoryPipelineStats {
    queryCount: number
    searchCandidateCount: number
    rerankerInputCount: number
    rerankerOutputCount: number
    returnedCount: number
    uniqueCount: number
    filteredCount: number
    duplicateCount: number
    weakCount: number
    relativeScoreThreshold: number
    searchMatches: Array<{
        name: string
        content: string
        matchScore?: number
        scoreType?: string
    }>
}

export interface RoutedMemoryContext {
    content: string
    evidence: ContextEvidence[]
}

export async function applyAutoMemoryRouting(input: ApplyAutoMemoryRoutingInput): Promise<string | null> {
    return (await applyAutoMemoryRoutingWithEvidence(input))?.content ?? null
}

export async function applyAutoMemoryRoutingWithEvidence(input: ApplyAutoMemoryRoutingInput): Promise<RoutedMemoryContext | null> {
    const {
        enabled,
        conversationId,
        userQuery,
        retrievalQueries: plannedQueries,
        recentMessages = [],
        gateway,
        providerId,
        model,
        agentId,
        memoryFolderIds,
        eventMeta,
        signal,
    } = input

    if (!shouldRouteMemory(userQuery, { enabled })) return null

    const taskId = `memory_router_${nanoid()}`
    const aggregator = getMemoryAggregator()

    return runRoutingPhase({
        signal,
        label: 'memory-router',
        run: async () => {
            emitMemoryRoutingStatus(conversationId, taskId, eventMeta)
            const primaryQuery = userQuery?.trim() || ''
            const contextualQuery = routerQuery({ query: primaryQuery, recentMessages }, RETRIEVAL_TURN_CHAR_LIMIT)
            const retrievalQueries = Array.from(new Set([
                primaryQuery,
                ...(plannedQueries || []),
                contextualQuery,
            ].map((query) => query?.trim() || '').filter(Boolean)))
            const options = getMemoryRetrievalOptions()
            // A larger curation pool needs every query to contribute enough candidates.
            const retrievalCount = Math.max(AUTO_MEMORY_RETRIEVAL_RESULT_COUNT, options.curationPool - 2)
            const rerankerConfig = getMemoryReranker().getConfig()
            const rerankerEnabled = rerankerConfig.enabled
            const curator = rerankerEnabled ? null : await resolveMemoryCurator(gateway, rerankerConfig, { providerId, model })
            let pipelineStage = 0
            const retrievalStats: MemoryRetrievalStatusDetails[] = retrievalQueries.map(() => ({}))
            const reportRetrievalStage = (stage: 'rag' | 'reranking') => {
                const nextStage = stage === 'rag' ? 1 : 2
                if (nextStage <= pipelineStage) return
                pipelineStage = nextStage
                emitMemoryPipelineStatus(conversationId, taskId, stage === 'rag' ? 'searching-memory' : 'reranking-memory', eventMeta)
            }
            let retrievalResults = await Promise.all(
                retrievalQueries.map((query, queryIndex) => aggregator.aggregate(query, {
                    agentId,
                    folderIds: memoryFolderIds,
                    permanentTopK: retrievalCount,
                    onStatus: (stage, details) => {
                        reportRetrievalStage(stage)
                        if (details?.candidateCount !== undefined) retrievalStats[queryIndex].candidateCount = details.candidateCount
                        if (details?.resultCount !== undefined) retrievalStats[queryIndex].resultCount = details.resultCount
                        if (details?.candidates) retrievalStats[queryIndex].candidates = details.candidates
                    },
                })),
            )
            emitMemoryPipelineStatus(conversationId, taskId, 'filtering-memory', eventMeta)
            let fusedCandidates = fuseAutoMemoryResults(retrievalResults)
            let candidates = filterAutoMemoryCandidates(fusedCandidates, options)
            let pipelineStats = buildMemoryPipelineStats(retrievalResults, retrievalStats, fusedCandidates, candidates, rerankerEnabled)
            signal?.throwIfAborted()

            if (!candidates.permanent.length) {
                emitMemoryRoutingSelection(conversationId, taskId, [], 'gathered-context', eventMeta, 'none-found', 'retrieval', pipelineStats)
                return null
            }

            emitMemoryRoutingSelection(
                conversationId,
                taskId,
                candidates.permanent,
                'gathered-results',
                eventMeta,
                undefined,
                'retrieval',
                pipelineStats,
            )
            if (rerankerEnabled) emitMemoryPipelineStatus(conversationId, taskId, 'selecting-memory', eventMeta)
            else emitMemoryCurationStatus(conversationId, taskId, eventMeta)
            let selection = !curator ? null : await selectMemoryContext({
                conversationId,
                gateway,
                curator,
                query: primaryQuery,
                recentMessages,
                candidates,
                documentContext: options.curatorDocumentContext,
                signal,
            })

            // One bounded corrective pass: do not inject merely related evidence
            // when the verifier says the current pool cannot answer the request.
            const correctiveQuery = selection?.answerable === false ? selection.correctiveQuery?.trim() : ''
            if (correctiveQuery && !retrievalQueries.includes(correctiveQuery)) {
                const correctedStats: MemoryRetrievalStatusDetails = {}
                const corrected = await aggregator.aggregate(correctiveQuery, {
                    agentId,
                    folderIds: memoryFolderIds,
                    permanentTopK: retrievalCount,
                    onStatus: (stage, details) => {
                        reportRetrievalStage(stage)
                        if (details?.candidateCount !== undefined) correctedStats.candidateCount = details.candidateCount
                        if (details?.resultCount !== undefined) correctedStats.resultCount = details.resultCount
                        if (details?.candidates) correctedStats.candidates = details.candidates
                    },
                })
                retrievalResults = [...retrievalResults, corrected]
                retrievalStats.push(correctedStats)
                fusedCandidates = fuseAutoMemoryResults(retrievalResults)
                candidates = filterAutoMemoryCandidates(fusedCandidates, options)
                pipelineStats = buildMemoryPipelineStats(retrievalResults, retrievalStats, fusedCandidates, candidates, rerankerEnabled)
                emitMemoryRoutingSelection(
                    conversationId,
                    taskId,
                    candidates.permanent,
                    'gathered-results',
                    eventMeta,
                    undefined,
                    'retrieval',
                    pipelineStats,
                )
                selection = !curator ? null : await selectMemoryContext({
                    conversationId,
                    gateway,
                    curator,
                    query: primaryQuery,
                    recentMessages,
                    candidates,
                    documentContext: options.curatorDocumentContext,
                    signal,
                })
            }

            const selectedPermanent = selection
                ? resolveSelectedMemories(candidates.permanent, selection.memoryIds)
                : candidates.permanent.slice(0, MAX_SELECTED_MEMORIES)
            const selectedMemory: AggregatedMemory = {
                permanent: selection?.answerable === false ? [] : selectedPermanent,
            }

            const selectionMethod = rerankerEnabled ? 'reranker' : selection ? 'llm' : 'ranked-fallback'
            emitMemoryRoutingSelection(
                conversationId,
                taskId,
                selectedMemory.permanent,
                'gathered-context',
                eventMeta,
                selectedMemory.permanent.length ? undefined : 'none-relevant',
                selectionMethod,
                pipelineStats,
            )
            const formatted = aggregator.format(selectedMemory)
            if (!formatted) return null

            const verificationStatus: ContextEvidence['verificationStatus'] = selection ? 'verified' : 'ranked-fallback'
            const evidence: ContextEvidence[] = [
                ...selectedMemory.permanent.map((chunk) => ({
                    kind: 'memory-chunk' as const,
                    sourceId: chunk.id,
                    documentId: chunk.documentId || chunk.documentRef || chunk.sourceFile,
                    revision: chunk.revision || chunk.contentHash,
                    chunkIndex: chunk.chunkIndex,
                    retrievalMethod: chunk.scoreType || 'memory-retrieval',
                    selectionMethod,
                    relevance: memoryMatch(chunk).score,
                    verificationStatus,
                })),
            ]
            return { content: formatted, evidence }
        },
        fallback: () => {
            emitMemoryRoutingSelection(conversationId, taskId, [], 'gathered-context', eventMeta, 'routing-failed', 'routing-failed')
            return null
        },
    })
}

function buildMemoryPipelineStats(
    results: AggregatedMemory[],
    retrievalStats: MemoryRetrievalStatusDetails[],
    fused: AggregatedMemory,
    filtered: AggregatedMemory,
    rerankerEnabled: boolean,
): MemoryPipelineStats {
    const returnedCount = results.reduce((count, result) => count + result.permanent.length, 0)
    const searchCandidateCount = retrievalStats.reduce((count, stats, index) => (
        count + (stats.candidateCount ?? results[index]?.permanent.length ?? 0)
    ), 0)
    const rerankerOutputCount = retrievalStats.reduce((count, stats, index) => (
        count + (stats.resultCount ?? results[index]?.permanent.length ?? 0)
    ), 0)
    const uniqueCount = fused.permanent.length
    const filteredCount = filtered.permanent.length
    const preRerankerMatches = fuseAutoMemoryResults(retrievalStats.map((stats) => ({
        permanent: stats.candidates || [],
    }))).permanent.slice(0, AUTO_MEMORY_RETRIEVAL_RESULT_COUNT)

    return {
        queryCount: results.length,
        searchCandidateCount,
        rerankerInputCount: rerankerEnabled ? searchCandidateCount : 0,
        rerankerOutputCount: rerankerEnabled ? rerankerOutputCount : 0,
        returnedCount,
        uniqueCount,
        filteredCount,
        duplicateCount: Math.max(0, returnedCount - uniqueCount),
        weakCount: Math.max(0, uniqueCount - filteredCount),
        // Zero means the tail was cut by rank, not by a relative score.
        relativeScoreThreshold: rerankerEnabled ? MIN_RELATIVE_RERANKER_SCORE : 0,
        searchMatches: preRerankerMatches.map((memory) => {
            const visibleMatch = memoryMatch(memory)
            return {
                name: memoryLabel(memory),
                content: memory.text,
                matchScore: visibleMatch.score,
                scoreType: visibleMatch.scoreType,
            }
        }),
    }
}

function shouldRouteMemory(userQuery?: string, opts: { enabled?: boolean } = {}): boolean {
    return opts.enabled === true && Boolean(userQuery?.trim())
}

interface MemoryCurator {
    providerId?: string
    model?: string
    /** Set when the curation model is an OpenRouter decision model. */
    decisionProvider?: OpenRouterProvider
}

/** The configured curation model, or the conversation model when none is set or its provider is gone. */
async function resolveMemoryCurator(
    gateway: LLMGateway,
    config: Pick<MemoryRerankerConfig, 'curationProviderId' | 'curationModel'>,
    conversation: { providerId?: string; model?: string },
): Promise<MemoryCurator> {
    if (!config.curationModel) return conversation
    const provider = config.curationProviderId ? gateway.getProvider(config.curationProviderId) : undefined
    if (config.curationProviderId && !provider) return conversation
    const curator = { providerId: config.curationProviderId, model: config.curationModel }
    try {
        if (provider instanceof OpenRouterProvider && await provider.isDecisionModel(config.curationModel)) {
            return { ...curator, decisionProvider: provider }
        }
    } catch (err) {
        console.warn('[memory-router] Could not check whether the curation model is a decision model:', err)
    }
    return curator
}

async function selectMemoryContext(input: {
    conversationId: string
    gateway: LLMGateway
    curator: MemoryCurator
    query: string
    recentMessages: ChatMessage[]
    candidates: AggregatedMemory
    documentContext?: boolean
    signal?: AbortSignal
}): Promise<MemoryContextSelection | null> {
    if (!input.candidates.permanent.length) return null
    const { providerId, model, decisionProvider } = input.curator

    try {
        if (decisionProvider && model) return await decideMemoryContext({ ...input, provider: decisionProvider, model })

        const candidateIds = input.candidates.permanent.map((_, index) => memoryCandidateId(index))
        const request: Parameters<LLMGateway['complete']>[0] = {
            messages: [
                {
                    role: 'system',
                    content: [
                        'You curate retrieved memory candidates before the main assistant run.',
                        'Given the current request, recent conversation, and retrieved memory candidates, call select_memory_context.',
                        `Select at most ${MAX_SELECTED_MEMORIES} memory IDs.`,
                        'Evidence must directly support the requested fact or operation; topical similarity is insufficient.',
                        'Memory candidates are listed in retrieval rank order. Prefer earlier candidates when several support the same fact.',
                        ...(input.documentContext ? [
                            'Each candidate names its document. A chunk is about its document\'s subject even when the chunk text does not repeat that name.',
                            'When candidates state conflicting facts, include the most recently updated one.',
                        ] : []),
                        'A close friend does not entail best friend. A related project does not entail the requested project.',
                        'Set answerable=false and select nothing when the pool lacks direct evidence.',
                        'When answerable=false, provide one precise corrective query in the user request language that preserves names, relationship terms, identifiers, and constraints.',
                        'Do not answer the user. Do not include rationale. /no_think',
                    ].join('\n'),
                },
                {
                    role: 'user',
                    content: [
                        recentConversationBlock(input.recentMessages, ROUTER_TURN_CHAR_LIMIT),
                        `Current request: ${input.query}`,
                        '',
                        'Memory candidates:',
                        ...input.candidates.permanent.map((candidate, index) => formatMemoryCandidate(candidate, candidateIds[index], input.documentContext)),
                    ].filter(Boolean).join('\n'),
                },
            ],
            model,
            maxTokens: 1_500,
            tools: [buildMemoryContextSelectionTool(candidateIds)],
            toolChoice: { type: 'function', name: MEMORY_CONTEXT_SELECTION_TOOL_NAME },
            thinkingEnabled: false,
            signal: input.signal,
        }
        return await selectRoutingCandidates({
            conversationId: input.conversationId,
            gateway: input.gateway,
            providerId,
            model,
            signal: input.signal,
            usageKind: 'memory-router',
            toolName: MEMORY_CONTEXT_SELECTION_TOOL_NAME,
            request,
            parse: (raw) => parseMemoryContextSelection(raw, candidateIds),
        })
    } catch (err) {
        if ((err as Error).name === 'AbortError' || input.signal?.aborted) throw err
        console.warn('[memory-router] Memory context curation failed, using top ranked memories:', err)
        return null
    }
}

/**
 * Decision models cannot call the selection tool, so each candidate becomes one
 * yes/no question answered in a single request. They cannot write a corrective
 * query either, so an unanswerable pool simply selects nothing.
 */
async function decideMemoryContext(input: {
    provider: OpenRouterProvider
    model: string
    query: string
    recentMessages: ChatMessage[]
    candidates: AggregatedMemory
    documentContext?: boolean
    signal?: AbortSignal
}): Promise<MemoryContextSelection | null> {
    const candidateIds = input.candidates.permanent.map((_, index) => memoryCandidateId(index))
    const response = await input.provider.decide({
        model: input.model,
        state: {
            recent_conversation: recentConversationBlock(input.recentMessages, ROUTER_TURN_CHAR_LIMIT) || undefined,
            current_request: input.query,
            memory_candidates: Object.fromEntries(input.candidates.permanent.map((candidate, index) => [
                candidateIds[index],
                formatMemoryCandidate(candidate, candidateIds[index], input.documentContext),
            ])),
        },
        questions: Object.fromEntries(candidateIds.map((id) => [id, {
            type: 'noul' as const,
            instructions: `Does memory candidate ${id} directly support the fact or operation in current_request?`,
            criteria: {
                true: `${id} contains evidence that directly answers or enables the current request.`,
                false: `${id} is only topically similar, about a related but different subject, or irrelevant. A close friend does not entail best friend; a related project does not entail the requested project.`,
            },
        }])),
    }, input.signal)
    input.signal?.throwIfAborted()
    recordAuxiliaryModelUsage({
        kind: 'memory-router',
        provider: input.provider.config.type,
        model: response.model || input.model,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
    })

    const answers = response.answers || {}
    if (!candidateIds.some((id) => typeof answers[id]?.noul === 'number')) return null
    const memoryIds = candidateIds
        .map((id, rank) => ({ id, rank, yes: answers[id]?.noul ?? 0 }))
        .filter(({ yes }) => yes >= MIN_DECISION_PROBABILITY)
        .sort((a, b) => b.yes - a.yes || a.rank - b.rank)
        .slice(0, MAX_SELECTED_MEMORIES)
        .map(({ id }) => id)
    return { memoryIds, answerable: memoryIds.length > 0 }
}

function buildMemoryContextSelectionTool(candidateIds: string[]): ToolDefinition {
    const properties: Record<string, unknown> = {
        memoryIds: {
            type: 'array',
            description: 'Candidate IDs to include in context, ordered by usefulness.',
            items: { type: 'string', enum: candidateIds },
            maxItems: MAX_SELECTED_MEMORIES,
        },
        answerable: {
            type: 'boolean',
            description: 'True only when selected evidence directly supports the requested answer or action.',
        },
        correctiveQuery: {
            type: 'string',
            description: 'One precise retry query when answerable is false; otherwise omit or return an empty string.',
        },
    }
    return {
        name: MEMORY_CONTEXT_SELECTION_TOOL_NAME,
        description: 'Select the retrieved memory candidates that should be injected into the main assistant context.',
        timeout: 10_000,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties,
            required: ['memoryIds', 'answerable'],
        },
        execute: async () => ({ success: true, output: 'ok' }),
    }
}

function parseMemoryContextSelection(raw: string, candidateIds: string[]): MemoryContextSelection | null {
    try {
        const parsed = JSON.parse(raw) as { memoryIds?: unknown; answerable?: unknown; correctiveQuery?: unknown }
        const memoryIds = parseCandidateIds(parsed.memoryIds, candidateIds, MAX_SELECTED_MEMORIES)
        if (!memoryIds) return null

        const answerable = typeof parsed.answerable === 'boolean'
            ? parsed.answerable
            : memoryIds.length > 0
        const correctiveQuery = typeof parsed.correctiveQuery === 'string'
            ? parsed.correctiveQuery.trim().slice(0, 500)
            : ''

        return { memoryIds, answerable, correctiveQuery: correctiveQuery || undefined }
    } catch {
        return null
    }
}

function resolveSelectedMemories(candidates: RetrievedChunk[], memoryIds: string[]): RetrievedChunk[] {
    const byId = new Map(candidates.map((candidate, index) => [memoryCandidateId(index), candidate]))
    return memoryIds
        .map((id) => byId.get(id))
        .filter((candidate): candidate is RetrievedChunk => Boolean(candidate))
        .sort((a, b) => candidates.indexOf(a) - candidates.indexOf(b))
}

function memoryCandidateId(index: number): string {
    return `m${index + 1}`
}

function formatMemoryCandidate(candidate: RetrievedChunk, id: string, documentContext = false): string {
    const metadata = [
        candidate.folderName ? `space=${candidate.folderName}` : '',
        candidate.sourceFile ? `source=${candidate.sourceFile}` : '',
        candidate.chunkIndex != null ? `part=${candidate.chunkIndex + 1}${candidate.totalChunks ? `/${candidate.totalChunks}` : ''}` : '',
        // A chunk from the middle of a note often never names its subject.
        documentContext && candidate.documentTitle ? `document="${candidate.documentTitle}"` : '',
        documentContext && candidate.sectionPath && candidate.sectionPath !== candidate.documentTitle ? `section="${candidate.sectionPath}"` : '',
        documentContext && candidate.documentUpdatedAt ? `updated=${new Date(candidate.documentUpdatedAt).toISOString().slice(0, 10)}` : '',
    ].filter(Boolean).join(', ')
    const text = candidate.text.trim().slice(0, CANDIDATE_CHAR_LIMIT)

    return [
        `- ${id}${metadata ? ` (${metadata})` : ''}:`,
        text,
    ].join('\n')
}

/** Fused rank order is the only signal shared by dense and lexical hits; keep the top of it for curation. */
function filterAutoMemoryCandidates(memory: AggregatedMemory, options: Pick<MemoryRetrievalOptions, 'curationPool'>): AggregatedMemory {
    const permanent = hasRerankerScores(memory.permanent)
        ? filterWeakRerankerMatches(memory.permanent)
        : memory.permanent.slice(0, options.curationPool)
    return { permanent }
}

function hasRerankerScores(candidates: RetrievedChunk[]): boolean {
    return candidates.length > 0 && candidates.every((candidate) => Number.isFinite(candidate.rerankerScore))
}

/** Merge the original and expanded queries into one ranked list. Reranker
 * scores are comparable across queries; otherwise only each query's rank order
 * is, because a lexical-only hit has no similarity score to compare. */
function fuseAutoMemoryResults(results: AggregatedMemory[]): AggregatedMemory {
    const ranked = new Map<string, { chunk: RetrievedChunk; rankScore: number }>()
    for (const result of results) {
        result.permanent.forEach((chunk, index) => {
            const key = chunk.id || [chunk.folderId, chunk.sourceFile, chunk.chunkIndex].join('\u0000')
            const contribution = 1 / (RANK_FUSION_CONSTANT + index + 1)
            const existing = ranked.get(key)
            if (!existing) {
                ranked.set(key, { chunk, rankScore: contribution })
                return
            }
            if ((chunk.rerankerScore ?? -Infinity) > (existing.chunk.rerankerScore ?? -Infinity)) existing.chunk = chunk
            existing.rankScore += contribution
        })
    }
    const entries = [...ranked.values()]
    const byReranker = hasRerankerScores(entries.map(({ chunk }) => chunk))
    const permanent = entries
        .sort((a, b) => byReranker
            ? b.chunk.rerankerScore! - a.chunk.rerankerScore!
            : b.rankScore - a.rankScore)
        .map(({ chunk }) => chunk)

    return { permanent }
}

/** Remove the weak tail relative to the best reranker score. Candidates arrive sorted. */
function filterWeakRerankerMatches(candidates: RetrievedChunk[]): RetrievedChunk[] {
    if (candidates.length <= 1) return candidates
    const best = candidates[0].rerankerScore!
    if (!(best > 0)) return candidates
    return candidates.filter((candidate) => candidate.rerankerScore! >= best * MIN_RELATIVE_RERANKER_SCORE)
}

function memoryLabel(chunk: RetrievedChunk): string {
    const label = [
        chunk.folderName,
        chunk.sourceFile,
        chunk.chunkIndex != null ? `part ${chunk.chunkIndex + 1}${chunk.totalChunks ? `/${chunk.totalChunks}` : ''}` : '',
    ].filter(Boolean).join(' - ')

    return label || 'Memory snippet'
}

function emitMemoryRoutingStatus(conversationId: string, taskId: string, eventMeta?: Record<string, unknown>): void {
    getEventBus().emit('step:status', {
        conversationId,
        taskId,
        iteration: 0,
        status: 'routing-memory',
        message: 'Preparing memory search...',
        ...eventMeta,
    })
}

function emitMemoryCurationStatus(conversationId: string, taskId: string, eventMeta?: Record<string, unknown>): void {
    getEventBus().emit('step:status', {
        conversationId,
        taskId,
        iteration: 0,
        status: 'curating-memory',
        message: 'Curating memory context...',
        ...eventMeta,
    })
}

function emitMemoryPipelineStatus(
    conversationId: string,
    taskId: string,
    status: 'searching-memory' | 'reranking-memory' | 'filtering-memory' | 'selecting-memory',
    eventMeta?: Record<string, unknown>,
): void {
    const messages = {
        'searching-memory': 'Searching memory with hybrid RAG...',
        'reranking-memory': 'Reranking memory matches...',
        'filtering-memory': 'Filtering weak and duplicate memory matches...',
        'selecting-memory': 'Selecting the highest-ranked memories...',
    }
    getEventBus().emit('step:status', {
        conversationId,
        taskId,
        iteration: 0,
        status,
        message: messages[status],
        ...eventMeta,
    })
}

function emitMemoryRoutingSelection(
    conversationId: string,
    taskId: string,
    memories: RetrievedChunk[],
    contextPhase: 'gathered-results' | 'gathered-context' = 'gathered-context',
    eventMeta?: Record<string, unknown>,
    emptyReason?: 'none-found' | 'none-relevant' | 'routing-failed' | 'disabled' | 'empty-scope' | 'no-query',
    selectionMethod: 'retrieval' | 'reranker' | 'llm' | 'ranked-fallback' | 'routing-failed' = contextPhase === 'gathered-results' ? 'retrieval' : 'llm',
    pipelineStats?: MemoryPipelineStats,
): void {
    const visiblePipelineStats = contextPhase === 'gathered-results' || !memories.length
        ? pipelineStats
        : undefined
    const toolCalls: RoutingDecision['entries'] = memories.map((memory) => {
        const visibleMatch = memoryMatch(memory)
        return {
            name: memoryLabel(memory),
            details: {
                type: 'memory',
                selectionMethod,
                contextPhase,
                sourceFile: memory.sourceFile,
                directoryPath: memory.folderName,
                chunkIndex: memory.chunkIndex,
                content: memory.text,
                matchScore: visibleMatch.score,
                scoreType: visibleMatch.scoreType,
                sourceChunkId: memory.sourceChunkId || memory.id,
                pipelineStats: visiblePipelineStats,
            },
        }
    })

    emitRoutingDecision({
        conversationId,
        taskId,
        phase: contextPhase === 'gathered-results' ? 'memory-candidates' : 'memory-context',
        eventMeta,
        entries: toolCalls,
        empty: {
            name: memoryEmptyLabel(emptyReason),
            details: {
                type: 'memory',
                contextPhase,
                selectionMethod,
                emptyReason: emptyReason || 'none-selected',
                content: memoryEmptyContent(emptyReason),
                pipelineStats: visiblePipelineStats,
            },
        },
    })
}

/** The score users can compare across candidates. Chunks found only by
 * keyword search have no such score (a BM25 or fusion value is not a
 * similarity), so they report how they were found instead. */
function memoryMatch(memory: RetrievedChunk): {
    score: number | undefined
    scoreType: 'dense' | 'reranker' | 'keyword'
} {
    if (typeof memory.rerankerScore === 'number' && Number.isFinite(memory.rerankerScore)) {
        return { score: normalizeMatchScore(memory.rerankerScore), scoreType: 'reranker' }
    }
    if (typeof memory.denseScore === 'number' && Number.isFinite(memory.denseScore)) {
        return { score: normalizeMatchScore(memory.denseScore), scoreType: 'dense' }
    }
    return { score: undefined, scoreType: 'keyword' }
}

function normalizeMatchScore(value: number): number {
    const normalized = value > 1 ? value / 100 : value
    return Math.max(0, Math.min(1, normalized))
}

function memoryEmptyLabel(reason?: string): string {
    switch (reason) {
        case 'none-found': return 'No memories found'
        case 'none-relevant': return 'No relevant memories'
        case 'routing-failed': return 'Memory routing skipped'
        case 'disabled': return 'Auto memory disabled'
        case 'empty-scope': return 'No memory folders selected'
        case 'no-query': return 'No memory query'
        default: return 'No memories selected'
    }
}

function memoryEmptyContent(reason?: string): string {
    switch (reason) {
        case 'none-found':
            return 'Automatic memory retrieval ran, but no document snippets matched this turn.'
        case 'none-relevant':
            return 'Auto memory found candidates, but the curation step selected none as useful for this turn.'
        case 'routing-failed':
            return 'Auto memory routing failed; the turn continued without injected memory.'
        case 'disabled':
            return 'Auto memory is disabled for this turn.'
        case 'empty-scope':
            return 'Auto memory did not run because no memory folders are selected for this turn.'
        case 'no-query':
            return 'Auto memory did not run because there was no text query to search with.'
        default:
            return 'Auto memory did not select any snippets for this turn.'
    }
}
