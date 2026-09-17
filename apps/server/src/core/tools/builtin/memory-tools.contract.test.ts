import { describe, expect, test } from 'vitest'
import {
    MEMORY_TOOL_NAMES,
    makeMemoryCreateTool,
    makeMemoryPatchTool,
    applyMemoryPatch,
    makeMemorySearchTool,
    makeKnowledgeAssertTool,
    makeKnowledgeDeleteTool,
    makeKnowledgeSearchTool,
    makeKnowledgeEntityMergeTool,
    readableKnowledgeEntityId,
} from './memory-tools.js'

describe('memory mutation tool contracts', () => {
    test('exposes focused memory mutations', () => {
        expect(MEMORY_TOOL_NAMES).toEqual([
            'memory_search', 'memory_create', 'memory_patch',
        ])
    })

    test('exposes one contextual patch contract', () => {
        const tool = makeMemoryPatchTool({})
        expect(tool.parameters.required).toEqual(['fileRef', 'patch'])
        expect(tool.parameters.additionalProperties).toBe(false)
        expect(tool.parameters.properties).not.toHaveProperty('expectedRevision')
        expect(tool.outputSchema?.properties).not.toHaveProperty('currentRevision')
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

    test('explains patch syntax and detects deletion markers used as context', () => {
        const malformed = applyMemoryPatch('- Existing bullet', '@@\n-- Existing bullet')
        expect(malformed).toMatchObject({ status: 'conflict', reason: 'invalid_patch' })
        expect('message' in malformed ? malformed.message : '').toContain('You may have used - as context')
        expect('message' in malformed ? malformed.message : '').toContain('prefix those lines with one space')

        const invalidLine = applyMemoryPatch('Existing text', '@@\nExisting text')
        expect(invalidLine).toMatchObject({ status: 'conflict', reason: 'invalid_patch' })
        expect('message' in invalidLine ? invalidLine.message : '').toContain('Lines starting with - are deletions')
    })

    test('matches safe Unicode variants while preserving canonical context bytes', () => {
        const source = 'Header\nStatus: ☕️ — „bereit“\u00a0e\u0301\nTail'
        const result = applyMemoryPatch(source, '@@\n Status: ☕ - "bereit" é\n+Added ✅')
        expect(result).toMatchObject({
            status: 'success',
            content: 'Header\nStatus: ☕️ — „bereit“\u00a0e\u0301\nAdded ✅\nTail',
        })
    })

    test('treats multiple Unicode-equivalent contexts as ambiguous', () => {
        const result = applyMemoryPatch('State — ready\nState - ready', '@@\n-State - ready\n+Done')
        expect(result).toMatchObject({ status: 'conflict', reason: 'ambiguous_context' })
    })

    test('keeps recovery guidance for genuinely different context', () => {
        const result = applyMemoryPatch('Price: €20 and value ≈ 2', '@@\n-Price: $20 and value = 2\n+Changed')
        expect(result).toMatchObject({ status: 'conflict', reason: 'expected_context_not_found' })
        expect('message' in result ? result.message : '').toContain('other characters remain exact')
        expect('message' in result ? result.message : '').toContain('Run memory_search again')
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
