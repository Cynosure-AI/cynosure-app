import { describe, expect, test } from 'vitest'
import {
    MEMORY_TOOL_NAMES,
    makeMemoryCreateTool,
    makeMemoryPatchTool,
    makeMemoryDeleteTool,
    applyMemoryPatch,
    makeMemorySearchTool,
} from './memory-tools.js'

describe('memory mutation tool contracts', () => {
    test('exposes focused memory mutations', () => {
        expect(MEMORY_TOOL_NAMES).toEqual([
            'memory_search', 'memory_create', 'memory_patch', 'memory_delete',
        ])
    })

    test('includes configured folder descriptions in memory tool scope hints', () => {
        const tool = makeMemorySearchTool({
            assignedFolders: [
                { id: 'project', name: 'Project', description: 'Current product delivery.' },
                { id: 'shared', name: 'Shared' },
            ],
        })

        expect(tool.description).toContain('"Project" — Current product delivery.')
        expect(tool.description).toContain('"Shared"')
        expect(tool.description).not.toContain('"Shared" —')
    })

    test('exposes structured line-edit operations', () => {
        const tool = makeMemoryPatchTool({})
        expect(tool.parameters.required).toEqual(['fileRef', 'edits'])
        expect(tool.parameters.additionalProperties).toBe(false)
        expect(tool.parameters.properties).not.toHaveProperty('patch')
        expect(tool.parameters.properties).not.toHaveProperty('expectedRevision')
        expect(tool.outputSchema?.properties).not.toHaveProperty('currentRevision')
        expect(tool.outputSchema?.properties).toHaveProperty('editIndex')
        expect(tool.outputSchema?.properties).toHaveProperty('matchCount')
        expect(tool.outputSchema?.properties).toHaveProperty('suggestedAnchor')
    })

    test('applies line replacement, deletion, insertion, and ordered edits', () => {
        const source = '## Development\n\nUses Vue 2.\nKeeps Project X.\n'
        expect(applyMemoryPatch(source, [{ op: 'replace', anchor: 'Uses Vue 2.', content: 'Uses Vue 3.' }])).toMatchObject({ status: 'success', content: '## Development\n\nUses Vue 3.\nKeeps Project X.\n' })
        expect(applyMemoryPatch(source, [{ op: 'delete', anchor: 'Keeps Project X.' }])).toMatchObject({ status: 'success', content: '## Development\n\nUses Vue 2.\n' })
        expect(applyMemoryPatch(source, [{ op: 'insert_after', anchor: 'Uses Vue 2.', content: '- Uses Electron.' }])).toMatchObject({ status: 'success', content: '## Development\n\nUses Vue 2.\n- Uses Electron.\nKeeps Project X.\n' })
        expect(applyMemoryPatch(source, [
            { op: 'replace', anchor: 'Uses Vue 2.', content: 'Uses Vue 3.' },
            { op: 'insert_after', anchor: 'Keeps Project X.', content: '- Uses Electron.' },
        ])).toMatchObject({ status: 'success', content: '## Development\n\nUses Vue 3.\nKeeps Project X.\n- Uses Electron.\n' })
    })

    test('treats Markdown bullets as ordinary anchors and supports insertion before a line', () => {
        const source = '## Observations (Update 17:33)\n- Nur zwei Snapshots heute.\n\n## Observations (Update 07:51)\n'
        const result = applyMemoryPatch(source, [{
            op: 'insert_before',
            anchor: '## Observations (Update 07:51)',
            content: '## Observations (Update 17:45)\n- 17:33→17:45: direkte Projektarbeit statt Konsum.',
        }])
        expect(result).toMatchObject({
            status: 'success',
            content: '## Observations (Update 17:33)\n- Nur zwei Snapshots heute.\n\n## Observations (Update 17:45)\n- 17:33→17:45: direkte Projektarbeit statt Konsum.\n## Observations (Update 07:51)\n',
        })
        expect(applyMemoryPatch('- Existing bullet', [{ op: 'replace', anchor: '- Existing bullet', content: '- Updated bullet' }]))
            .toMatchObject({ status: 'success', content: '- Updated bullet' })
    })

    test('rejects missing and ambiguous anchors without returning partial content', () => {
        expect(applyMemoryPatch('Vue 2\nVue 2', [{ op: 'replace', anchor: 'Vue 2', content: 'Vue 3' }]))
            .toMatchObject({ status: 'conflict', reason: 'ambiguous_context', editIndex: 0, matchCount: 2 })
        expect(applyMemoryPatch('Vue 2', [{ op: 'replace', anchor: 'Vue 1', content: 'Vue 3' }]))
            .toMatchObject({ status: 'conflict', reason: 'expected_context_not_found', editIndex: 0, matchCount: 0, suggestedAnchor: 'Vue 2' })
        expect(applyMemoryPatch('Vue 2', [
            { op: 'replace', anchor: 'Vue 2', content: 'Vue 3' },
            { op: 'delete', anchor: 'Missing' },
        ])).toMatchObject({ status: 'conflict', reason: 'expected_context_not_found', editIndex: 1 })
    })

    test('rejects invalid edit shapes and multi-line anchors', () => {
        expect(applyMemoryPatch('Line one\nLine two', [{ op: 'replace', anchor: 'Line one\nLine two', content: 'Updated' }]))
            .toMatchObject({ status: 'conflict', reason: 'invalid_patch', editIndex: 0 })
        expect(applyMemoryPatch('Line one', [{ op: 'delete', anchor: 'Line one', content: 'unused' } as never]))
            .toMatchObject({ status: 'conflict', reason: 'invalid_patch' })
    })

    test('matches safe Unicode variants while preserving canonical context bytes', () => {
        const source = 'Header\nStatus: ☕️ — „bereit“\u00a0e\u0301\nTail'
        const result = applyMemoryPatch(source, [{ op: 'insert_after', anchor: 'Status: ☕ - "bereit" é', content: 'Added ✅' }])
        expect(result).toMatchObject({
            status: 'success',
            content: 'Header\nStatus: ☕️ — „bereit“\u00a0e\u0301\nAdded ✅\nTail',
        })
    })

    test('treats multiple Unicode-equivalent contexts as ambiguous', () => {
        const result = applyMemoryPatch('State — ready\nState - ready', [{ op: 'replace', anchor: 'State - ready', content: 'Done' }])
        expect(result).toMatchObject({ status: 'conflict', reason: 'ambiguous_context', matchCount: 2 })
    })

    test('keeps recovery guidance for genuinely different context', () => {
        const result = applyMemoryPatch('Price: €20 and value ≈ 2', [{ op: 'replace', anchor: 'Price: $20 and value = 2', content: 'Changed' }])
        expect(result).toMatchObject({ status: 'conflict', reason: 'expected_context_not_found' })
        expect('message' in result ? result.message : '').toContain('other characters remain exact')
        expect('message' in result ? result.message : '').toContain('run memory_search again')
    })

    test('declares complete behavior annotations for every memory tool', () => {
        const tools = [
            makeMemorySearchTool({}),
            makeMemoryCreateTool({}),
            makeMemoryPatchTool({}),
            makeMemoryDeleteTool({}),
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
