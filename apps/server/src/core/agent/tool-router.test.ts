import { describe, expect, test } from 'vitest'
import { routeToolsLexically, shouldRouteTools, toolEmbeddingText } from './tool-router.js'
import type { RegistryAwareToolDefinition } from '../gateway/providers/base.provider.js'

function tool(name: string, description: string, namespaceId?: string): RegistryAwareToolDefinition {
    return {
        name,
        description,
        timeout: 1_000,
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ success: true, output: 'ok' }),
        namespaceId,
    }
}

describe('tool router degraded mode', () => {
    test('can discover entity repair when the task calls for it', () => {
        const repair = tool('knowledge_entity_merge', 'Manually repair confirmed duplicate knowledge entities', 'builtin:memory')
        const result = routeToolsLexically({
            userQuery: 'repair duplicate knowledge entities',
            allTools: [tool('read_workspace', 'Read project files'), repair],
            maxTools: 1,
        })

        expect(result.map(({ name }) => name)).toContain('knowledge_entity_merge')
        expect(result.map(({ name }) => name)).not.toContain('read_workspace')
    })

    test('routes registered local tools even when no MCP namespace exists', () => {
        expect(shouldRouteTools([tool('read_workspace', 'Read project files')], 'inspect the project', { enabled: true })).toBe(true)
    })

    test('lexical fallback preserves pinned and sticky MCP tools plus expansion', () => {
        const tools = [
            tool('read_workspace', 'Read local project files'),
            tool('gmail_search', 'Search Gmail messages', 'mcp:gmail'),
            tool('calendar_list', 'List calendar events', 'mcp:calendar'),
        ]
        const result = routeToolsLexically({
            userQuery: 'inspect project files',
            allTools: tools,
            preferredToolNames: new Set(['gmail_search']),
            usedToolNames: new Set(['calendar_list']),
        })

        expect(result.map(({ name }) => name)).toEqual(expect.arrayContaining([
            'read_workspace',
            'gmail_search',
            'calendar_list',
            'expand_available_toolset',
        ]))
    })
})

describe('tool embedding text', () => {
    test('names the namespace and parameters but omits the JSON schema', () => {
        const text = toolEmbeddingText({
            ...tool('github__search_issues', 'Search issues and pull requests.', 'mcp:github'),
            originalName: 'search_issues',
            namespaceLabel: 'GitHub',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string' }, repo: { type: 'string', description: 'owner/name' } },
                required: ['query'],
            },
        })

        expect(text).toBe([
            'Namespace: GitHub',
            'Tool: search_issues',
            'Search issues and pull requests.',
            'Parameters: query, repo',
        ].join('\n'))
    })

    test('omits empty namespace and parameter lines', () => {
        expect(toolEmbeddingText(tool('read_workspace', 'Read project files'))).toBe('Tool: read_workspace\nRead project files')
    })
})
