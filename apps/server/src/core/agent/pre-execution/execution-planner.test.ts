import { describe, expect, test } from 'vitest'
import { getBuiltInToolKey } from '../../tools/built-in-tools.js'
import { stripAutomaticallyManagedMemoryToolKeys } from './execution-planner.js'

describe('execution planner memory tool selection', () => {
    test('strips all automatically managed memory tools', () => {
        const selected = [
            getBuiltInToolKey('memory_create'),
            getBuiltInToolKey('memory_update'),
            'mcp:files::read_file',
        ]

        expect(stripAutomaticallyManagedMemoryToolKeys(selected)).toEqual([
            'mcp:files::read_file',
        ])
    })
})
