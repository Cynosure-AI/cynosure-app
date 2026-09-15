import { describe, expect, test } from 'vitest'
import {
    MEMORY_TOOL_NAMES,
    makeMemoryCreateTool,
    makeMemoryListDocumentsTool,
    makeMemoryUpdateTool,
    applyExactMemoryEdits,
    makeMemoryRetrieveChunksTool,
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
            'memory_list_documents', 'memory_retrieve_chunks', 'memory_semantic_search',
            'memory_create', 'memory_update',
        ])
    })

    test('exposes one exact, batch-oriented update contract', () => {
        const tool = makeMemoryUpdateTool({})
        expect(tool.parameters.required).toEqual(['documentId', 'edits'])
        expect(tool.parameters.additionalProperties).toBe(false)
        expect((tool.parameters.properties as any).edits.items.properties.op.enum).toEqual(['replace', 'delete', 'insert_after'])
    })

    test('applies edits exactly and rejects absent or ambiguous matches atomically', () => {
        const source = '## Preferences\n- Vue 2\n- Project X\n\n## Preferences\n'
        expect(applyExactMemoryEdits(source, [{ op: 'replace', old: 'Vue 2', new: 'Vue 3' }, { op: 'delete', old: '- Project X\n' }])).toEqual({ content: '## Preferences\n- Vue 3\n\n## Preferences\n' })
        expect(applyExactMemoryEdits('## Development Preferences\nExisting', [{ op: 'insert_after', anchor: '## Development Preferences', text: '- Prefers pnpm over npm.' }])).toEqual({ content: '## Development Preferences\n- Prefers pnpm over npm.\nExisting' })
        expect(applyExactMemoryEdits(source, [{ op: 'insert_after', anchor: '## Preferences', text: '- pnpm' }])).toEqual(expect.objectContaining({ error: expect.stringContaining('more than once') }))
        expect(applyExactMemoryEdits(source, [{ op: 'replace', old: 'vue 2', new: 'Vue 3' }])).toEqual(expect.objectContaining({ error: expect.stringContaining('exact') }))
        expect(applyExactMemoryEdits('aaa', [{ op: 'delete', old: 'aa' }])).toEqual(expect.objectContaining({ error: expect.stringContaining('more than once') }))
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
