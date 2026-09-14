import { nanoid } from 'nanoid'
import { getEventBus } from '../../telemetry/event-bus.js'
import { getMemoryAggregator, type AggregatedMemory } from '../../memory/memory-aggregator.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage, ContentPart, ToolDefinition } from '../../gateway/providers/base.provider.js'
import type { MemoryRetrievalStatusDetails, RetrievedChunk } from '../../memory/parser.js'
import { getMemoryReranker } from '../../memory/reranker.js'
import { getUserSettings } from '../../user-settings.js'
import { completeWithDebugCapture } from '../../chat/debug-context.js'
import type { KnowledgeAssertion, KnowledgeGraphProjection } from '../../memory/knowledge-types.js'
import type { ContextEvidence } from '@shared/types'
import { recordAuxiliaryModelUsage } from '../../usage-metering.js'

const MAX_SELECTED_MEMORIES = 5
const AUTO_MEMORY_RETRIEVAL_RESULT_COUNT = 10
const MAX_SELECTED_GRAPH_EDGES = 3
const TURN_CHAR_LIMIT = 200
const CANDIDATE_CHAR_LIMIT = 1_200
const MIN_RELATIVE_MEMORY_SCORE = 0.65
const MEMORY_CONTEXT_SELECTION_TOOL_NAME = 'select_memory_context'

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
    debugContextEnabled?: boolean
}

