import { DEFAULT_MEMORY_RETRIEVAL_OPTIONS } from '../../memory/retrieval-options.js'
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
const rerankerConfigMock = vi.hoisted(() => ({ enabled: false, curationProviderId: undefined as string | undefined, curationModel: '' }))

vi.mock('../../memory/memory-aggregator.js', () => ({
    getMemoryAggregator: () => memoryMocks,
}))
vi.mock('../../memory/reranker.js', () => ({
    getMemoryReranker: () => ({ getConfig: () => ({ ...rerankerConfigMock }) }),
}))

import { applyAutoMemoryRouting } from './auto-memory-routing.js'
import { OpenRouterProvider } from '../../gateway/providers/openrouter.provider.js'

describe('automatic memory routing visibility', () => {
    afterEach(() => {
        getEventBus().removeAllListeners()
        vi.clearAllMocks()
        rerankerConfigMock.enabled = false
        rerankerConfigMock.curationProviderId = undefined
        rerankerConfigMock.curationModel = ''
    })

    const curationCandidate = (id: string) => ({
        id,
        text: `${id} content`,
        source: 'memory',
        sourceFile: `${id}.md`,
        score: 0.02,
        denseScore: 0.8,
        scoreType: 'fusion' as const,
    })

    test('curates with the configured curation model instead of the conversation model', async () => {
        rerankerConfigMock.curationProviderId = 'curation-provider'
        rerankerConfigMock.curationModel = 'curation-model'
        memoryMocks.aggregate.mockResolvedValue({ permanent: [curationCandidate('a')] })
        memoryMocks.format.mockReturnValue('formatted memory')
        const complete = vi.fn().mockResolvedValue({
            toolCalls: [{ function: { name: 'select_memory_context', arguments: JSON.stringify({ memoryIds: ['m1'], answerable: true }) } }],
        })
        const gateway = {
            complete,
            getProvider: (id: string) => id === 'curation-provider' ? { config: { type: 'openai' } } : undefined,
        } as unknown as LLMGateway

        await applyAutoMemoryRouting({
            enabled: true,
            conversationId: 'conversation-curation',
            userQuery: 'How do we deploy?',
            gateway,
            providerId: 'chat-provider',
            model: 'chat-model',
        })

        expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'curation-model' }), 'curation-provider')
    })

    test('curates with an OpenRouter decision model through one yes/no question per candidate', async () => {
        const decide = vi.fn().mockResolvedValue({
            answers: { m1: { type: 'noul', noul: 0.2 }, m2: { type: 'noul', noul: 0.9 } },
            usage: { input_tokens: 100, output_tokens: 4 },
        })
        const provider = Object.assign(Object.create(OpenRouterProvider.prototype), {
            config: { type: 'openrouter' },
            isDecisionModel: vi.fn().mockResolvedValue(true),
            decide,
        })
        rerankerConfigMock.curationProviderId = 'openrouter'
        rerankerConfigMock.curationModel = 'typesafe/jev-1.13'
        memoryMocks.aggregate.mockResolvedValue({ permanent: [curationCandidate('weak'), curationCandidate('strong')] })
        memoryMocks.format.mockImplementation((memory: { permanent: Array<{ id: string }> }) => memory.permanent.map(({ id }) => id).join(','))
        const complete = vi.fn()
        const gateway = { complete, getProvider: () => provider } as unknown as LLMGateway

        const result = await applyAutoMemoryRouting({
            enabled: true,
            conversationId: 'conversation-decision',
            userQuery: 'How do we deploy?',
            gateway,
        })

        expect(complete).not.toHaveBeenCalled()
        expect(decide).toHaveBeenCalledWith(expect.objectContaining({
            model: 'typesafe/jev-1.13',
            questions: { m1: expect.objectContaining({ type: 'noul' }), m2: expect.objectContaining({ type: 'noul' }) },
        }), undefined)
        expect(result).toBe('strong')
    })

    test('uses the default result count for each retrieval query', async () => {
        memoryMocks.aggregate.mockResolvedValue({ permanent: [] })

        await applyAutoMemoryRouting({
            enabled: true,
            conversationId: 'conversation-2',
            userQuery: 'Find the deployment notes',
            gateway: {} as LLMGateway,
        })

        // Each query contributes enough candidates to fill the curation pool.
        expect(memoryMocks.aggregate).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ permanentTopK: Math.max(10, DEFAULT_MEMORY_RETRIEVAL_OPTIONS.curationPool - 2) }),
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
        memoryMocks.aggregate.mockResolvedValue({ permanent: [candidate] })
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
            })
            .mockResolvedValueOnce({
                permanent: [candidate('best', 0.8, 0.3), candidate('medium', 0.55, 0.95)],
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

    test('passes lexical-only matches to curation instead of dropping them for lacking a similarity score', async () => {
        const dense = { id: 'dense', text: 'Generic deployment notes.', source: 'memory', sourceFile: 'a.md', chunkIndex: 0, score: 0.0164, denseScore: 0.48, scoreType: 'fusion' as const }
        const exactId = { id: 'exact', text: 'Ticket CYN-4821 was fixed by Alex.', source: 'memory', sourceFile: 'b.md', chunkIndex: 0, score: 0.0164, lexicalScore: 9.2, scoreType: 'fusion' as const }
        memoryMocks.aggregate.mockResolvedValue({ permanent: [dense, exactId] })
        const complete = vi.fn().mockResolvedValue({ toolCalls: [{ function: {
            name: 'select_memory_context',
            arguments: JSON.stringify({ memoryIds: ['m2'], answerable: true }),
        } }] })

        await applyAutoMemoryRouting({
            enabled: true,
            conversationId: 'conversation-lexical',
            userQuery: 'Who fixed CYN-4821?',
            gateway: { complete } as unknown as LLMGateway,
        })

        const prompt = String(complete.mock.calls[0][0].messages[1].content)
        expect(prompt).toContain('- m2 (source=b.md, part=1):\nTicket CYN-4821 was fixed by Alex.')
        expect(prompt).not.toContain('score=')
    })

    test('ranks chunks found by several queries above single-query matches', async () => {
        const chunk = (id: string, denseScore: number) => ({ id, text: id, source: 'memory', sourceFile: `${id}.md`, chunkIndex: 0, score: 0.01, denseScore, scoreType: 'fusion' as const })
        memoryMocks.aggregate
            .mockResolvedValueOnce({ permanent: [chunk('only-first', 0.9), chunk('shared', 0.5)] })
            .mockResolvedValueOnce({ permanent: [chunk('shared', 0.5), chunk('only-second', 0.8)] })
        const complete = vi.fn().mockResolvedValue({ toolCalls: [{ function: {
            name: 'select_memory_context',
            arguments: JSON.stringify({ memoryIds: [], answerable: true }),
        } }] })

        await applyAutoMemoryRouting({
            enabled: true,
            conversationId: 'conversation-rank-fusion',
            userQuery: 'deployment',
            retrievalQueries: ['deployment', 'release process'],
            gateway: { complete } as unknown as LLMGateway,
        })

        const prompt = String(complete.mock.calls[0][0].messages[1].content)
        const order = ['shared', 'only-first', 'only-second'].map((id) => prompt.indexOf(`source=${id}.md`))
        expect(order).toEqual([...order].sort((a, b) => a - b))
    })

    test('always searches the original request before complementary expansions', async () => {
        memoryMocks.aggregate.mockResolvedValue({ permanent: [] })

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
        }))
        memoryMocks.format.mockImplementation((memory: { permanent: Array<{ id: string }> }) => (
            memory.permanent.map(({ id }) => id).join(',')
        ))
        const gateway = {
            complete: vi.fn()
                .mockResolvedValueOnce({ toolCalls: [{ function: {
                    name: 'select_memory_context',
                    arguments: JSON.stringify({
                        memoryIds: [], answerable: false,
                        correctiveQuery: 'Caroline beste Freundin BFF',
                    }),
                } }] })
                .mockResolvedValueOnce({ toolCalls: [{ function: {
                    name: 'select_memory_context',
                    arguments: JSON.stringify({ memoryIds: ['m2'], answerable: true }),
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
