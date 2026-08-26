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
    MCP_CANDIDATE_COUNT: 8,
    MAX_AUTO_DISCOVERED_TOOLS: 6,
    shouldRouteTools: routerMocks.shouldRoute,
    routeTools: routerMocks.route,
    routeToolsLexically: routerMocks.lexical,
}))

import { applyAutoToolRouting, filterToolsForRequestedEffect } from './auto-tool-routing.js'

function tool(name: string): RegistryAwareToolDefinition {
    return {
        name,
        description: `${name} description`,
        parameters: { type: 'object' },
        timeout: 1_000,
        execute: async () => ({ success: true, output: 'ok' }),
    } as RegistryAwareToolDefinition
}

function namespacedTool(name: string, namespaceId: string, namespaceLabel: string): RegistryAwareToolDefinition {
    return {
        ...tool(name),
        namespaceId,
        namespaceLabel,
        namespaceDescription: `${namespaceLabel} capabilities`,
    }
}

function annotatedTool(name: string, readOnly: boolean, destructive = false): RegistryAwareToolDefinition {
    return {
        ...tool(name),
        execution: { readOnly },
        annotations: { readOnlyHint: readOnly, destructiveHint: destructive },
    }
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

    test('asks the model to select toolsets before filtering tools and retains protected tools', async () => {
        const preferred = namespacedTool('preferred', 'mcp:pinned', 'Pinned MCP')
        const used = namespacedTool('used', 'mcp:recent', 'Recent MCP')
        const optionalA = namespacedTool('optional_a', 'mcp:weather', 'Weather MCP')
        const optionalB = namespacedTool('optional_b', 'mcp:github', 'GitHub MCP')
        routerMocks.route.mockImplementation(async ({ allTools }) => allTools)
        const gateway = {
            complete: vi.fn().mockResolvedValue({
                toolCalls: [{
                    function: { name: 'select_toolsets', arguments: JSON.stringify({ namespaceIds: ['mcp:github'] }) },
                }],
            }),
        } as unknown as LLMGateway
        const selectionEvents: Array<Record<string, unknown>> = []
        getEventBus().on('step:tools-chosen', (event) => selectionEvents.push(event as Record<string, unknown>))

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
        expect(routerMocks.route).toHaveBeenCalledWith(expect.objectContaining({
            allTools: [preferred, used, optionalB],
        }))
        expect(gateway.complete).toHaveBeenCalledWith(
            expect.objectContaining({
                thinkingEnabled: false,
                toolChoice: { type: 'function', name: 'select_toolsets' },
            }),
            undefined,
        )
        expect(selectionEvents[0]?.toolCalls).toEqual([{
            name: 'GitHub MCP',
            arguments: JSON.stringify({ type: 'toolset-router', namespaceId: 'mcp:github' }),
        }])
    })

    test('treats an explicit empty toolset selection as no relevant tools', async () => {
        routerMocks.route.mockResolvedValue([])
        const gateway = {
            complete: vi.fn().mockResolvedValue({ toolCalls: [{
                function: { name: 'select_toolsets', arguments: '{"namespaceIds":[]}' },
            }] }),
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
        expect(routerMocks.route).toHaveBeenCalledWith(expect.objectContaining({ allTools: [] }))
        expect(events.at(-1)?.toolCalls).toEqual([expect.objectContaining({ name: 'No tools found' })])
    })

    test('falls back to lexical routing when AI toolset selection fails', async () => {
        const fallback = [tool('fallback')]
        routerMocks.lexical.mockReturnValue(fallback)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        await expect(applyAutoToolRouting({
            enabled: true,
            conversationId: 'conversation',
            userQuery: 'find it',
            gateway: { complete: vi.fn().mockRejectedValue(new Error('router unavailable')) } as unknown as LLMGateway,
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

    test('hard-gates mutating and destructive tools for read-only requests', () => {
        const tools = [
            annotatedTool('memory_search', true),
            annotatedTool('memory_create', false),
            annotatedTool('memory_delete', false, true),
        ]

        expect(filterToolsForRequestedEffect(tools, 'read').map(({ name }) => name)).toEqual(['memory_search'])
        expect(filterToolsForRequestedEffect(tools, 'write').map(({ name }) => name)).toEqual(['memory_search', 'memory_create'])
        expect(filterToolsForRequestedEffect(tools, 'destructive')).toEqual(tools)
    })
})