interface MemoryContextSelection {
    memoryIds: string[]
    graphEdgeIds: string[]
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
        matchScore: number
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
        debugContextEnabled,
    } = input

    if (!shouldRouteMemory(userQuery, { enabled })) {
        emitAutoMemoryRoutingSkipped(
            conversationId,
            !userQuery?.trim() ? 'no-query' : 'disabled',
            eventMeta,
        )
        return null
    }

    const taskId = `memory_router_${nanoid()}`
    const aggregator = getMemoryAggregator()

    try {
        signal?.throwIfAborted()
        emitMemoryRoutingStatus(conversationId, taskId, eventMeta)
        const primaryQuery = userQuery?.trim() || ''
        const contextualQuery = buildRouterQuery(primaryQuery, recentMessages)
        const retrievalQueries = Array.from(new Set([
            primaryQuery,
            ...(plannedQueries || []),
            contextualQuery,
        ].map((query) => query?.trim() || '').filter(Boolean)))
        const retrievalCount = AUTO_MEMORY_RETRIEVAL_RESULT_COUNT
        const rerankerEnabled = getMemoryReranker().getConfig().enabled
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
                categoryIds: memoryFolderIds,
                permanentTopK: retrievalCount,
                includeGraph: true,
                graphQuery: qualifyFirstPersonGraphQuery(primaryQuery),
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
        let candidates = filterAutoMemoryCandidates(fusedCandidates)
        let pipelineStats = buildMemoryPipelineStats(retrievalResults, retrievalStats, fusedCandidates, candidates, rerankerEnabled)
        signal?.throwIfAborted()

        if (!candidates.permanent.length && !candidates.graph?.edges.length) {
            emitMemoryRoutingSelection(conversationId, taskId, [], 'gathered-context', eventMeta, 'none-found', undefined, 'retrieval', pipelineStats)
            return null
        }

        emitMemoryRoutingSelection(
            conversationId,
            taskId,
            candidates.permanent,
            'gathered-results',
            eventMeta,
            undefined,
            formatGraphOnly(aggregator, candidates.graph),
            'retrieval',
            pipelineStats,
        )
        if (rerankerEnabled) emitMemoryPipelineStatus(conversationId, taskId, 'selecting-memory', eventMeta)
        else emitMemoryCurationStatus(conversationId, taskId, eventMeta)
        let selection = rerankerEnabled ? null : await selectMemoryContext({
            conversationId,
            gateway,
            providerId,
            model,
            query: primaryQuery,
            recentMessages,
            candidates,
            signal,
            debugContextEnabled,
        })

        // One bounded corrective pass: do not inject merely related evidence
        // when the verifier says the current pool cannot answer the request.
        const correctiveQuery = selection?.answerable === false ? selection.correctiveQuery?.trim() : ''
        if (correctiveQuery && !retrievalQueries.includes(correctiveQuery)) {
            const correctedStats: MemoryRetrievalStatusDetails = {}
            const corrected = await aggregator.aggregate(correctiveQuery, {
                agentId,
                categoryIds: memoryFolderIds,
                permanentTopK: retrievalCount,
                includeGraph: true,
                graphQuery: qualifyFirstPersonGraphQuery(correctiveQuery),
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
            candidates = filterAutoMemoryCandidates(fusedCandidates)
            pipelineStats = buildMemoryPipelineStats(retrievalResults, retrievalStats, fusedCandidates, candidates, rerankerEnabled)
            emitMemoryRoutingSelection(
                conversationId,
                taskId,
                candidates.permanent,
                'gathered-results',
                eventMeta,
                undefined,
                formatGraphOnly(aggregator, candidates.graph),
                'retrieval',
                pipelineStats,
            )
            selection = rerankerEnabled ? null : await selectMemoryContext({
                conversationId,
                gateway,
                providerId,
                model,
                query: primaryQuery,
                recentMessages,
                candidates,
                signal,
                debugContextEnabled,
            })
        }

        const selectedPermanent = selection
            ? resolveSelectedMemories(candidates.permanent, selection.memoryIds)
            : candidates.permanent.slice(0, MAX_SELECTED_MEMORIES)
        const selectedGraph = selection
            ? resolveSelectedGraph(candidates.graph, selection.graphEdgeIds)
            : takeGraphEdges(candidates.graph, MAX_SELECTED_GRAPH_EDGES)
        const selectedMemory: AggregatedMemory = {
            permanent: selection?.answerable === false ? [] : selectedPermanent,
            graph: selection?.answerable === false ? undefined : selectedGraph,
        }

        // Keep the visible context-gathering event in lockstep with the
        // evidence formatted for the main model. The graph supplement is not
        // part of `permanent`, so omitting it here makes injected context
        // invisible to users (and incorrectly reports an empty selection for
        // graph-only results).
        const graphContext = selectedMemory.graph?.edges.length
            ? aggregator.format({ permanent: [], graph: selectedMemory.graph })
            : ''

        const selectionMethod = rerankerEnabled ? 'reranker' : selection ? 'llm' : 'ranked-fallback'
        emitMemoryRoutingSelection(
            conversationId,
            taskId,
            selectedMemory.permanent,
            'gathered-context',
            eventMeta,
            selectedMemory.permanent.length || graphContext ? undefined : 'none-relevant',
            graphContext,
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
            ...(selectedMemory.graph?.edges || []).map((edge) => ({
                kind: 'graph-assertion' as const,
                sourceId: edge.id,
                documentId: edge.sourceDocumentId || edge.sourceChunk?.documentId,
                revision: edge.sourceContentHash,
                chunkIndex: edge.sourceChunkIndex ?? edge.sourceChunk?.chunkIndex,
                retrievalMethod: 'knowledge-graph',
                selectionMethod,
                relevance: edge.retrievalRelevance,
                verificationStatus,
            })),
        ]
        return { content: formatted, evidence }
    } catch (err) {
        if ((err as Error).name === 'AbortError' || signal?.aborted) throw err
        console.warn('[memory-router] Routing failed, continuing without auto-memory:', err)
        emitMemoryRoutingSelection(conversationId, taskId, [], 'gathered-context', eventMeta, 'routing-failed', undefined, 'routing-failed')
        return null
    }
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
        relativeScoreThreshold: MIN_RELATIVE_MEMORY_SCORE,
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

function formatGraphOnly(aggregator: ReturnType<typeof getMemoryAggregator>, graph: KnowledgeGraphProjection | undefined): string {
    return graph?.edges.length ? aggregator.format({ permanent: [], graph }) : ''
}

function qualifyFirstPersonGraphQuery(query: string): string {
    const userName = getUserSettings().name.trim()
    if (!userName || !/\b(my|me|mine|our|mein|meine|meiner|meinen|unser|unsere|mir|mich)\b/i.test(query)) return query
    return `${query}\nCurrent user: ${userName}`
}

export function emitAutoMemoryRoutingSkipped(
    _conversationId: string,
    _reason: 'disabled' | 'empty-scope' | 'no-query' | 'not-required',
    _eventMeta?: Record<string, unknown>,
): void {
    // Static or disabled memory selection is not auto-memory routing, so do
    // not create a visible context-gathering step unless the router runs.
}

function shouldRouteMemory(userQuery?: string, opts: { enabled?: boolean } = {}): boolean {
    return opts.enabled === true && Boolean(userQuery?.trim())
}

async function selectMemoryContext(input: {
    conversationId: string
    gateway: LLMGateway
    providerId?: string
    model?: string
    query: string
    recentMessages: ChatMessage[]
    candidates: AggregatedMemory
    signal?: AbortSignal
    debugContextEnabled?: boolean
}): Promise<MemoryContextSelection | null> {
    if (!input.candidates.permanent.length && !input.candidates.graph?.edges.length) return null

    try {
        const candidateIds = input.candidates.permanent.map((_, index) => memoryCandidateId(index))
        const graphEdgeIds = (input.candidates.graph?.edges || []).map((_, index) => graphCandidateId(index))
        const request: Parameters<LLMGateway['complete']>[0] = {
            messages: [
                {
                    role: 'system',
                    content: [
                        'You curate retrieved memory candidates before the main assistant run.',
                        'Given the current request, recent conversation, text candidates, and source-grounded graph edges, call select_memory_context.',
                        `Select at most ${MAX_SELECTED_MEMORIES} memory IDs.`,
                        `Select at most ${MAX_SELECTED_GRAPH_EDGES} graph edge IDs.`,
                        'Evidence must directly support the requested fact or operation; topical similarity is insufficient.',
                        'Treat the provided match score as a strong relevance signal. Prefer higher-scoring evidence when candidates support the same fact.',
                        'A close friend does not entail best friend. A related project does not entail the requested project.',
                        'Set answerable=false and select nothing when the pool lacks direct evidence.',
                        'When answerable=false, provide one precise corrective query in the user request language that preserves names, relationship terms, identifiers, and constraints.',
                        'Prefer graph edges only when their predicate directly answers the request, and keep their cited source evidence.',
                        'Do not answer the user. Do not include rationale. /no_think',
                    ].join('\n'),
                },
                {
                    role: 'user',
                    content: [
                        buildRecentConversationBlock(input.recentMessages),
                        `Current request: ${input.query}`,
                        '',
                        'Memory candidates:',
                        ...input.candidates.permanent.map((candidate, index) => formatMemoryCandidate(candidate, candidateIds[index])),
                        '',
                        'Graph candidates:',
                        ...(input.candidates.graph?.edges || []).map((edge, index) => formatGraphCandidate(edge, graphEdgeIds[index])),
                    ].filter(Boolean).join('\n'),
                },
            ],
            model: input.model,
            maxTokens: 1_500,
            tools: [buildMemoryContextSelectionTool(candidateIds, graphEdgeIds)],
            toolChoice: { type: 'function', name: MEMORY_CONTEXT_SELECTION_TOOL_NAME },
            thinkingEnabled: false,
            signal: input.signal,
        }
        const result = await completeWithDebugCapture({
            enabled: input.debugContextEnabled,
            conversationId: input.conversationId,
            phase: 'memory-curation',
            label: 'Memory evidence verification',
            gateway: input.gateway,
            providerId: input.providerId,
            request,
        })

        recordAuxiliaryModelUsage({
            kind: 'memory-router',
            provider: input.providerId || '',
            model: result.model || input.model || '',
            inputTokens: result.usage?.promptTokens,
            outputTokens: result.usage?.completionTokens,
        })

        const selectionCall = result.toolCalls?.find((call) => call.function.name === MEMORY_CONTEXT_SELECTION_TOOL_NAME)
        return selectionCall ? parseMemoryContextSelection(selectionCall.function.arguments, candidateIds, graphEdgeIds) : null
    } catch (err) {
        if ((err as Error).name === 'AbortError' || input.signal?.aborted) throw err
        console.warn('[memory-router] Memory context curation failed, using top ranked memories:', err)
        return null
    }
}

function buildMemoryContextSelectionTool(candidateIds: string[], graphEdgeIds: string[]): ToolDefinition {
    const properties: Record<string, unknown> = {
        memoryIds: {
            type: 'array',
            description: 'Candidate IDs to include in context, ordered by usefulness.',
            items: { type: 'string', enum: candidateIds },
            maxItems: MAX_SELECTED_MEMORIES,
        },
        graphEdgeIds: {
            type: 'array',
            description: 'Graph edge candidate IDs to include as evidence.',
            items: { type: 'string', enum: graphEdgeIds },
            maxItems: MAX_SELECTED_GRAPH_EDGES,
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
            required: ['memoryIds', 'graphEdgeIds', 'answerable'],
        },
        execute: async () => ({ success: true, output: 'ok' }),
    }
}

function parseMemoryContextSelection(raw: string, candidateIds: string[], graphCandidateIds: string[]): MemoryContextSelection | null {
    try {
        const parsed = JSON.parse(raw) as { memoryIds?: unknown; graphEdgeIds?: unknown; answerable?: unknown; correctiveQuery?: unknown }
        if (!Array.isArray(parsed.memoryIds)) return null

        const allowed = new Set(candidateIds)
        const requestedIds = parsed.memoryIds.filter((id): id is string => typeof id === 'string')
        const memoryIds = requestedIds
            .filter((id) => allowed.has(id))
            .filter((id, index, arr) => arr.indexOf(id) === index)
            .slice(0, MAX_SELECTED_MEMORIES)
        if (requestedIds.length > 0 && memoryIds.length === 0) return null

        const allowedGraph = new Set(graphCandidateIds)
        const requestedGraphIds = Array.isArray(parsed.graphEdgeIds)
            ? parsed.graphEdgeIds.filter((id): id is string => typeof id === 'string')
            : []
        const graphEdgeIds = requestedGraphIds
            .filter((id) => allowedGraph.has(id))
            .filter((id, index, arr) => arr.indexOf(id) === index)
            .slice(0, MAX_SELECTED_GRAPH_EDGES)
        if (requestedGraphIds.length > 0 && graphEdgeIds.length === 0) return null

        const answerable = typeof parsed.answerable === 'boolean'
            ? parsed.answerable
            : memoryIds.length > 0 || graphEdgeIds.length > 0
        const correctiveQuery = typeof parsed.correctiveQuery === 'string'
            ? parsed.correctiveQuery.trim().slice(0, 500)
            : ''

        return { memoryIds, graphEdgeIds, answerable, correctiveQuery: correctiveQuery || undefined }
    } catch {
        return null
    }
}

function resolveSelectedMemories(candidates: RetrievedChunk[], memoryIds: string[]): RetrievedChunk[] {
    const byId = new Map(candidates.map((candidate, index) => [memoryCandidateId(index), candidate]))
    return memoryIds
        .map((id) => byId.get(id))
        .filter((candidate): candidate is RetrievedChunk => Boolean(candidate))
        .sort((a, b) => memoryMatch(b).score - memoryMatch(a).score)
}

function resolveSelectedGraph(graph: KnowledgeGraphProjection | undefined, graphEdgeIds: string[]): KnowledgeGraphProjection | undefined {
    if (!graph || !graphEdgeIds.length) return undefined
    const byId = new Map(graph.edges.map((edge, index) => [graphCandidateId(index), edge]))
    const selectedIds = new Set(graphEdgeIds.map((id) => byId.get(id)?.id).filter((id): id is string => Boolean(id)))
    return filterGraphEdges(graph, selectedIds)
}

function takeGraphEdges(graph: KnowledgeGraphProjection | undefined, limit: number): KnowledgeGraphProjection | undefined {
    if (!graph?.edges.length) return undefined
    return filterGraphEdges(graph, new Set(graph.edges.slice(0, limit).map((edge) => edge.id)))
}

function filterGraphEdges(graph: KnowledgeGraphProjection, edgeIds: Set<string>): KnowledgeGraphProjection | undefined {
    const edges = graph.edges.filter((edge) => edgeIds.has(edge.id))
    if (!edges.length) return undefined
    const nodeIds = new Set(edges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]))
    return {
        edges,
        nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
        seedNodes: graph.seedNodes.filter((node) => nodeIds.has(node.id)),
    }
}

