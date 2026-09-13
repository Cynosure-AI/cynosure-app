import { describe, expect, test } from 'vitest'
import { isAnnotationAutoApprovedTool, isSystemAutoApprovedTool } from './tool-policy.js'

describe('tool approval policy', () => {
    test('auto-approves memory and graph reads, but not writes', () => {
        expect(isSystemAutoApprovedTool('memory_semantic_search')).toBe(true)
        expect(isSystemAutoApprovedTool('knowledge_search')).toBe(true)
        expect(isSystemAutoApprovedTool('memory_update')).toBe(false)
        expect(isSystemAutoApprovedTool('memory_delete')).toBe(false)
        expect(isSystemAutoApprovedTool('knowledge_assert')).toBe(false)
        expect(isSystemAutoApprovedTool('knowledge_delete')).toBe(false)
        expect(isSystemAutoApprovedTool('knowledge_entity_merge')).toBe(false)
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
