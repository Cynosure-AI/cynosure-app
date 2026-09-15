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

    test('routes memory lookups by model intent instead of fixed-language keywords', async () => {
        const complete = vi.fn().mockResolvedValue({ toolCalls: [{ function: {
            name: 'set_task_context',
            arguments: JSON.stringify({
                toolQuery: 'No external capability needed',
                requestedToolEffect: 'read',
                requiresExternalTools: false,
                memoryQueries: ['information about a close friend'],
                requiresMemory: true,
            }),
        } }] })
        const gateway = { complete } as unknown as LLMGateway

        await expect(buildTaskContext({
            conversationId: 'conversation',
            gateway,
            userQuery: 'Do you remember my best friend?',
            enabledModes: { tools: true, memories: true },
        })).resolves.toMatchObject({
            memoryQueries: ['information about a close friend'],
            requestedToolEffect: 'read',
            skipToolRouting: true,
            skipMemoryRouting: false,
        })
        expect(complete).toHaveBeenCalledOnce()
    })

    test('drops redundant memory expansions before applying the query budget', async () => {
        const complete = vi.fn().mockResolvedValue({ toolCalls: [{ function: {
            name: 'set_task_context',
            arguments: JSON.stringify({
                memoryQueries: ['project details', 'specific preference', 'related decision'],
                requiresMemory: true,
            }),
        } }] })
        const result = await buildTaskContext({
            conversationId: 'conversation', gateway: { complete } as unknown as LLMGateway,
            userQuery: 'project details', enabledModes: { tools: false, memories: true },
        })
        expect(result?.memoryQueries).toEqual(['specific preference', 'related decision'])
    })

    test('can independently skip both automatic tools and automatic memory', async () => {
        const complete = vi.fn().mockResolvedValue({ toolCalls: [{ function: {
            name: 'set_task_context',
            arguments: JSON.stringify({
                toolQuery: 'No external capability needed',
                requestedToolEffect: 'read',
                requiresExternalTools: false,
                memoryQueries: [],
                requiresMemory: false,
            }),
        } }] })
        const result = await buildTaskContext({
            conversationId: 'conversation', gateway: { complete } as unknown as LLMGateway,
            userQuery: 'Explain recursion', enabledModes: { tools: true, memories: true },
        })

        expect(result).toMatchObject({
            skipToolRouting: true,
            skipMemoryRouting: true,
        })
    })

    test('uses the model side-effect classification without lexical overrides', async () => {
        const complete = vi.fn().mockResolvedValue({ toolCalls: [{ function: {
            name: 'set_task_context',
            arguments: JSON.stringify({
                toolQuery: 'send a message',
                requestedToolEffect: 'write',
                requiresExternalTools: true,
            }),
        } }] })
        const result = await buildTaskContext({
            conversationId: 'conversation', gateway: { complete } as unknown as LLMGateway,
            userQuery: 'Envía el mensaje', enabledModes: { tools: true, memories: false },
        })

        expect(result?.requestedToolEffect).toBe('write')
    })
})
