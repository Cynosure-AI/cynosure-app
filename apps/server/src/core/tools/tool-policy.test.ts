import { describe, expect, test } from 'vitest'
import { isAnnotationAutoApprovedTool, isEditModeTool, isReadOnlyModeTool, isSystemAutoApprovedTool } from './tool-policy.js'

describe('tool approval policy', () => {
    test('auto-approves memory reads, but not writes', () => {
        expect(isSystemAutoApprovedTool('memory_search')).toBe(true)
        expect(isSystemAutoApprovedTool('memory_create')).toBe(false)
        expect(isSystemAutoApprovedTool('memory_patch')).toBe(false)
    })

    test('blocks memory creation, patch, and delete in Read Only mode', () => {
        const annotations = { readOnlyHint: false, destructiveHint: false }
        expect(isReadOnlyModeTool({ name: 'memory_create', annotations })).toBe(false)
        expect(isReadOnlyModeTool({ name: 'memory_patch', annotations })).toBe(false)
        expect(isReadOnlyModeTool({ name: 'memory_delete', annotations: { readOnlyHint: false, destructiveHint: true } })).toBe(false)
    })

    test('uses safe MCP read-only hints as an auto-approval default', () => {
        expect(isAnnotationAutoApprovedTool({ readOnlyHint: true })).toBe(true)
        expect(isAnnotationAutoApprovedTool({ readOnlyHint: true, destructiveHint: false })).toBe(true)
        expect(isAnnotationAutoApprovedTool({ readOnlyHint: true, openWorldHint: true })).toBe(true)
    })

    test('requires approval for writes, missing hints, and conflicting destructive hints', () => {
        expect(isAnnotationAutoApprovedTool()).toBe(false)
        expect(isAnnotationAutoApprovedTool({})).toBe(false)
        expect(isAnnotationAutoApprovedTool({ readOnlyHint: false, destructiveHint: false })).toBe(false)
        expect(isAnnotationAutoApprovedTool({ readOnlyHint: false, idempotentHint: true })).toBe(false)
        expect(isAnnotationAutoApprovedTool({ readOnlyHint: true, destructiveHint: true })).toBe(false)
    })
})

describe('isEditModeTool', () => {
    const files = (name: string, readOnlyHint = false) => ({ name, namespaceId: 'builtin:files', originalName: name, annotations: { readOnlyHint, destructiveHint: !readOnlyHint } })

    test.each([
        ['file_read', files('file_read', true), {}],
        ['file_write without overwrite', files('file_write'), { path: 'a.txt', content: '' }],
        ['file_edit', files('file_edit'), { path: 'a.txt' }],
        ['file_move without overwrite', files('file_move'), { source: 'a', destination: 'b' }],
        ['directory_create', files('directory_create'), { path: 'dir' }],
        ['a declared non-destructive writer', { name: 'mcp_write', annotations: { readOnlyHint: false, destructiveHint: false } }, {}],
    ])('runs %s', (_label, tool, args) => {
        expect(isEditModeTool(tool, args)).toBe(true)
    })

    test.each([
        ['file_delete', files('file_delete'), { path: 'a.txt' }],
        ['file_write with overwrite', files('file_write'), { path: 'a.txt', content: '', overwrite: true }],
        ['file_archive with overwrite', files('file_archive'), { action: 'extract', overwrite: true }],
        ['shell', { name: 'shell_execute', namespaceId: 'builtin:shell', annotations: { readOnlyHint: false, destructiveHint: true } }, { command: 'ls' }],
        ['a destructive tool', { name: 'mcp_drop', annotations: { readOnlyHint: false, destructiveHint: true } }, {}],
        ['a tool without hints', { name: 'mcp_unknown' }, {}],
        ['a writer that does not deny being destructive', { name: 'mcp_write', annotations: { readOnlyHint: false } }, {}],
    ])('asks for %s', (_label, tool, args) => {
        expect(isEditModeTool(tool, args)).toBe(false)
    })
})
