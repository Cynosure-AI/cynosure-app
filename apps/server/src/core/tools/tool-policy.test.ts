import { describe, expect, test } from 'vitest'
import { isSystemAutoApprovedTool } from './tool-policy.js'

describe('tool approval policy', () => {
    test('auto-approves memory and graph reads, but not writes', () => {
        expect(isSystemAutoApprovedTool('memory_semantic_search')).toBe(true)
        expect(isSystemAutoApprovedTool('relationship_graph_search')).toBe(true)
        expect(isSystemAutoApprovedTool('memory_replace_all')).toBe(false)
        expect(isSystemAutoApprovedTool('memory_remove_all')).toBe(false)
        expect(isSystemAutoApprovedTool('relationship_graph_assert')).toBe(false)
        expect(isSystemAutoApprovedTool('relationship_graph_delete')).toBe(false)
    })
})
