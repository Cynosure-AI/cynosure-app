import { describe, expect, test } from 'vitest'
import {
    MEMORY_TOOL_NAMES,
    makeMemoryAppendTool,
    makeMemoryReplaceAllTool,
    makeMemoryReplaceRangeTool,
} from './memory-tools.js'

describe('memory mutation tool contracts', () => {
    test('does not expose the ambiguous memory_update tool', () => {
        expect(MEMORY_TOOL_NAMES).not.toContain('memory_update')
        expect(MEMORY_TOOL_NAMES).not.toContain('memory_remove')
        expect(MEMORY_TOOL_NAMES).toEqual(expect.arrayContaining([
            'memory_append',
            'memory_replace_range',
            'memory_replace_all',
            'memory_remove_all',
            'memory_remove_range',
        ]))
    })

    test('keeps range fields out of append and whole-document replacement', () => {
        for (const tool of [makeMemoryAppendTool({}), makeMemoryReplaceAllTool({})]) {
            const properties = tool.parameters.properties as Record<string, unknown>
            expect(properties).not.toHaveProperty('partStart')
            expect(properties).not.toHaveProperty('partEnd')
            expect(tool.parameters.additionalProperties).toBe(false)
        }
    })

    test('requires stable identity, revision, and both range boundaries', () => {
        const tool = makeMemoryReplaceRangeTool({})
        expect(tool.parameters.required).toEqual([
            'documentId',
            'expectedRevision',
            'content',
            'partStart',
            'partEnd',
        ])
    })
})
