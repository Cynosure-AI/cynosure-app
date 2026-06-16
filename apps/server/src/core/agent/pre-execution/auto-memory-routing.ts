import { nanoid } from 'nanoid'
import { getEventBus } from '../../telemetry/event-bus.js'
import { getMemoryAggregator, type AggregatedMemory } from '../../memory/memory-aggregator.js'
import type { ChatMessage, ContentPart } from '../../gateway/providers/base.provider.js'
import type { RetrievedChunk } from '../../memory/parser.js'

const AUTO_MEMORY_RETRIEVAL_COUNT = 12
const MAX_SELECTED_MEMORIES = 5
const TURN_CHAR_LIMIT = 200
const MIN_AUTO_MEMORY_VECTOR_SCORE = 0.22
const MIN_AUTO_MEMORY_RERANKER_SCORE = 0.1

export interface ApplyAutoMemoryRoutingInput {
    enabled: boolean
    conversationId: string
    userQuery?: string
    recentMessages?: ChatMessage[]
    agentId?: string
    memorySpaceIds?: string[]
    /** Extra metadata to merge into emitted EventBus events (e.g. maCodename for sub-agents). */
    eventMeta?: Record<string, unknown>
}

export async function applyAutoMemoryRouting(input: ApplyAutoMemoryRoutingInput): Promise<string | null> {
    const {
        enabled,
        conversationId,
        userQuery,
        recentMessages = [],
        agentId,
        memorySpaceIds,
        eventMeta,
    } = input

    if (!shouldRouteMemory(userQuery, { enabled })) return null

    const taskId = `memory_router_${nanoid()}`
    const aggregator = getMemoryAggregator()

    try {
        emitMemoryRoutingStatus(conversationId, taskId, eventMeta)
        const primaryQuery = userQuery?.trim() || ''
        const contextualQuery = buildRouterQuery(primaryQuery, recentMessages)
        let candidates = filterAutoMemoryCandidates(await aggregator.aggregate(primaryQuery, {
            agentId,
            spaceIds: memorySpaceIds,
            permanentTopK: AUTO_MEMORY_RETRIEVAL_COUNT,
        }), primaryQuery)
        if (!candidates.permanent.length && !candidates.graph?.edges.length && contextualQuery !== primaryQuery) {
            candidates = filterAutoMemoryCandidates(await aggregator.aggregate(contextualQuery, {
                agentId,
                spaceIds: memorySpaceIds,
                permanentTopK: AUTO_MEMORY_RETRIEVAL_COUNT,
            }), contextualQuery)
        }

        if (!candidates.permanent.length && !candidates.graph?.edges.length) {
            emitMemoryRoutingSelection(conversationId, taskId, [], eventMeta)
            return null
        }

        if (!candidates.permanent.length && candidates.graph?.edges.length) {
            emitMemoryRoutingSelection(conversationId, taskId, [], eventMeta)
            return aggregator.format({ permanent: [], graph: candidates.graph }) || null
        }

        const selectedMemory: AggregatedMemory = {
            permanent: candidates.permanent.slice(0, MAX_SELECTED_MEMORIES),
            graph: candidates.graph,
        }

        emitMemoryRoutingSelection(conversationId, taskId, selectedMemory.permanent, eventMeta)
        const formatted = aggregator.format(selectedMemory)
        return formatted || null
    } catch (err) {
        console.warn('[memory-router] Routing failed, continuing without auto-memory:', err)
        emitMemoryRoutingSelection(conversationId, taskId, [], eventMeta)
        return null
    }
}

function shouldRouteMemory(userQuery?: string, opts: { enabled?: boolean } = {}): boolean {
    return opts.enabled === true && Boolean(userQuery?.trim())
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
    const relevant = memory.permanent.filter((chunk) => isRelevantAutoMemory(chunk))
    return {
        permanent: relevant,
        graph: relevant.length > 0 || graphSeedMatchesQuery(memory.graph, query) ? memory.graph : undefined,
    }
}

function isRelevantAutoMemory(chunk: RetrievedChunk): boolean {
    if (typeof chunk.rerankerScore === 'number' && Number.isFinite(chunk.rerankerScore)) {
        return chunk.rerankerScore >= MIN_AUTO_MEMORY_RERANKER_SCORE
    }
    if (typeof chunk.score === 'number' && Number.isFinite(chunk.score) && chunk.score >= MIN_AUTO_MEMORY_VECTOR_SCORE) {
        return true
    }
    return false
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

function emitMemoryRoutingSelection(conversationId: string, taskId: string, memories: RetrievedChunk[], eventMeta?: Record<string, unknown>): void {
    getEventBus().emit('step:tools-chosen', {
        conversationId,
        taskId,
        iteration: 0,
        ...eventMeta,
        toolCalls: memories.map((memory) => ({
            name: memoryLabel(memory),
            arguments: JSON.stringify({
                type: 'memory',
                sourceFile: memory.sourceFile,
                folderPath: memory.spaceName,
                chunkIndex: memory.chunkIndex,
                rerankerScore: memory.rerankerScore,
            }),
        })),
    })
}
