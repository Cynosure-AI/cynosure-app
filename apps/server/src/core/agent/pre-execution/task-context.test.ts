import { describe, expect, test, vi } from 'vitest'
import type { LLMGateway } from '../../gateway/gateway.js'
import { buildTaskContext, inferRequestedToolEffect } from './task-context.js'

describe('task context cancellation', () => {
    test('passes the execution signal to the router request and preserves aborts', async () => {
        const controller = new AbortController()
        const aborted = new DOMException('Cancelled', 'AbortError')
        const complete = vi.fn().mockRejectedValue(aborted)
        const gateway = { complete } as unknown as LLMGateway

        await expect(buildTaskContext({
            conversationId: 'conversation',
            gateway,
            providerId: 'provider',
            model: 'model',
            userQuery: 'Do the work',
            enabledModes: { tools: true, memories: false },
            signal: controller.signal,
        })).rejects.toBe(aborted)

        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({ signal: controller.signal }),
            'provider',
        )
    })

    test('uses a deterministic read-only fast path for clear personal memory lookups', async () => {
        const gateway = { complete: vi.fn() } as unknown as LLMGateway

        await expect(buildTaskContext({
            conversationId: 'conversation',
            gateway,
            userQuery: 'Was weißt du über meine beste Freundin?',
            enabledModes: { tools: true, memories: true },
        })).resolves.toMatchObject({
            memoryQueries: [],
            requestedToolEffect: 'read',
            skipToolRouting: true,
            fastPath: true,
        })
        expect(gateway.complete).not.toHaveBeenCalled()
    })

    test('classifies explicit mutations conservatively', () => {
        expect(inferRequestedToolEffect('Please send the email')).toBe('write')
        expect(inferRequestedToolEffect('Lösche diesen Eintrag')).toBe('destructive')
        expect(inferRequestedToolEffect('Read the latest email')).toBe('read')
    })
})
