import { describe, expect, test, vi } from 'vitest'
import { getEventBus } from '../../telemetry/event-bus.js'
import { emitRoutingDecision, parseCandidateIds, recentConversationBlock, routerQuery, runRoutingPhase } from './routing-kernel.js'

describe('routing kernel', () => {
    test('formats only recent user and assistant text with consistent limits', () => {
        const messages = [
            { role: 'system' as const, content: 'hidden' },
            { role: 'user' as const, content: [{ type: 'text' as const, text: 'longer request' },
                { type: 'image_url' as const, image_url: { url: 'image' } }] },
            { role: 'tool' as const, content: 'tool result' },
            { role: 'assistant' as const, content: [{ type: 'image_url' as const, image_url: { url: 'image' } }] },
        ]
        expect(recentConversationBlock(messages, 6)).toBe('Recent conversation:\nuser: longer\nassistant: [multi')
        expect(routerQuery({ query: 'next', recentMessages: messages }, 6))
            .toBe('Recent conversation:\nuser: longer\nassistant: [multi\n\nCurrent request: next')
    })

    test('distinguishes valid empty selections from unknown candidate IDs', () => {
        expect(parseCandidateIds([], ['a', 'b'], 2)).toEqual([])
        expect(parseCandidateIds(['b', 'b', 'a'], ['a', 'b'], 1)).toEqual(['b'])
        expect(parseCandidateIds(['missing'], ['a', 'b'], 2)).toBeNull()
        expect(parseCandidateIds('a', ['a', 'b'], 2)).toBeNull()
    })

    test('uses fallback for routing errors but preserves cancellation', async () => {
        const fallback = vi.fn(() => 'fallback')
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        try {
            await expect(runRoutingPhase({ label: 'test', run: async () => { throw new Error('failure') }, fallback }))
                .resolves.toBe('fallback')
            const controller = new AbortController()
            controller.abort()
            await expect(runRoutingPhase({ label: 'test', signal: controller.signal,
                run: async () => 'unreachable', fallback })).rejects.toMatchObject({ name: 'AbortError' })
            expect(fallback).toHaveBeenCalledOnce()
        } finally {
            warn.mockRestore()
        }
    })

    test('emits one typed diagnostic with an explicit empty selection', () => {
        const drafts: unknown[] = []
        const remove = getEventBus().on('chat:event', (draft) => drafts.push(draft))
        try {
            emitRoutingDecision({ conversationId: 'conversation', taskId: 'router', phase: 'tools',
                entries: [], empty: { name: 'No tools found', details: { emptyReason: 'none-found' } } })
            expect(drafts).toEqual([{
                conversationId: 'conversation', executionId: 'router',
                payload: expect.objectContaining({ type: 'routing-decision', taskId: 'router',
                    phase: 'tools', entries: [{ name: 'No tools found', details: { emptyReason: 'none-found' } }] }),
            }])
        } finally {
            remove()
        }
    })
})
