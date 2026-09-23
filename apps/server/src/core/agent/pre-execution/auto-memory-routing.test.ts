import { afterEach, describe, expect, test, vi } from 'vitest'
import type { LLMGateway } from '../../gateway/gateway.js'
import { getEventBus } from '../../telemetry/event-bus.js'

function captureRoutingEvents(events: Array<Record<string, unknown>>): void {
    getEventBus().on('chat:event', (draft) => {
        const payload = (draft as { payload?: { type?: string; entries?: Array<{ name: string; details: Record<string, unknown> }> } }).payload
        if (payload?.type === 'routing-decision') events.push({
            toolCalls: payload.entries?.map((entry) => ({ name: entry.name, arguments: JSON.stringify(entry.details) })),
        })
    })
}

const memoryMocks = vi.hoisted(() => ({
    aggregate: vi.fn(),
    format: vi.fn(),
}))
const rerankerConfigMock = vi.hoisted(() => ({ enabled: false }))

vi.mock('../../memory/memory-aggregator.js', () => ({
    getMemoryAggregator: () => memoryMocks,
}))
vi.mock('../../memory/reranker.js', () => ({
    getMemoryReranker: () => ({ getConfig: () => ({ enabled: rerankerConfigMock.enabled }) }),
}))

import { applyAutoMemoryRouting } from './auto-memory-routing.js'

