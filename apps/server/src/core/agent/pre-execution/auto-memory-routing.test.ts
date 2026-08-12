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
        const graphContext = '## Entity Graph Context\n- [core] Cynosure -> uses -> entity memory.'
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
            name: 'Entity Graph Context',
            arguments: JSON.stringify({
                type: 'memory',
                memoryKind: 'entity-graph',
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
})
