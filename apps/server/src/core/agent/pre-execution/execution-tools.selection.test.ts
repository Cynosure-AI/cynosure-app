import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { RegistryAwareToolDefinition } from '../../gateway/providers/base.provider.js'
import type { ExecutionPreset } from '../execution-preset.js'

const { applyAutoToolRouting } = vi.hoisted(() => ({
    applyAutoToolRouting: vi.fn(async (input: { tools: RegistryAwareToolDefinition[] }) => input.tools),
}))

vi.mock('./auto-tool-routing.js', () => ({
    applyAutoToolRouting,
    emitAutoToolRoutingSkipped: vi.fn(),
}))

vi.mock('../../tools/built-in-tools.js', () => ({
    getBuiltInMemoryToolKeys: () => [],
    getBuiltInToolKey: (name: string) => `builtin:utility::${name}`,
    hydrateBuiltInTools: (tools: RegistryAwareToolDefinition[]) => tools,
}))

vi.mock('../sub-agent-tools.js', () => ({
    buildSubAgentTools: () => ['spawn_subagent', 'continue_subagent'].map((name) => ({
        name,
        description: name,
        parameters: {},
        timeout: 1_000,
        execute: async () => ({ success: true, output: '' }),
    })),
}))

import { resolveExecutionTools } from './execution-tools.js'

const manageMcpKey = 'builtin:utility::manage_mcp'
const readKey = 'builtin:utility::read'

function tool(name: string, registryKey?: string): RegistryAwareToolDefinition {
    return {
        name,
        description: name,
        parameters: {},
        timeout: 1_000,
        execute: async () => ({ success: true, output: '' }),
        ...(registryKey ? { registryKey, originalName: name, namespaceId: 'builtin:utility' } : {}),
    }
}

function preset(overrides: Partial<ExecutionPreset> = {}): ExecutionPreset {
    return {
        id: '__agentless__',
        tools: [],
        subAgents: [],
        autoToolRouting: false,
        ...overrides,
    }
}

function registry() {
    const tools = new Map([
        [manageMcpKey, tool('manage_mcp', manageMcpKey)],
        [readKey, tool('read', readKey)],
    ])
    return {
        listRegisteredTools: () => [...tools].map(([key, value]) => ({
            key,
            name: value.name,
            executionName: value.name,
            description: value.description,
            parameters: value.parameters,
            namespace: { id: 'builtin:utility', label: 'Built-In: Utility' },
            ambiguous: false,
        })),
        resolveForExecution: (keys: string[]) => keys.flatMap((key) => tools.get(key) || []),
        getNamespaceMetadataForTools: () => [],
    }
}

function input(overrides: Record<string, unknown> = {}) {
    return {
        preset: preset(),
        conversationId: 'conversation-1',
        broadcast: vi.fn(),
        toolRegistry: registry(),
        gateway: {},
        resolvedProviderId: 'provider-1',
        resolvedModel: 'model-1',
        ...overrides,
    } as unknown as Parameters<typeof resolveExecutionTools>[0]
}

describe('resolveExecutionTools selection', () => {
    beforeEach(() => {
        applyAutoToolRouting.mockClear()
    })

    test('keeps manage_mcp out of automatic routing until it is explicitly selected', async () => {
        const disabled = await resolveExecutionTools(input({
            preset: preset({ autoToolRouting: true }),
            autoToolRouting: true,
        }))
        expect(disabled.tools.map(({ name }) => name)).toEqual(['read'])

        const enabled = await resolveExecutionTools(input({
            preset: preset({ autoToolRouting: true }),
            autoToolRouting: true,
            preferredToolKeys: [manageMcpKey],
        }))
        expect(enabled.tools.map(({ name }) => name)).toEqual(['manage_mcp', 'read'])
    })

    test('keeps configured Free Chat sub-agents when automatic external tools are suppressed', async () => {
        const result = await resolveExecutionTools(input({
            preset: preset({ subAgents: [{ agentId: 'agent-2' }] }),
            includeSubAgents: true,
            suppressAutoTools: true,
        }))

        expect(result.hasSubAgents).toBe(true)
        expect(result.effectiveSubAgents).toEqual([{ agentId: 'agent-2' }])
        expect(result.tools.map(({ name }) => name)).toEqual(['spawn_subagent', 'continue_subagent'])
    })
})