describe('automatic memory routing visibility', () => {
    afterEach(() => {
        getEventBus().removeAllListeners()
        vi.clearAllMocks()
        rerankerConfigMock.enabled = false
    })

    test('emits graph-only evidence as gathered context', async () => {
        const graphContext = '## Knowledge Context\n- [core] Cynosure -> uses -> entity memory.'
        memoryMocks.aggregate.mockResolvedValue({
            permanent: [],
            graph: { seedNodes: [], nodes: [], edges: [{ id: 'edge-1' }] },
        })
        memoryMocks.format.mockReturnValue(graphContext)

        const events: Array<Record<string, unknown>> = []
        captureRoutingEvents(events)

        const result = await applyAutoMemoryRouting({
            enabled: true,
            conversationId: 'conversation-1',
            userQuery: 'How is entity memory used?',
            gateway: {} as LLMGateway,
        })

        expect(result).toBe(graphContext)
        const finalEvent = events.at(-1)
        expect(finalEvent?.toolCalls).toEqual([{
            name: 'Knowledge Context',
            arguments: JSON.stringify({
                type: 'memory',
                memoryKind: 'knowledge',
                selectionMethod: 'ranked-fallback',
                contextPhase: 'gathered-context',
                content: graphContext,
            }),
        }])
    })

    test('uses the default result count for each retrieval query', async () => {
        memoryMocks.aggregate.mockResolvedValue({ permanent: [], graph: undefined })

        await applyAutoMemoryRouting({
            enabled: true,
            conversationId: 'conversation-2',
            userQuery: 'Find the deployment notes',
            gateway: {} as LLMGateway,
        })

        expect(memoryMocks.aggregate).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ permanentTopK: 10 }),
        )
    })

    test('uses the displayed semantic similarity as the effective match score', async () => {
        const candidate = {
            id: 'memory-1',
            text: 'Deployment uses the blue environment.',
            source: 'memory',
            sourceFile: 'deployment.md',
            categoryName: 'Uncategorized',
            chunkIndex: 0,
            score: 0.02,
            denseScore: 0.81,
            fusionScore: 0.02,
            scoreType: 'fusion' as const,
        }
        memoryMocks.aggregate.mockResolvedValue({ permanent: [candidate], graph: undefined })
        memoryMocks.format.mockReturnValue('formatted memory')
        const gateway = {
            complete: vi.fn().mockResolvedValue({
                toolCalls: [{
                    function: {
                        name: 'select_memory_context',
                        arguments: JSON.stringify({ memoryIds: ['m1'] }),
                    },
                }],
            }),
        } as unknown as LLMGateway
        const events: Array<Record<string, unknown>> = []
        captureRoutingEvents(events)

        await applyAutoMemoryRouting({
            enabled: true,
            conversationId: 'conversation-3',
            userQuery: 'How do we deploy?',
            recentMessages: [{ role: 'user', content: 'Continue the deployment setup.' }],
            gateway,
        })

        const gathered = events.find((event) => {
            const call = (event.toolCalls as Array<{ arguments: string }> | undefined)?.[0]
            return call && JSON.parse(call.arguments).contextPhase === 'gathered-results'
        })
        const args = JSON.parse((gathered!.toolCalls as Array<{ arguments: string }>)[0].arguments)
        expect(args).toMatchObject({
            type: 'memory',
            matchScore: 0.81,
            scoreType: 'dense',
        })
        expect(args).not.toHaveProperty('rerankerScore')
    })

    test('uses reranker match scores for merging, filtering, and descending output order', async () => {
        const candidate = (id: string, rerankerScore: number, denseScore: number) => ({
            id,
            text: `${id} content`,
            source: 'memory',
            sourceFile: `${id}.md`,
            score: rerankerScore,
            rerankerScore,
            denseScore,
            scoreType: 'reranker' as const,
        })
        memoryMocks.aggregate
            .mockResolvedValueOnce({
                permanent: [candidate('medium', 0.6, 0.95), candidate('weak', 0.4, 0.99)],
                graph: undefined,
            })
            .mockResolvedValueOnce({
                permanent: [candidate('best', 0.8, 0.3), candidate('medium', 0.55, 0.95)],
                graph: undefined,
            })
        memoryMocks.format.mockImplementation((memory: { permanent: Array<{ id: string }> }) => (
            memory.permanent.map(({ id }) => id).join(',')
        ))
        const events: Array<Record<string, unknown>> = []
        captureRoutingEvents(events)

        await applyAutoMemoryRouting({
            enabled: true,
            conversationId: 'conversation-ranked',
            userQuery: 'Find the relevant project',
            retrievalQueries: ['project details'],
            gateway: { complete: vi.fn().mockResolvedValue({}) } as unknown as LLMGateway,
        })

        const gathered = events.find((event) => {
            const call = (event.toolCalls as Array<{ arguments: string }> | undefined)?.[0]
            return call && JSON.parse(call.arguments).contextPhase === 'gathered-results'
        })
        const calls = gathered!.toolCalls as Array<{ name: string; arguments: string }>
        expect(calls.map(({ name }) => name)).toEqual(['best.md', 'medium.md'])
        expect(calls.map(({ arguments: args }) => JSON.parse(args).matchScore)).toEqual([0.8, 0.6])
        expect(calls.map(({ arguments: args }) => JSON.parse(args).scoreType)).toEqual(['reranker', 'reranker'])
        expect(memoryMocks.format).toHaveBeenLastCalledWith(expect.objectContaining({
            permanent: [expect.objectContaining({ id: 'best' }), expect.objectContaining({ id: 'medium' })],
        }))
    })

    test('skips AI curation and selects top-ranked evidence when reranking is enabled', async () => {
        rerankerConfigMock.enabled = true
        const candidate = (id: string, score: number) => ({
            id,
            text: `${id} excerpt`,
            source: 'memory',
            sourceFile: `${id}.md`,
            score,
            rerankerScore: score,
            scoreType: 'reranker' as const,
        })
        memoryMocks.aggregate.mockImplementation(async (_query: string, opts: { onStatus?: (stage: string, details?: { candidateCount?: number; resultCount?: number }) => void }) => {
            opts.onStatus?.('rag', { candidateCount: 12 })
            opts.onStatus?.('reranking', { candidateCount: 12 })
            opts.onStatus?.('reranking', { candidateCount: 12, resultCount: 2 })
            return {
                permanent: [candidate('first', .95), candidate('second', .82)],
                graph: undefined,
            }
        })
        memoryMocks.format.mockImplementation((memory: { permanent: Array<{ id: string }> }) => memory.permanent.map(({ id }) => id).join(','))
        const gateway = { complete: vi.fn() } as unknown as LLMGateway
        const events: Array<Record<string, unknown>> = []
        captureRoutingEvents(events)

        await expect(applyAutoMemoryRouting({
            enabled: true,
            conversationId: 'conversation-reranked',
            userQuery: 'find it',
            gateway,
        })).resolves.toBe('first,second')

        expect(gateway.complete).not.toHaveBeenCalled()
        const candidateCalls = events[0].toolCalls as Array<{ arguments: string }>
        expect(JSON.parse(candidateCalls[0].arguments).pipelineStats).toMatchObject({
            queryCount: 1,
            searchCandidateCount: 12,
            rerankerInputCount: 12,
            rerankerOutputCount: 2,
            returnedCount: 2,
            uniqueCount: 2,
            filteredCount: 2,
            duplicateCount: 0,
            weakCount: 0,
            relativeScoreThreshold: 0.65,
        })
        const finalCalls = events.at(-1)!.toolCalls as Array<{ arguments: string }>
        expect(finalCalls.map(({ arguments: value }) => JSON.parse(value).selectionMethod)).toEqual(['reranker', 'reranker'])
    })

    test('always searches the original request before complementary expansions', async () => {
        memoryMocks.aggregate.mockResolvedValue({ permanent: [], graph: undefined })

        await applyAutoMemoryRouting({
            enabled: true,
            conversationId: 'conversation-4',
            userQuery: 'Was weißt du über meine beste Freundin?',
            retrievalQueries: ['Informationen über enge persönliche Beziehungen'],
            gateway: {} as LLMGateway,
        })

        expect(memoryMocks.aggregate.mock.calls.map(([query]) => query)).toEqual([
            'Was weißt du über meine beste Freundin?',
            'Informationen über enge persönliche Beziehungen',
        ])
    })

    test('curates graph edges together with chunks instead of injecting the whole walk', async () => {
        const edge = (id: string, relation: string) => ({
            id,
            fromNodeId: `${id}-from`,
            toNodeId: `${id}-to`,
            fromName: id === 'best' ? 'Caroline' : 'Andi',
            toName: id === 'best' ? 'Andi' : 'Salzburg',
            relation,
            importance: 3,
            confidence: 0.95,
            evidence: `${relation} evidence`,
            sourceKind: 'memory',
            sourceId: `memory:persons:${id}.md`,
            mentionCount: 1,
            firstSeenAt: 1,
            lastSeenAt: 1,
        })
        memoryMocks.aggregate.mockResolvedValue({
            permanent: [],
            graph: { seedNodes: [], nodes: [], edges: [edge('best', 'best_friend_of'), edge('city', 'lives_in')] },
        })
        memoryMocks.format.mockImplementation((memory: { graph?: { edges: Array<{ id: string }> } }) => (
            memory.graph?.edges.map(({ id }) => id).join(',') || ''
        ))
        const gateway = {
            complete: vi.fn().mockResolvedValue({
                toolCalls: [{ function: {
                    name: 'select_memory_context',
                    arguments: JSON.stringify({ memoryIds: [], graphEdgeIds: ['g1'], answerable: true }),
                } }],
            }),
        } as unknown as LLMGateway

        await expect(applyAutoMemoryRouting({
            enabled: true,
            conversationId: 'conversation-5',
            userQuery: 'Who is explicitly the best friend?',
            gateway,
        })).resolves.toBe('best')
    })

    test('runs one corrective retrieval when candidates do not directly answer the request', async () => {
        const chunk = (id: string, text: string) => ({
            id,
            text,
            source: 'memory',
            sourceFile: `${id}.md`,
            chunkIndex: 0,
            score: 0.8,
            denseScore: 0.8,
            scoreType: 'dense' as const,
        })
        memoryMocks.aggregate.mockImplementation(async (query: string) => ({
            permanent: query.includes('Caroline')
                ? [chunk('caroline', 'Caroline is explicitly Andi’s best friend.')]
                : [chunk('sandra', 'Sandra is a close friend of Andi.')],
            graph: undefined,
        }))
        memoryMocks.format.mockImplementation((memory: { permanent: Array<{ id: string }> }) => (
            memory.permanent.map(({ id }) => id).join(',')
        ))
        const gateway = {
            complete: vi.fn()
                .mockResolvedValueOnce({ toolCalls: [{ function: {
                    name: 'select_memory_context',
                    arguments: JSON.stringify({
                        memoryIds: [], graphEdgeIds: [], answerable: false,
                        correctiveQuery: 'Caroline beste Freundin BFF',
                    }),
                } }] })
                .mockResolvedValueOnce({ toolCalls: [{ function: {
                    name: 'select_memory_context',
                    arguments: JSON.stringify({ memoryIds: ['m2'], graphEdgeIds: [], answerable: true }),
                } }] }),
        } as unknown as LLMGateway

        await expect(applyAutoMemoryRouting({
            enabled: true,
            conversationId: 'conversation-6',
            userQuery: 'Wer ist ausdrücklich die beste Freundin?',
            gateway,
        })).resolves.toBe('caroline')
        expect(memoryMocks.aggregate).toHaveBeenCalledTimes(2)
    })
})