function buildRouterQuery(currentMessage: string, messages: ChatMessage[] = []): string {
    const recent = messages
        .filter(({ role }) => role === 'user' || role === 'assistant')
        .slice(-5)

    if (!recent.length) return currentMessage

    const context = recent
        .map(({ role, content }) => `${role}: ${messageContentForRouter(content).slice(0, TURN_CHAR_LIMIT)}`)
        .join('\n')

    return `Recent conversation:\n${context}\n\nCurrent request: ${currentMessage}`
}

function buildRecentConversationBlock(messages: ChatMessage[]): string {
    const recent = messages
        .filter(({ role }) => role === 'user' || role === 'assistant')
        .slice(-5)

    if (!recent.length) return ''

    const context = recent
        .map(({ role, content }) => `${role}: ${messageContentForRouter(content).slice(0, TURN_CHAR_LIMIT)}`)
        .join('\n')

    return `Recent conversation:\n${context}\n`
}

function memoryCandidateId(index: number): string {
    return `m${index + 1}`
}

function graphCandidateId(index: number): string {
    return `g${index + 1}`
}

function formatGraphCandidate(edge: KnowledgeAssertion, id: string): string {
    const relation = edge.relation.replace(/_/g, ' ')
    const source = edge.sourceId ? `source=${edge.sourceId}` : ''
    const part = edge.sourceChunkIndex !== undefined ? `part=${edge.sourceChunkIndex + 1}` : ''
    const relevance = edge.retrievalRelevance === undefined ? '' : `relevance=${edge.retrievalRelevance.toFixed(2)}`
    return `- ${id} (${[source, part, relevance].filter(Boolean).join(', ')}): ${edge.fromName} -> ${relation} -> ${edge.toName}. ${edge.note || ''}`
}

