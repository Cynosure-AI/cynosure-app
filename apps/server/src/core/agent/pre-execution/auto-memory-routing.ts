import { nanoid } from 'nanoid'
import { getEventBus } from '../../telemetry/event-bus.js'
import { getMemoryAggregator, type AggregatedMemory } from '../../memory/memory-aggregator.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage, ContentPart, ToolDefinition } from '../../gateway/providers/base.provider.js'
import type { RetrievedChunk } from '../../memory/parser.js'

const AUTO_MEMORY_RETRIEVAL_COUNT = 12
const MAX_SELECTED_MEMORIES = 5
const TURN_CHAR_LIMIT = 200
const CANDIDATE_CHAR_LIMIT = 1_200
const MIN_RELATIVE_MEMORY_SCORE = 0.65
const MIN_MEMORY_CANDIDATES = 3
const MEMORY_CONTEXT_SELECTION_TOOL_NAME = 'select_memory_context'

export interface ApplyAutoMemoryRoutingInput {
    enabled: boolean
    conversationId: string
    userQuery?: string
    recentMessages?: ChatMessage[]
    gateway: LLMGateway
    providerId?: string
    model?: string
    agentId?: string
    memorySpaceIds?: string[]
    /** Extra metadata to merge into emitted EventBus events (e.g. maCodename for sub-agents). */
    eventMeta?: Record<string, unknown>
    signal?: AbortSignal
}

interface MemoryContextSelection {
    memoryIds: string[]
}

export async function applyAutoMemoryRouting(input: ApplyAutoMemoryRoutingInput): Promise<string | null> {
    const {
        enabled,
        conversationId,
        userQuery,
        recentMessages = [],
        gateway,
        providerId,
        model,
        agentId,
        memorySpaceIds,
        eventMeta,
        signal,
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
        const retrievalQueries = Array.from(new Set([primaryQuery, contextualQuery].filter(Boolean)))
        const candidates = filterAutoMemoryCandidates(fuseAutoMemoryResults(await Promise.all(
            retrievalQueries.map((query) => aggregator.aggregate(query, {
                agentId,
                spaceIds: memorySpaceIds,
                permanentTopK: AUTO_MEMORY_RETRIEVAL_COUNT,
                includeGraph: true,
            })),
        )))
        signal?.throwIfAborted()

        if (!candidates.permanent.length && !candidates.graph?.edges.length) {
            emitMemoryRoutingSelection(conversationId, taskId, [], 'gathered-context', eventMeta, 'none-found')
            return null
        }

        emitMemoryRoutingSelection(conversationId, taskId, candidates.permanent, 'gathered-results', eventMeta)
        let selectedPermanent: RetrievedChunk[] = []
        if (candidates.permanent.length > 0) {
            emitMemoryCurationStatus(conversationId, taskId, eventMeta)
            const selection = await selectMemoryContext({
                gateway,
                providerId,
                model,
                query: primaryQuery,
                recentMessages,
                candidates: candidates.permanent,
                signal,
            })
            selectedPermanent = selection
                ? resolveSelectedMemories(candidates.permanent, selection.memoryIds)
                : candidates.permanent.slice(0, MAX_SELECTED_MEMORIES)
        }
        const selectedMemory: AggregatedMemory = {
            permanent: selectedPermanent,
            graph: candidates.graph,
        }

        // Keep the visible context-gathering event in lockstep with the
        // evidence formatted for the main model. The graph supplement is not
        // part of `permanent`, so omitting it here makes injected context
        // invisible to users (and incorrectly reports an empty selection for
        // graph-only results).
        const graphContext = selectedMemory.graph?.edges.length
            ? aggregator.format({ permanent: [], graph: selectedMemory.graph })
            : ''

        emitMemoryRoutingSelection(
            conversationId,
            taskId,
            selectedMemory.permanent,
            'gathered-context',
            eventMeta,
            selectedMemory.permanent.length || graphContext ? undefined : 'none-relevant',
            graphContext,
        )
        const formatted = aggregator.format(selectedMemory)
        return formatted || null
    } catch (err) {
        if ((err as Error).name === 'AbortError' || signal?.aborted) throw err
        console.warn('[memory-router] Routing failed, continuing without auto-memory:', err)
        emitMemoryRoutingSelection(conversationId, taskId, [], 'gathered-context', eventMeta, 'routing-failed')
        return null
    }
}

