import { describe, expect, test } from 'vitest'
import type { RegistryAwareToolDefinition } from '../../gateway/providers/base.provider.js'
import type { ExecutionPreset } from '../execution-preset.js'
import { filterToolsForExecutionPreset } from './execution-tools.js'
import { getBuiltInMemoryReadToolKeys, getBuiltInMemoryToolKeys } from '../../tools/built-in-tools.js'

function tool(name: string, namespaceId = 'builtin', originalName = name): RegistryAwareToolDefinition {
    return {
        name,
        originalName,
        namespaceId,
        description: name,
        parameters: {},
        timeout: 1_000,
        execute: async () => ({ success: true, output: '' }),
    }
}

function preset(id: string): ExecutionPreset {
    return { id, tools: [], subAgents: [] }
}

describe('agent-required execution tools', () => {
    const tools = [
        tool('schedule_create'),
        tool('schedule_list_alias', 'builtin', 'schedule_list'),
        tool('schedule_create', 'mcp:calendar'),
        tool('read_file'),
    ]

    test('keeps scheduling tools available to agentless execution', () => {
        expect(filterToolsForExecutionPreset(preset('__agentless__'), tools)).toEqual(tools)
    })

    test('keeps scheduling tools available to saved agents', () => {
        expect(filterToolsForExecutionPreset(preset('agent-1'), tools)).toEqual(tools)
    })

    test('includes the unified memory mutation tool by default', () => {
        expect(getBuiltInMemoryReadToolKeys()).toEqual([
            'builtin:memory::memory_search',
            'builtin:memory::knowledge_search',
        ])
        expect(getBuiltInMemoryToolKeys()).toEqual([
            ...getBuiltInMemoryReadToolKeys(),
            'builtin:memory::memory_create',
            'builtin:memory::memory_patch',
        ])
    })
})