function formatMemoryCandidate(candidate: RetrievedChunk, id: string): string {
    const score = memoryMatch(candidate).score
    const metadata = [
        candidate.categoryName ? `space=${candidate.categoryName}` : '',
        candidate.sourceFile ? `source=${candidate.sourceFile}` : '',
        candidate.chunkIndex != null ? `part=${candidate.chunkIndex + 1}${candidate.totalChunks ? `/${candidate.totalChunks}` : ''}` : '',
        typeof score === 'number' && Number.isFinite(score) ? `score=${score.toFixed(4)}` : '',
    ].filter(Boolean).join(', ')
    const text = candidate.text.trim().slice(0, CANDIDATE_CHAR_LIMIT)

    return [
        `- ${id}${metadata ? ` (${metadata})` : ''}:`,
        text,
    ].join('\n')
}

function messageContentForRouter(content: string | ContentPart[]): string {
    if (typeof content === 'string') return content
    const text = content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim()
    return text || '[multipart content]'
}

function filterAutoMemoryCandidates(memory: AggregatedMemory): AggregatedMemory {
    const permanent = filterWeakRelativeMatches(memory.permanent)
    return { permanent, graph: memory.graph }
}

/** Merge results from the original and expanded queries using the same match
 * score used for filtering, curation, context ordering, and UI display. */