export function emitAutoMemoryRoutingSkipped(
    _conversationId: string,
    _reason: 'disabled' | 'empty-scope' | 'no-query',
    _eventMeta?: Record<string, unknown>,
): void {
    // Static or disabled memory selection is not auto-memory routing, so do
    // not create a visible context-gathering step unless the router runs.
}

function shouldRouteMemory(userQuery?: string, opts: { enabled?: boolean } = {}): boolean {
    return opts.enabled === true && Boolean(userQuery?.trim())
}

async function selectMemoryContext(input: {
    gateway: LLMGateway
    providerId?: string
    model?: string
    query: string
    recentMessages: ChatMessage[]
    candidates: RetrievedChunk[]
    signal?: AbortSignal
}): Promise<MemoryContextSelection | null> {
    if (!input.candidates.length) return null

    try {
        const candidateIds = input.candidates.map((_, index) => memoryCandidateId(index))
        const result = await input.gateway.complete({
            messages: [
                {
                    role: 'system',
                    content: [
                        'You curate retrieved memory candidates before the main assistant run.',
                        'Given the current request, recent conversation, and reranked memory candidates, call select_memory_context with only the memory IDs that are useful for answering or acting on the request.',
                        `Select at most ${MAX_SELECTED_MEMORIES} memory IDs.`,
                        'Prefer precise, directly useful memories over broadly related ones.',
                        'Return an empty list if none of the candidates are useful.',
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
                        ...input.candidates.map((candidate, index) => formatMemoryCandidate(candidate, candidateIds[index])),
                    ].filter(Boolean).join('\n'),
                },
            ],
            model: input.model,
            maxTokens: 300,
            tools: [buildMemoryContextSelectionTool(candidateIds)],
            toolChoice: { type: 'function', name: MEMORY_CONTEXT_SELECTION_TOOL_NAME },
            thinkingEnabled: false,
            signal: input.signal,
        }, input.providerId)

        const selectionCall = result.toolCalls?.find((call) => call.function.name === MEMORY_CONTEXT_SELECTION_TOOL_NAME)
        return selectionCall ? parseMemoryContextSelection(selectionCall.function.arguments, candidateIds) : null
    } catch (err) {
        if ((err as Error).name === 'AbortError' || input.signal?.aborted) throw err
        console.warn('[memory-router] Memory context curation failed, using top ranked memories:', err)
        return null
    }
}

function buildMemoryContextSelectionTool(candidateIds: string[]): ToolDefinition {
    const properties: Record<string, unknown> = {
        memoryIds: {
            type: 'array',
            description: 'Candidate IDs to include in context, ordered by usefulness.',
            items: { type: 'string', enum: candidateIds },
            maxItems: MAX_SELECTED_MEMORIES,
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
            required: ['memoryIds'],
        },
        execute: async () => ({ success: true, output: 'ok' }),
    }
}

function parseMemoryContextSelection(raw: string, candidateIds: string[]): MemoryContextSelection | null {
    try {
        const parsed = JSON.parse(raw) as { memoryIds?: unknown }
        if (!Array.isArray(parsed.memoryIds)) return null

        const allowed = new Set(candidateIds)
        const requestedIds = parsed.memoryIds.filter((id): id is string => typeof id === 'string')
        const memoryIds = requestedIds
            .filter((id) => allowed.has(id))
            .filter((id, index, arr) => arr.indexOf(id) === index)
            .slice(0, MAX_SELECTED_MEMORIES)
        if (requestedIds.length > 0 && memoryIds.length === 0) return null

        return { memoryIds }
    } catch {
        return null
    }
}

