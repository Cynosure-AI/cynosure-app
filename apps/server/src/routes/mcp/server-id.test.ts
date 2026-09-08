import { describe, expect, test } from 'vitest'
import { createMcpServerId, mcpServerIdSlug } from './server-id.js'

describe('MCP server IDs', () => {
    test.each([
        ['Google Calendar', 'google-calendar'],
        ['MCP Filesystem', 'filesystem'],
        ['Server Weather', 'weather'],
        ['@cynosure-mcp/weather@latest', 'cynosure-mcp-weather'],
        ['München Search', 'munchen-search'],
    ])('creates a readable slug for %s', (source, expected) => {
        expect(mcpServerIdSlug(source)).toBe(expected)
    })

    test('does not persist a full local source path', () => {
        const slug = mcpServerIdSlug('/Users/ada/private/calendar-mcp/server.js')

        expect(slug).toBe('server')
        expect(slug).not.toContain('ada')
        expect(slug).not.toContain('private')
    })

    test('adds a short, collision-resistant suffix', () => {
        const first = createMcpServerId('Google Calendar')
        const second = createMcpServerId('Google Calendar')

        expect(first).toMatch(/^google-calendar_[a-z0-9]{8}$/)
        expect(second).toMatch(/^google-calendar_[a-z0-9]{8}$/)
        expect(second).not.toBe(first)
    })

    test('uses a safe fallback when the source has no slug characters', () => {
        expect(createMcpServerId('日本語')).toMatch(/^server_[a-z0-9]{8}$/)
    })
})