function fuseAutoMemoryResults(results: AggregatedMemory[]): AggregatedMemory {
    const ranked = new Map<string, RetrievedChunk>()
    for (const result of results) {
        result.permanent.forEach((chunk) => {
            const key = chunk.id || [chunk.categoryId, chunk.sourceFile, chunk.chunkIndex].join('\u0000')
            const existing = ranked.get(key)
            if (!existing || memoryMatch(chunk).score > memoryMatch(existing).score) ranked.set(key, chunk)
        })
    }
    const permanent = sortMemoriesByMatch([...ranked.values()])

    const edgeMap = new Map<string, NonNullable<AggregatedMemory['graph']>['edges'][number]>()
    const nodeMap = new Map<string, NonNullable<AggregatedMemory['graph']>['nodes'][number]>()
    const seedMap = new Map<string, NonNullable<AggregatedMemory['graph']>['seedNodes'][number]>()
    for (const graph of results.map((result) => result.graph).filter(Boolean)) {
        for (const edge of graph!.edges) edgeMap.set(edge.id, edge)
        for (const node of graph!.nodes) nodeMap.set(node.id, node)
        for (const seed of graph!.seedNodes) seedMap.set(seed.id, seed)
    }
    const edges = [...edgeMap.values()]
        .sort((a, b) => (b.retrievalRelevance || 0) - (a.retrievalRelevance || 0)
            || b.importance - a.importance || b.lastSeenAt - a.lastSeenAt)
        .slice(0, 8)
    const includedNodeIds = new Set(edges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]))
    const graph = edges.length > 0
        ? {
            seedNodes: [...seedMap.values()].filter((node) => includedNodeIds.has(node.id)),
            nodes: [...nodeMap.values()].filter((node) => includedNodeIds.has(node.id)),
            edges,
        }
        : undefined
    return { permanent, graph }
}

