import { describe, expect, test } from 'vitest'
import { normalizeMcpToolResult } from './mcp-result.js'

describe('normalizeMcpToolResult', () => {
    test('emits backwards-compatible JSON text and structuredContent only once', () => {
        const result = normalizeMcpToolResult({
            content: [{ type: 'text', text: '{"name":"Alice","id":1}' }],
            structuredContent: { id: 1, name: 'Alice' },
        })

        expect(result.output).toBe('{\n  "id": 1,\n  "name": "Alice"\n}')
        expect(result.structuredContent).toEqual({ id: 1, name: 'Alice' })
    })

    test('keeps a distinct human summary alongside structured data', () => {
        const result = normalizeMcpToolResult({
            content: [{ type: 'text', text: 'Found one user.' }],
            structuredContent: [{ id: 1, name: 'Alice' }],
        })

        expect(result.output).toContain('Found one user.')
        expect(result.output).toContain('Structured content:\n[')
        expect(result.output.match(/Alice/g)).toHaveLength(1)
    })

    test('supports JSON primitives without mistaking ordinary text for a duplicate', () => {
        expect(normalizeMcpToolResult({
            content: [{ type: 'text', text: 'Current state' }, { type: 'text', text: 'true' }],
            structuredContent: true,
        }).output).toBe('Current state\n\nStructured content:\ntrue')
    })

    test('preserves rich blocks and renders resource context for the model', () => {
        const result = normalizeMcpToolResult({
            content: [
                { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png', annotations: { audience: ['assistant'] } },
                { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
                { type: 'resource_link', uri: 'file:///report.md', name: 'report.md', description: 'The report' },
                { type: 'resource', resource: { uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'Some notes' } },
                { type: 'resource', resource: { uri: 'file:///plot.png', mimeType: 'image/png', blob: 'cGxvdA==' } },
            ],
        })

        expect(result.imageDataUrls).toEqual([
            'data:image/png;base64,aW1hZ2U=',
            'data:image/png;base64,cGxvdA==',
        ])
        expect(result.audioDataUrls).toEqual(['data:audio/wav;base64,YXVkaW8='])
        expect(result.output).toContain('[Resource: report.md](file:///report.md)')
        expect(result.output).toContain('[Embedded resource: file:///notes.txt (text/plain)]\nSome notes')
        expect(result.content?.[0]).toMatchObject({ annotations: { audience: ['assistant'] } })
    })

    test('does not expose opaque result metadata in model output', () => {
        const result = normalizeMcpToolResult({
            content: [{ type: 'text', text: 'Done' }],
            _meta: { secretComponentState: 'opaque' },
        })

        expect(result.output).toBe('Done')
        expect(result.providerMetadata).toEqual({ secretComponentState: 'opaque' })
    })
})
