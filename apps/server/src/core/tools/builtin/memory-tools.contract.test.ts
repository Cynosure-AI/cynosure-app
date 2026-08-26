import { describe, expect, test } from 'vitest'
import {
    MEMORY_TOOL_NAMES,
    makeMemoryAppendTool,
    makeMemoryCreateTool,
    makeMemoryListDocumentsTool,
    makeMemoryRemoveAllTool,
    makeMemoryRemoveRangeTool,
    makeMemoryReplaceAllTool,
    makeMemoryReplaceRangeTool,
    makeMemoryRetrieveChunksTool,
    makeMemorySearchTool,
    makeKnowledgeAssertTool,
    makeKnowledgeDeleteTool,
    makeKnowledgeSearchTool,
    makeKnowledgeEntityMergeTool,
    readableKnowledgeEntityId,
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

    test('requires one opaque document reference and both range boundaries', () => {
        const tool = makeMemoryReplaceRangeTool({})
        expect(tool.parameters.required).toEqual([
            'documentRef',
            'content',
            'partStart',
            'partEnd',
        ])
    })

    test('exposes an explicit entity merge contract', () => {
        const tool = makeKnowledgeEntityMergeTool({})
        expect(tool.name).toBe('knowledge_entity_merge')
        expect(tool.parameters).toMatchObject({
            required: ['entityIds', 'mainName'],
            additionalProperties: false,
            properties: {
                entityIds: { type: 'array', minItems: 1, maxItems: 20 },
                mainName: { type: 'string' },
            },
        })
        expect(tool.annotations?.destructiveHint).toBe(true)
    })

    test('formats stable, readable, lowercase tool-facing entity handles', () => {
        const handle = readableKnowledgeEntityId('Andi Personalakte', 'n:aV61X33k')
        expect(handle).toMatch(/^n:andi_personalakte#[a-f0-9]{8}$/)
        expect(readableKnowledgeEntityId('Andi Personalakte', 'n:aV61X33k')).toBe(handle)
        expect(readableKnowledgeEntityId('Andi Personalakte', 'n:different')).not.toBe(handle)
    })

    test('declares complete behavior annotations for every memory and relationship tool', () => {
        const tools = [
            makeMemoryListDocumentsTool({}),
            makeMemoryRetrieveChunksTool({}),
            makeMemorySearchTool({}),
            makeMemoryCreateTool({}),
            makeMemoryAppendTool({}),
            makeMemoryReplaceAllTool({}),
            makeMemoryReplaceRangeTool({}),
            makeMemoryRemoveAllTool({}),
            makeMemoryRemoveRangeTool({}),
            makeKnowledgeSearchTool({}),
            makeKnowledgeAssertTool({}),
            makeKnowledgeDeleteTool({}),
            makeKnowledgeEntityMergeTool({}),
        ]
        for (const tool of tools) {
            expect(tool.annotations, tool.name).toEqual(expect.objectContaining({
                readOnlyHint: expect.any(Boolean),
                destructiveHint: expect.any(Boolean),
                idempotentHint: expect.any(Boolean),
                openWorldHint: expect.any(Boolean),
            }))
            expect(tool.execution?.readOnly, tool.name).toBe(tool.annotations?.readOnlyHint)
        }
    })
})