/**
 * Remove the weak tail relative to the best visible match. This deliberately
 * uses the exact score shown in the UI and supplied to LLM curation.
 */
function filterWeakRelativeMatches(candidates: RetrievedChunk[]): RetrievedChunk[] {
    const sorted = sortMemoriesByMatch(candidates)
    if (sorted.length <= 1) return sorted
    const scores = sorted.map((candidate) => memoryMatch(candidate).score)
    const best = Math.max(...scores.filter((score) => Number.isFinite(score) && score > 0))
    if (!Number.isFinite(best)) return sorted
    const threshold = best * MIN_RELATIVE_MEMORY_SCORE
    return sorted.filter((_, index) => Number.isFinite(scores[index]) && scores[index] >= threshold)
}

function sortMemoriesByMatch(candidates: RetrievedChunk[]): RetrievedChunk[] {
    return [...candidates].sort((a, b) => memoryMatch(b).score - memoryMatch(a).score)
}

function memoryLabel(chunk: RetrievedChunk): string {
    const label = [
        chunk.categoryName,
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
        message: 'Selecting relevant memories...',
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
    graphContext?: string,
    selectionMethod: 'retrieval' | 'reranker' | 'llm' | 'ranked-fallback' | 'routing-failed' = contextPhase === 'gathered-results' ? 'retrieval' : 'llm',
    pipelineStats?: MemoryPipelineStats,
): void {
    const visiblePipelineStats = contextPhase === 'gathered-results' || (!memories.length && !graphContext)
        ? pipelineStats
        : undefined
    const toolCalls = sortMemoriesByMatch(memories).map((memory) => {
        const visibleMatch = memoryMatch(memory)
        return {
            name: memoryLabel(memory),
            arguments: JSON.stringify({
                type: 'memory',
                selectionMethod,
                contextPhase,
                sourceFile: memory.sourceFile,
                directoryPath: memory.categoryName,
                chunkIndex: memory.chunkIndex,
                content: memory.text,
                matchScore: visibleMatch.score,
                scoreType: visibleMatch.scoreType,
                pipelineStats: visiblePipelineStats,
            }),
        }
    })

    if (graphContext) {
        toolCalls.push({
            name: 'Knowledge Context',
            arguments: JSON.stringify({
                type: 'memory',
                memoryKind: 'knowledge',
                selectionMethod,
                contextPhase,
                content: graphContext,
                pipelineStats: visiblePipelineStats,
            }),
        })
    }

    getEventBus().emit('step:tools-chosen', {
        conversationId,
        taskId,
        iteration: 0,
        ...eventMeta,
        toolCalls: toolCalls.length ? toolCalls : [{
            name: memoryEmptyLabel(emptyReason),
            arguments: JSON.stringify({
                type: 'memory',
                contextPhase,
                selectionMethod,
                emptyReason: emptyReason || 'none-selected',
                content: memoryEmptyContent(emptyReason),
                pipelineStats: visiblePipelineStats,
            }),
        }],
    })
}

function memoryMatch(memory: RetrievedChunk): {
    score: number
    scoreType: 'dense' | 'lexical' | 'fusion' | 'reranker' | 'entity-resolution' | undefined
} {
    if (typeof memory.rerankerScore === 'number' && Number.isFinite(memory.rerankerScore)) {
        return { score: normalizeMatchScore(memory.rerankerScore), scoreType: 'reranker' }
    }
    if (typeof memory.denseScore === 'number' && Number.isFinite(memory.denseScore)) {
        return { score: normalizeMatchScore(memory.denseScore), scoreType: 'dense' }
    }
    return { score: normalizeMatchScore(memory.score), scoreType: memory.scoreType }
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
