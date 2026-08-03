import { describe, expect, test, vi } from 'vitest'
import type { LLMGateway } from '../../gateway/gateway.js'
import { buildTaskContext } from './task-context.js'

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
})
