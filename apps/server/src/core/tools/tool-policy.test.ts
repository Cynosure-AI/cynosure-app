import { describe, expect, test } from 'vitest'
import { isAnnotationAutoApprovedTool, isReadOnlyModeTool, isSystemAutoApprovedTool } from './tool-policy.js'

describe('tool approval policy', () => {
    test('auto-approves memory reads, but not writes', () => {
        expect(isSystemAutoApprovedTool('memory_search')).toBe(true)
        expect(isSystemAutoApprovedTool('memory_create')).toBe(false)
        expect(isSystemAutoApprovedTool('memory_patch')).toBe(false)
    })

    test('allows additive memory creation in Read Only mode but blocks patch and delete', () => {
        const annotations = { readOnlyHint: false, destructiveHint: false }
        expect(isReadOnlyModeTool({ name: 'memory_create', annotations })).toBe(true)
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
