import { afterEach, describe, expect, test, vi } from 'vitest'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { RegistryAwareToolDefinition } from '../../gateway/providers/base.provider.js'
import { getEventBus } from '../../telemetry/event-bus.js'

function captureRoutingEvents(events: Array<Record<string, unknown>>): void {
    getEventBus().on('chat:event', (draft) => {
        const payload = (draft as { payload?: { type?: string; entries?: Array<{ name: string; details: Record<string, unknown> }> } }).payload
        if (payload?.type === 'routing-decision') events.push({
            toolCalls: payload.entries?.map((entry) => ({ name: entry.name, arguments: JSON.stringify(entry.details) })),
        })
    })
}

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

import { applyAutoToolRouting, collectAutoIncludedToolNames } from './auto-tool-routing.js'

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
        captureRoutingEvents(selectionEvents)

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

        expect(result.map(({ name }) => name)).toEqual(['preferred', 'used', 'optional_b', 'expand_available_toolset'])
        expect(routerMocks.route).not.toHaveBeenCalled()
        expect(gateway.complete).toHaveBeenCalledWith(
            expect.objectContaining({
                thinkingEnabled: false,
                toolChoice: { type: 'function', name: 'select_toolsets' },
            }),
            undefined,
        )
        expect(selectionEvents[0]?.toolCalls).toEqual([{
            name: 'GitHub MCP',
            arguments: JSON.stringify({ type: 'toolset-router', namespaceId: 'mcp:github', selectionMethod: 'llm' }),
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
        captureRoutingEvents(events)

        await expect(applyAutoToolRouting({
            enabled: true,
            conversationId: 'conversation',
            userQuery: 'unrelated request',
            gateway,
            tools: [tool('optional')],
        })).resolves.toEqual([expect.objectContaining({ name: 'expand_available_toolset' })])
        expect(routerMocks.route).not.toHaveBeenCalled()
        expect(events[0]?.toolCalls).toEqual([{
            name: 'No toolsets selected',
            arguments: JSON.stringify({
                type: 'toolset-router',
                selectionMethod: 'llm',
                emptyReason: 'none-relevant',
                content: 'AI toolset selection ran, but no MCPs or toolsets were relevant for this turn.',
            }),
        }])
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

    test('keeps read, write, and destructive tools in the discovery catalog', async () => {
        const tools = [
            { ...namespacedTool('search_messages', 'mcp:mail', 'Mail'), execution: { readOnly: true }, annotations: { readOnlyHint: true, destructiveHint: false } },
            { ...namespacedTool('send_message', 'mcp:mail', 'Mail'), execution: { readOnly: false }, annotations: { readOnlyHint: false, destructiveHint: false } },
            { ...namespacedTool('delete_message', 'mcp:mail', 'Mail'), execution: { readOnly: false }, annotations: { readOnlyHint: false, destructiveHint: true } },
        ]
        routerMocks.route.mockResolvedValue([])
        const gateway = {
            complete: vi.fn().mockResolvedValue({ toolCalls: [{
                function: { name: 'select_toolsets', arguments: '{"namespaceIds":[]}' },
            }] }),
        } as unknown as LLMGateway

        await applyAutoToolRouting({
            enabled: true,
            conversationId: 'conversation',
            userQuery: 'find a capability',
            gateway,
            tools,
        })

        expect(routerMocks.route).not.toHaveBeenCalled()
    })

    test('automatically includes complete small toolsets based on count alone', () => {
        const small = Array.from({ length: 9 }, (_, index) => namespacedTool(`small_${index}`, 'mcp:small', 'Small MCP'))
        const large = Array.from({ length: 10 }, (_, index) => namespacedTool(`large_${index}`, 'mcp:large', 'Large MCP'))
        small[0].description = 'Large schema '.repeat(3_000)

        expect([...collectAutoIncludedToolNames(
            [...small, ...large],
            new Set(['mcp:small', 'mcp:large']),
        )]).toEqual(small.map(({ name }) => name))
    })

    test('includes a small selected toolset without semantic ranking', async () => {
        const tools = [
            namespacedTool('browser_snapshot', 'mcp:browser', 'Browser MCP'),
            namespacedTool('browser_find', 'mcp:browser', 'Browser MCP'),
        ]
        const gateway = { complete: vi.fn().mockResolvedValue({
            toolCalls: [{ function: { name: 'select_toolsets', arguments: JSON.stringify({ namespaceIds: ['mcp:browser'] }) } }],
        }) } as unknown as LLMGateway
        const events: Array<Record<string, unknown>> = []
        captureRoutingEvents(events)

        const result = await applyAutoToolRouting({
            enabled: true,
            conversationId: 'conversation-scored-small-set',
            userQuery: 'inspect the browser',
            gateway,
            tools,
        })

        expect(routerMocks.route).not.toHaveBeenCalled()
        expect(result.map(({ name }) => name)).toEqual(['browser_snapshot', 'browser_find', 'expand_available_toolset'])
        const finalCalls = events.at(-1)!.toolCalls as Array<{ arguments: string }>
        expect(finalCalls.map(({ arguments: value }) => JSON.parse(value).selectionMethod)).toEqual(['automatic', 'automatic'])
    })

    test('ranks only larger selected toolsets when small and large toolsets are selected together', async () => {
        const small = [namespacedTool('small_a', 'mcp:small', 'Small'), namespacedTool('small_b', 'mcp:small', 'Small')]
        const large = Array.from({ length: 10 }, (_, index) => namespacedTool(`large_${index}`, 'mcp:large', 'Large'))
        routerMocks.route.mockImplementation(async ({ allTools }) => [allTools[0]])
        const gateway = { complete: vi.fn().mockResolvedValue({
            toolCalls: [{ function: { name: 'select_toolsets', arguments: JSON.stringify({ namespaceIds: ['mcp:small', 'mcp:large'] }) } }],
        }) } as unknown as LLMGateway

        const result = await applyAutoToolRouting({
            enabled: true,
            conversationId: 'conversation-mixed',
            userQuery: 'use both services',
            gateway,
            tools: [...small, ...large],
        })

        expect(routerMocks.route).toHaveBeenCalledWith(expect.objectContaining({ allTools: large }))
        expect(result.map(({ name }) => name)).toEqual(['small_a', 'small_b', 'large_0', 'expand_available_toolset'])
    })
})
