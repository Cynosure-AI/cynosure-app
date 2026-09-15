import { describe, expect, test } from 'vitest'
import {
    MEMORY_TOOL_NAMES,
    makeMemoryCreateTool,
    makeMemoryPatchTool,
    applyMemoryPatch,
    makeMemorySearchTool,
    makeMemoryReadTool,
    makeKnowledgeAssertTool,
    makeKnowledgeDeleteTool,
    makeKnowledgeSearchTool,
    makeKnowledgeEntityMergeTool,
    readableKnowledgeEntityId,
} from './memory-tools.js'

describe('memory mutation tool contracts', () => {
    test('exposes focused memory mutations', () => {
        expect(MEMORY_TOOL_NAMES).toEqual([
            'memory_search', 'memory_read', 'memory_create', 'memory_patch',
        ])
    })

    test('exposes one contextual patch contract', () => {
        const tool = makeMemoryPatchTool({})
        expect(tool.parameters.required).toEqual(['fileRef', 'expectedRevision', 'patch'])
        expect(tool.parameters.additionalProperties).toBe(false)
    })

    test('applies replacement, deletion, insertion, and multi-edit patches atomically', () => {
        const source = '## Development\n\nUses Vue 2.\nKeeps Project X.\n'
        expect(applyMemoryPatch(source, '@@\n-Uses Vue 2.\n+Uses Vue 3.')).toMatchObject({ status: 'success', content: '## Development\n\nUses Vue 3.\nKeeps Project X.\n' })
        expect(applyMemoryPatch(source, '@@\n-Keeps Project X.')).toMatchObject({ status: 'success', content: '## Development\n\nUses Vue 2.\n\n' })
        expect(applyMemoryPatch(source, '@@\n Uses Vue 2.\n+Uses Electron.')).toMatchObject({ status: 'success', content: '## Development\n\nUses Vue 2.\nUses Electron.\nKeeps Project X.\n' })
        expect(applyMemoryPatch(source, '@@\n-Uses Vue 2.\n+Uses Vue 3.\n Keeps Project X.\n+Uses Electron.')).toMatchObject({ status: 'success', content: '## Development\n\nUses Vue 3.\nKeeps Project X.\nUses Electron.\n' })
    })

    test('rejects missing and ambiguous context without returning partial content', () => {
        expect(applyMemoryPatch('Vue 2\nVue 2', '@@\n-Vue 2\n+Vue 3')).toMatchObject({ status: 'conflict', reason: 'ambiguous_context' })
        expect(applyMemoryPatch('Vue 2', '@@\n-Vue 1\n+Vue 3')).toMatchObject({ status: 'conflict', reason: 'expected_context_not_found' })
        expect(applyMemoryPatch('Vue 2', '@@\n-Vue 2\n+Vue 3\n@@\n-Missing\n+Present')).toEqual(expect.objectContaining({ status: 'conflict', reason: 'expected_context_not_found' }))
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
            makeMemorySearchTool({}),
            makeMemoryReadTool({}),
            makeMemoryCreateTool({}),
            makeMemoryPatchTool({}),
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
