import { describe, expect, test, vi } from 'vitest'
import type { RegistryAwareToolDefinition } from '../../gateway/providers/base.provider.js'
import { makeSearchAvailableMcpToolsTool } from './expand-available-toolset.js'

function tool(name: string, namespaceId: string): RegistryAwareToolDefinition {
    return {
        name,
        namespaceId,
        description: `${name} description`,
        parameters: { type: 'object' },
        timeout: 1_000,
        execute: async () => ({ success: true, output: 'ok' }),
    }
}

describe('expand available toolset', () => {
    test('delegates to AI + retrieval search and returns only still-available MCP tools', async () => {
        const gmail = tool('gmail_search', 'mcp:gmail')
        const calendar = tool('calendar_list', 'mcp:calendar')
        const injected = tool('not_installed', 'mcp:unknown')
        const searchTools = vi.fn().mockResolvedValue([injected, calendar, calendar])
        const expansion = makeSearchAvailableMcpToolsTool({
            allTools: [gmail, calendar],
            getLoadedToolNames: () => new Set(['gmail_search']),
            searchTools,
        })

        const result = await expansion.execute({
            requested_capability: 'list upcoming meetings',
            limit: 4,
        })

        expect(searchTools).toHaveBeenCalledWith(expect.objectContaining({
            requestedCapability: 'list upcoming meetings',
            availableTools: [calendar],
            limit: 4,
        }))
        expect(result.loadedTools).toEqual([calendar])
        expect(result.output).toContain('calendar_list')
    })

    test('falls back to lexical matching when runtime routing fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const gmail = tool('gmail_search', 'mcp:gmail')
        const calendar = tool('calendar_list', 'mcp:calendar')
        const expansion = makeSearchAvailableMcpToolsTool({
            allTools: [calendar, gmail],
            getLoadedToolNames: () => new Set(),
            searchTools: vi.fn().mockRejectedValue(new Error('router unavailable')),
        })

        const result = await expansion.execute({
            requested_capability: 'search gmail messages',
            limit: 1,
        })

        expect(result.loadedTools).toEqual([gmail])
        warn.mockRestore()
    })
})
