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
    includeGraph: boolean
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
        let candidates = filterAutoMemoryCandidates(await aggregator.aggregate(primaryQuery, {
            agentId,
            spaceIds: memorySpaceIds,
            permanentTopK: AUTO_MEMORY_RETRIEVAL_COUNT,
        }), primaryQuery)
        signal?.throwIfAborted()
        if (!candidates.permanent.length && !candidates.graph?.edges.length && contextualQuery !== primaryQuery) {
            candidates = filterAutoMemoryCandidates(await aggregator.aggregate(contextualQuery, {
                agentId,
                spaceIds: memorySpaceIds,
                permanentTopK: AUTO_MEMORY_RETRIEVAL_COUNT,
            }), contextualQuery)
        }

        if (!candidates.permanent.length && !candidates.graph?.edges.length) {
            emitMemoryRoutingSelection(conversationId, taskId, [], 'gathered-context', eventMeta, 'none-found')
            return null
        }

        if (!candidates.permanent.length && candidates.graph?.edges.length) {
            emitMemoryRoutingSelection(conversationId, taskId, [], 'gathered-context', eventMeta, 'graph-only')
            return aggregator.format({ permanent: [], graph: candidates.graph }) || null
        }

        emitMemoryRoutingSelection(conversationId, taskId, candidates.permanent, 'gathered-results', eventMeta)
        emitMemoryCurationStatus(conversationId, taskId, eventMeta)
        const selection = await selectMemoryContext({
            gateway,
            providerId,
            model,
            query: primaryQuery,
            recentMessages,
            candidates: candidates.permanent,
            hasGraph: Boolean(candidates.graph?.edges.length),
            signal,
        })
        const selectedPermanent = selection
            ? resolveSelectedMemories(candidates.permanent, selection.memoryIds)
            : candidates.permanent.slice(0, MAX_SELECTED_MEMORIES)
        const selectedMemory: AggregatedMemory = {
            permanent: selectedPermanent,
            graph: selection?.includeGraph === false ? undefined : candidates.graph,
        }

        emitMemoryRoutingSelection(
            conversationId,
            taskId,
            selectedMemory.permanent,
            'gathered-context',
            eventMeta,
            selectedMemory.permanent.length ? undefined : 'none-relevant',
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
    hasGraph: boolean
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
                        input.hasGraph
                            ? 'Set includeGraph to true only if the related entity graph is likely useful context.'
                            : '',
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
            tools: [buildMemoryContextSelectionTool(candidateIds, input.hasGraph)],
            toolChoice: { type: 'function', name: MEMORY_CONTEXT_SELECTION_TOOL_NAME },
            thinkingEnabled: false,
            signal: input.signal,
        }, input.providerId)

        const selectionCall = result.toolCalls?.find((call) => call.function.name === MEMORY_CONTEXT_SELECTION_TOOL_NAME)
        return selectionCall ? parseMemoryContextSelection(selectionCall.function.arguments, candidateIds, input.hasGraph) : null
    } catch (err) {
        if ((err as Error).name === 'AbortError' || input.signal?.aborted) throw err
        console.warn('[memory-router] Memory context curation failed, using top ranked memories:', err)
        return null
    }
}

function buildMemoryContextSelectionTool(candidateIds: string[], hasGraph: boolean): ToolDefinition {
    const properties: Record<string, unknown> = {
        memoryIds: {
            type: 'array',
            description: 'Candidate IDs to include in context, ordered by usefulness.',
            items: { type: 'string', enum: candidateIds },
            maxItems: MAX_SELECTED_MEMORIES,
        },
    }
    const required = ['memoryIds']
    if (hasGraph) {
        properties.includeGraph = {
            type: 'boolean',
            description: 'Whether the related entity graph should also be included.',
        }
        required.push('includeGraph')
    }
    return {
        name: MEMORY_CONTEXT_SELECTION_TOOL_NAME,
        description: 'Select the retrieved memory candidates that should be injected into the main assistant context.',
        timeout: 10_000,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties,
            required,
        },
        execute: async () => ({ success: true, output: 'ok' }),
    }
}

function parseMemoryContextSelection(raw: string, candidateIds: string[], hasGraph: boolean): MemoryContextSelection | null {
    try {
        const parsed = JSON.parse(raw) as { memoryIds?: unknown; includeGraph?: unknown }
        if (!Array.isArray(parsed.memoryIds)) return null

        const allowed = new Set(candidateIds)
        const requestedIds = parsed.memoryIds.filter((id): id is string => typeof id === 'string')
        const memoryIds = requestedIds
            .filter((id) => allowed.has(id))
            .filter((id, index, arr) => arr.indexOf(id) === index)
            .slice(0, MAX_SELECTED_MEMORIES)
        if (requestedIds.length > 0 && memoryIds.length === 0) return null

        return {
            memoryIds,
            includeGraph: hasGraph && parsed.includeGraph === true,
        }
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

function filterAutoMemoryCandidates(memory: AggregatedMemory, query: string): AggregatedMemory {
    const permanent = filterWeakRelativeMatches(memory.permanent)
    return {
        permanent,
        graph: permanent.length > 0 || graphSeedMatchesQuery(memory.graph, query) ? memory.graph : undefined,
    }
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

function graphSeedMatchesQuery(graph: AggregatedMemory['graph'], query: string): boolean {
    if (!graph?.edges.length || !graph.seedNodes.length) return false
    const haystack = normalizeForKeywordMatch(query)
    return graph.seedNodes.some((node) => {
        const names = [node.name, ...node.aliases].map(normalizeForKeywordMatch).filter(Boolean)
        return names.some((name) => name.length >= 3 && haystack.includes(name))
    })
}

function normalizeForKeywordMatch(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
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
    emptyReason?: 'none-found' | 'none-relevant' | 'graph-only' | 'routing-failed' | 'disabled' | 'empty-scope' | 'no-query',
): void {
    getEventBus().emit('step:tools-chosen', {
        conversationId,
        taskId,
        iteration: 0,
        ...eventMeta,
        toolCalls: memories.length ? memories.map((memory) => ({
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
        })) : [{
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
        case 'graph-only': return 'Memory graph matched'
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
            return 'Auto memory ran, but no memory snippets or graph relationships matched this turn.'
        case 'none-relevant':
            return 'Auto memory found candidates, but the curation step selected none as useful for this turn.'
        case 'graph-only':
            return 'Auto memory found related graph context, but no permanent memory snippets matched.'
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
