import { describe, expect, test } from 'vitest'
import { getBuiltInMemoryReadToolKeys, getBuiltInMemoryToolKeys } from '../../tools/built-in-tools.js'

describe('built-in memory tool keys', () => {
    test('includes the unified memory mutation tool by default', () => {
        expect(getBuiltInMemoryReadToolKeys()).toEqual([
            'builtin:memory::memory_search',
        ])
        expect(getBuiltInMemoryToolKeys()).toEqual([
            ...getBuiltInMemoryReadToolKeys(),
            'builtin:memory::memory_create',
            'builtin:memory::memory_patch',
            'builtin:memory::memory_delete',
        ])
    })
})
