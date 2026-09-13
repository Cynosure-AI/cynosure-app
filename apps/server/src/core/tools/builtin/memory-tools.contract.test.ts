import { describe, expect, test } from 'vitest'
import {
    MEMORY_TOOL_NAMES,
    makeMemoryCreateTool,
    makeMemoryListDocumentsTool,
    makeMemoryDeleteTool,
    makeMemoryUpdateTool,
    makeMemoryRetrieveChunksTool,
    makeMemorySearchTool,
    makeKnowledgeAssertTool,
    makeKnowledgeDeleteTool,
    makeKnowledgeSearchTool,
    makeKnowledgeEntityMergeTool,
    readableKnowledgeEntityId,
} from './memory-tools.js'

describe('memory mutation tool contracts', () => {
    test('exposes only whole-document memory mutations', () => {
        expect(MEMORY_TOOL_NAMES).toEqual(expect.arrayContaining([
            'memory_create',
            'memory_update',
            'memory_delete',
        ]))
        expect(MEMORY_TOOL_NAMES).not.toEqual(expect.arrayContaining([
            'memory_append', 'memory_replace_range', 'memory_remove_range', 'memory_remove_all',
        ]))
    })

    test('keeps range fields out of whole-document replacement', () => {
        const tool = makeMemoryUpdateTool({})
        const properties = tool.parameters.properties as Record<string, unknown>
        expect(properties).not.toHaveProperty('partStart')
        expect(properties).not.toHaveProperty('partEnd')
        expect(tool.parameters.required).toEqual(['documentRef'])
        expect(tool.parameters.anyOf).toEqual([
            { required: ['content'] },
            { required: ['title'] },
            { required: ['category'] },
        ])
        expect(tool.parameters.additionalProperties).toBe(false)
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
            makeMemoryUpdateTool({}),
            makeMemoryDeleteTool({}),
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
