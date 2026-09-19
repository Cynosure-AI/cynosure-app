import { describe, expect, test } from 'vitest'
import { getBuiltInToolKey } from '../../tools/built-in-tools.js'
import { DIRECT_TOOL_SELECTION_LIMIT } from '../../runtime-limits.js'
import { resolveExecutionToolPolicy, stripAutomaticallyManagedMemoryToolKeys } from './execution-planner.js'

describe('execution planner memory tool selection', () => {
    test('strips all automatically managed memory tools', () => {
        const selected = [
            getBuiltInToolKey('memory_create'),
            getBuiltInToolKey('memory_patch'),
            'mcp:files::read_file',
        ]

        expect(stripAutomaticallyManagedMemoryToolKeys(selected)).toEqual([
            'mcp:files::read_file',
        ])
    })
})

describe('execution planner manual tool cap', () => {
    function policy(selectedToolKeys: string[]) {
        return resolveExecutionToolPolicy({
            selectedToolKeys,
            hasRequestToolSelection: true,
            agentToolKeys: [],
            allRegisteredToolKeys: [...selectedToolKeys, 'unselected-tool'],
            hasExplicitToolAllowlist: true,
            autoToolRouting: false,
            hasResolvedAgent: false,
        })
    }

    test('sends a manual selection directly at the limit', () => {
        const selected = Array.from({ length: DIRECT_TOOL_SELECTION_LIMIT }, (_, index) => `tool-${index}`)

        expect(policy(selected)).toEqual({
            configuredTools: selected,
            fixedToolKeys: selected,
            autoToolRouting: false,
        })
    })

    test('routes above-limit selections within only the selected catalogue', () => {
        const selected = Array.from({ length: DIRECT_TOOL_SELECTION_LIMIT + 1 }, (_, index) => `tool-${index}`)

        expect(policy(selected)).toEqual({
            configuredTools: selected,
            fixedToolKeys: [],
            routingToolKeys: selected,
            autoToolRouting: true,
        })
    })
})
