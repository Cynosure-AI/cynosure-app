import { describe, expect, test } from 'vitest'
import { getBuiltInToolKey } from '../../tools/built-in-tools.js'
import { stripAutomaticallyManagedMemoryToolKeys } from './execution-planner.js'

describe('execution planner memory tool selection', () => {
    test('strips automatically managed reads and additive writes but preserves routed mutations', () => {
        const selected = [
            getBuiltInToolKey('memory_create'),
            getBuiltInToolKey('memory_append'),
            getBuiltInToolKey('memory_replace_range'),
            getBuiltInToolKey('memory_remove_all'),
            'mcp:files::read_file',
        ]

        expect(stripAutomaticallyManagedMemoryToolKeys(selected)).toEqual([
            getBuiltInToolKey('memory_replace_range'),
            getBuiltInToolKey('memory_remove_all'),
            'mcp:files::read_file',
        ])
    })
})
