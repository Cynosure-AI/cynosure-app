import { beforeEach, describe, expect, test } from 'vitest'
import type { RegistryAwareToolDefinition } from '../../gateway/providers/base.provider.js'
import { MAX_STICKY_TOOLS, recordLoadedTools, resetStickyToolsets, stabilizeRoutedTools } from './conversation-toolset.js'

function tool(name: string): RegistryAwareToolDefinition {
    return { name, description: name, parameters: {}, timeout: 1_000, execute: async () => ({ success: true, output: '' }) }
}

const names = (tools: RegistryAwareToolDefinition[]) => tools.map(({ name }) => name)

describe('stabilizeRoutedTools', () => {
    const catalogue = ['a', 'b', 'c', 'd'].map(tool)

    beforeEach(() => resetStickyToolsets())

    test('keeps earlier tools in their order and appends newly routed ones', () => {
        expect(names(stabilizeRoutedTools('conv', [tool('b'), tool('a')], catalogue))).toEqual(['b', 'a'])
        expect(names(stabilizeRoutedTools('conv', [tool('c'), tool('a')], catalogue))).toEqual(['b', 'a', 'c'])
        expect(names(stabilizeRoutedTools('conv', [tool('d')], catalogue))).toEqual(['b', 'a', 'c', 'd'])
    })

    test('drops tools that left the candidate catalogue', () => {
        stabilizeRoutedTools('conv', [tool('a'), tool('b')], catalogue)
        expect(names(stabilizeRoutedTools('conv', [tool('c')], [tool('b'), tool('c')]))).toEqual(['b', 'c'])
    })

    test('prefers this turn\'s definition for a kept tool', () => {
        stabilizeRoutedTools('conv', [tool('a')], catalogue)
        const rebuilt = { ...tool('a'), description: 'rebuilt' }
        expect(stabilizeRoutedTools('conv', [rebuilt], catalogue)[0]).toBe(rebuilt)
    })

    test('tracks each key separately', () => {
        stabilizeRoutedTools('conv\u0000main', [tool('a')], catalogue)
        expect(names(stabilizeRoutedTools('conv\u0000sub', [tool('b')], catalogue))).toEqual(['b'])
    })

    test('starts over from the current routing once the list grows too long', () => {
        const many = Array.from({ length: MAX_STICKY_TOOLS }, (_, index) => tool(`t${index}`))
        stabilizeRoutedTools('conv', many, [...many, tool('extra')])
        expect(names(stabilizeRoutedTools('conv', [tool('extra')], [...many, tool('extra')]))).toEqual(['extra'])
    })

    test('offers tools loaded by tool search next turn, after the tool they followed', () => {
        stabilizeRoutedTools('conv', [tool('a'), tool('b')], catalogue)
        expect(recordLoadedTools('conv', ['c', 'a'])).toBe('b')
        expect(recordLoadedTools('conv', ['d'])).toBe('c')
        expect(names(stabilizeRoutedTools('conv', [tool('a')], catalogue))).toEqual(['a', 'b', 'c', 'd'])
    })

    test('does not record loaded tools for an untracked key', () => {
        expect(recordLoadedTools('conv', ['a'])).toBeUndefined()
        expect(names(stabilizeRoutedTools('conv', [tool('b')], catalogue))).toEqual(['b'])
    })
})
