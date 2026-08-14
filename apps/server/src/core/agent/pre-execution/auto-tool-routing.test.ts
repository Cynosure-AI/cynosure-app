import { afterEach, describe, expect, test, vi } from 'vitest'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { RegistryAwareToolDefinition } from '../../gateway/providers/base.provider.js'
import { getEventBus } from '../../telemetry/event-bus.js'

const routerMocks = vi.hoisted(() => ({
    shouldRoute: vi.fn(() => true),
    route: vi.fn(),
    lexical: vi.fn(),
}))

vi.mock('../tool-router.js', () => ({
    MAX_AUTO_DISCOVERED_TOOLS: 6,
    shouldRouteTools: routerMocks.shouldRoute,
    routeTools: routerMocks.route,
    routeToolsLexically: routerMocks.lexical,
}))

import { applyAutoToolRouting } from './auto-tool-routing.js'

function tool(name: string): RegistryAwareToolDefinition {
    return {
        name,
        description: `${name} description`,
        parameters: { type: 'object' },
        timeout: 1_000,
        execute: async () => ({ success: true, output: 'ok' }),
    } as RegistryAwareToolDefinition
}

describe('automatic tool routing', () => {
    afterEach(() => {
        getEventBus().removeAllListeners()
        vi.clearAllMocks()
        routerMocks.shouldRoute.mockReturnValue(true)
    })

    test('returns tools unchanged when routing is not applicable', async () => {
        routerMocks.shouldRoute.mockReturnValue(false)
        const tools = [tool('read_file')]
        const gateway = { complete: vi.fn() } as unknown as LLMGateway

        await expect(applyAutoToolRouting({
            enabled: false,
            conversationId: 'conversation',
            userQuery: 'read it',
            gateway,
            tools,
        })).resolves.toBe(tools)
        expect(routerMocks.route).not.toHaveBeenCalled()
        expect(gateway.complete).not.toHaveBeenCalled()
    })

    test('curates routed candidates while retaining explicitly selected and recently used tools', async () => {
        const preferred = tool('preferred')
        const used = tool('used')
        const optionalA = tool('optional_a')
        const optionalB = tool('optional_b')
        routerMocks.route.mockResolvedValue([preferred, used, optionalA, optionalB])
        const gateway = {
            complete: vi.fn().mockResolvedValue({
                toolCalls: [{
                    function: { name: 'select_tool_context', arguments: JSON.stringify({ toolIds: ['t2'] }) },
                }],
            }),
        } as unknown as LLMGateway

        const result = await applyAutoToolRouting({
            enabled: true,
            conversationId: 'conversation',
            userQuery: 'do useful work',
            recentMessages: [{
                role: 'assistant', content: 'continuing',
                toolCalls: [{ id: 'call', type: 'function', function: { name: 'used', arguments: '{}' } }],
            }],
            gateway,
            tools: [preferred, used, optionalA, optionalB],
            preferredToolNames: new Set(['preferred']),
        })

        expect(result.map(({ name }) => name)).toEqual(['preferred', 'used', 'optional_b'])
        expect(gateway.complete).toHaveBeenCalledWith(
            expect.objectContaining({
                thinkingEnabled: false,
                toolChoice: { type: 'function', name: 'select_tool_context' },
            }),
            undefined,
        )
    })

    test('treats an explicit empty curation selection as no relevant tools', async () => {
        routerMocks.route.mockResolvedValue([tool('optional')])
        const gateway = {
            complete: vi.fn().mockResolvedValue({
                toolCalls: [{ function: { name: 'select_tool_context', arguments: '{"toolIds":[]}' } }],
            }),
        } as unknown as LLMGateway
        const events: Array<Record<string, unknown>> = []
        getEventBus().on('step:tools-chosen', (event) => events.push(event as Record<string, unknown>))

        await expect(applyAutoToolRouting({
            enabled: true,
            conversationId: 'conversation',
            userQuery: 'unrelated request',
            gateway,
            tools: [tool('optional')],
        })).resolves.toEqual([])
        expect(events.at(-1)?.toolCalls).toEqual([expect.objectContaining({ name: 'No tools selected' })])
    })

    test('falls back to lexical routing when semantic routing fails', async () => {
        const fallback = [tool('fallback')]
        routerMocks.route.mockRejectedValue(new Error('embedding unavailable'))
        routerMocks.lexical.mockReturnValue(fallback)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        await expect(applyAutoToolRouting({
            enabled: true,
            conversationId: 'conversation',
            userQuery: 'find it',
            gateway: {} as LLMGateway,
            tools: fallback,
        })).resolves.toBe(fallback)
        expect(routerMocks.lexical).toHaveBeenCalled()
        warn.mockRestore()
    })

    test('propagates cancellation without attempting a fallback', async () => {
        const controller = new AbortController()
        controller.abort()

        await expect(applyAutoToolRouting({
            enabled: true,
            conversationId: 'conversation',
            userQuery: 'find it',
            gateway: {} as LLMGateway,
            tools: [tool('search')],
            signal: controller.signal,
        })).rejects.toMatchObject({ name: 'AbortError' })
        expect(routerMocks.lexical).not.toHaveBeenCalled()
    })
})