function resolveSelectedMemories(candidates: RetrievedChunk[], memoryIds: string[]): RetrievedChunk[] {
    const byId = new Map(candidates.map((candidate, index) => [memoryCandidateId(index), candidate]))
    return memoryIds
        .map((id) => byId.get(id))
        .filter((candidate): candidate is RetrievedChunk => Boolean(candidate))
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

function formatMemoryCandidate(candidate: RetrievedChunk, id: string): string {
    const score = typeof candidate.rerankerScore === 'number' && Number.isFinite(candidate.rerankerScore)
        ? candidate.rerankerScore
        : candidate.score
    const metadata = [
        candidate.spaceName ? `space=${candidate.spaceName}` : '',
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

/** Reciprocal-rank fusion makes short-turn and conversation-aware retrieval
 * complementary without comparing dense, hybrid, and reranker score scales. */
function fuseAutoMemoryResults(results: AggregatedMemory[]): AggregatedMemory {
    if (results.length <= 1) return results[0] || { permanent: [] }
    const ranked = new Map<string, { chunk: RetrievedChunk; score: number }>()
    for (const result of results) {
        result.permanent.forEach((chunk, index) => {
            const key = chunk.id || [chunk.spaceId, chunk.sourceFile, chunk.chunkIndex].join('\u0000')
            const existing = ranked.get(key)
            const score = 1 / (60 + index + 1)
            if (existing) existing.score += score
            else ranked.set(key, { chunk, score })
        })
    }
    const sorted = [...ranked.values()].sort((a, b) => b.score - a.score)
    const best = sorted[0]?.score || 1
    const permanent = sorted.map(({ chunk, score }) => ({
        ...chunk,
        score: score / best,
        rerankerScore: undefined,
        fusionScore: score,
        scoreType: 'fusion' as const,
    }))

    const edgeMap = new Map<string, NonNullable<AggregatedMemory['graph']>['edges'][number]>()
    const nodeMap = new Map<string, NonNullable<AggregatedMemory['graph']>['nodes'][number]>()
    const seedMap = new Map<string, NonNullable<AggregatedMemory['graph']>['seedNodes'][number]>()
    for (const graph of results.map((result) => result.graph).filter(Boolean)) {
        for (const edge of graph!.edges) edgeMap.set(edge.id, edge)
        for (const node of graph!.nodes) nodeMap.set(node.id, node)
        for (const seed of graph!.seedNodes) seedMap.set(seed.id, seed)
    }
    const edges = [...edgeMap.values()]
        .sort((a, b) => b.importance - a.importance || b.confidence - a.confidence || b.lastSeenAt - a.lastSeenAt)
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
 * Dense, RRF, and external-reranker scores have different scales, so an
 * absolute cross-mode cutoff is invalid. Remove only the weak tail relative
 * to the best result while retaining a small recall floor for LLM curation.
 */
function filterWeakRelativeMatches(candidates: RetrievedChunk[]): RetrievedChunk[] {
    if (candidates.length <= MIN_MEMORY_CANDIDATES) return candidates
    const scores = candidates.map((candidate) => candidate.rerankerScore ?? candidate.score)
    const best = Math.max(...scores.filter((score) => Number.isFinite(score) && score > 0))
    if (!Number.isFinite(best)) return candidates
    const threshold = best * MIN_RELATIVE_MEMORY_SCORE
    return candidates.filter((_, index) => index < MIN_MEMORY_CANDIDATES || (Number.isFinite(scores[index]) && scores[index] >= threshold))
}

function memoryLabel(chunk: RetrievedChunk): string {
    const label = [
        chunk.spaceName,
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

function emitMemoryRoutingSelection(
    conversationId: string,
    taskId: string,
    memories: RetrievedChunk[],
    contextPhase: 'gathered-results' | 'gathered-context' = 'gathered-context',
    eventMeta?: Record<string, unknown>,
    emptyReason?: 'none-found' | 'none-relevant' | 'routing-failed' | 'disabled' | 'empty-scope' | 'no-query',
    graphContext?: string,
): void {
    const toolCalls = memories.map((memory) => ({
        name: memoryLabel(memory),
        arguments: JSON.stringify({
            type: 'memory',
            contextPhase,
            sourceFile: memory.sourceFile,
            folderPath: memory.spaceName,
            chunkIndex: memory.chunkIndex,
            content: memory.text,
            rerankerScore: memory.rerankerScore,
        }),
    }))

    if (graphContext) {
        toolCalls.push({
            name: 'Entity Graph Context',
            arguments: JSON.stringify({
                type: 'memory',
                memoryKind: 'entity-graph',
                contextPhase,
                content: graphContext,
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
                emptyReason: emptyReason || 'none-selected',
                content: memoryEmptyContent(emptyReason),
            }),
        }],
    })
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
