import { afterEach, describe, expect, test, vi } from 'vitest'
import type { LLMGateway } from '../../gateway/gateway.js'
import { getEventBus } from '../../telemetry/event-bus.js'

const memoryMocks = vi.hoisted(() => ({
    aggregate: vi.fn(),
    format: vi.fn(),
}))
const retrievalConfigMock = vi.hoisted(() => ({ resultCount: 10 }))

vi.mock('../../memory/memory-aggregator.js', () => ({
    getMemoryAggregator: () => memoryMocks,
}))
vi.mock('../../memory/retrieval-config.js', () => ({
    getMemoryRetrievalConfig: () => ({ resultCount: retrievalConfigMock.resultCount }),
}))

import { applyAutoMemoryRouting } from './auto-memory-routing.js'

describe('automatic memory routing visibility', () => {
    afterEach(() => {
        getEventBus().removeAllListeners()
        vi.clearAllMocks()
        retrievalConfigMock.resultCount = 10
    })

    test('emits graph-only evidence as gathered context', async () => {
        const graphContext = '## Knowledge Context\n- [core] Cynosure -> uses -> entity memory.'
        memoryMocks.aggregate.mockResolvedValue({
            permanent: [],
            graph: { seedNodes: [], nodes: [], edges: [{ id: 'edge-1' }] },
        })
        memoryMocks.format.mockReturnValue(graphContext)

        const events: Array<Record<string, unknown>> = []
        getEventBus().on('step:tools-chosen', (event) => events.push(event as Record<string, unknown>))

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

    test('uses the configured result count for each retrieval query', async () => {
        retrievalConfigMock.resultCount = 18
        memoryMocks.aggregate.mockResolvedValue({ permanent: [], graph: undefined })

        await applyAutoMemoryRouting({
            enabled: true,
            conversationId: 'conversation-2',
            userQuery: 'Find the deployment notes',
            gateway: {} as LLMGateway,
        })

        expect(memoryMocks.aggregate).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ permanentTopK: 18 }),
        )
    })

    test('emits semantic similarity instead of the small RRF ranking score', async () => {
        const candidate = {
            id: 'memory-1',
            text: 'Deployment uses the blue environment.',
            source: 'memory',
            sourceFile: 'deployment.md',
            spaceName: 'Default',
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
        getEventBus().on('step:tools-chosen', (event) => events.push(event as Record<string, unknown>))

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
