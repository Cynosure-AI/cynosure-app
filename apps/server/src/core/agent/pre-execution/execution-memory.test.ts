import { afterEach, describe, expect, test, vi } from 'vitest'
import type { LLMGateway } from '../../gateway/gateway.js'

const routingMocks = vi.hoisted(() => ({
    apply: vi.fn(),
    skipped: vi.fn(),
}))

vi.mock('./auto-memory-routing.js', () => ({
    applyAutoMemoryRouting: routingMocks.apply,
    emitAutoMemoryRoutingSkipped: routingMocks.skipped,
}))

import { resolveMemorySystemMessages } from './execution-memory.js'

describe('retrieved memory context messages', () => {
    afterEach(() => {
        vi.clearAllMocks()
    })

    test('presents memory as reference material without exposing internal trust terminology', async () => {
        routingMocks.apply.mockResolvedValue('## Relevant Knowledge\n- Remembered deployment detail.')

        const messages = await resolveMemorySystemMessages({
            preset: {
                id: 'agent-1',
                tools: [],
                subAgents: [],
                autoMemory: true,
            },
            conversationId: 'conversation-1',
            userQuery: 'How should I deploy?',
            gateway: {} as LLMGateway,
        })

        expect(messages).toHaveLength(1)
        expect(messages[0].role).toBe('user')
        expect(messages[0].content).toContain('[Retrieved memory context]')
        expect(messages[0].content).toContain('quoted source material')
        expect(messages[0].content).toContain('Remembered deployment detail.')
        expect(messages[0].content).not.toContain('untrusted')
        expect(messages[0].metadata).toEqual({ contextKind: 'retrieved-memory', untrusted: true })
    })
})
