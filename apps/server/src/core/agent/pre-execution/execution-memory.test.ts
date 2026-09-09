import { afterEach, describe, expect, test, vi } from 'vitest'
import type { LLMGateway } from '../../gateway/gateway.js'

const routingMocks = vi.hoisted(() => ({
    apply: vi.fn(),
    applyWithEvidence: vi.fn(),
    skipped: vi.fn(),
}))

vi.mock('./auto-memory-routing.js', () => ({
    applyAutoMemoryRouting: routingMocks.apply,
    applyAutoMemoryRoutingWithEvidence: routingMocks.applyWithEvidence,
    emitAutoMemoryRoutingSkipped: routingMocks.skipped,
}))

import { resolveMemoryContext, resolveMemorySystemMessages } from './execution-memory.js'

describe('retrieved memory context messages', () => {
    afterEach(() => {
        vi.clearAllMocks()
    })

    test('presents memory as reference material without exposing internal trust terminology', async () => {
        routingMocks.applyWithEvidence.mockResolvedValue({
            content: '## Relevant Knowledge\n- Remembered deployment detail.',
            evidence: [],
        })

        const messages = await resolveMemorySystemMessages({
            preset: {
                id: 'agent-1',
                tools: [],
                subAgents: [],
                autoMemory: true,
            },
            conversationId: 'conversation-1',
            userQuery: 'How should I deploy?',
            retrievalQueries: ['How should I deploy?', 'deployment procedure'],
            gateway: {} as LLMGateway,
        })

        expect(messages).toHaveLength(1)
        expect(messages[0].role).toBe('user')
        expect(messages[0].content).toContain('[Retrieved memory context]')
        expect(messages[0].content).toContain('quoted source material')
        expect(messages[0].content).toContain('Remembered deployment detail.')
        expect(messages[0].content).not.toContain('untrusted')
        expect(messages[0].metadata).toEqual({ contextKind: 'retrieved-memory', untrusted: true })
        expect(routingMocks.applyWithEvidence).toHaveBeenCalledWith(expect.objectContaining({
            userQuery: 'How should I deploy?',
            retrievalQueries: ['How should I deploy?', 'deployment procedure'],
        }))
    })

    test('skips enabled auto-memory when task-context planning says it is not required', async () => {
        const result = await resolveMemoryContext({
            preset: {
                id: 'agent-1',
                tools: [],
                subAgents: [],
                autoMemory: true,
            },
            conversationId: 'conversation-1',
            userQuery: 'Explain recursion',
            gateway: {} as LLMGateway,
            suppressAutoMemory: true,
        })

        expect(result).toEqual({ messages: [], evidence: [] })
        expect(routingMocks.applyWithEvidence).not.toHaveBeenCalled()
        expect(routingMocks.skipped).toHaveBeenCalledWith('conversation-1', 'not-required', undefined)
    })
})
