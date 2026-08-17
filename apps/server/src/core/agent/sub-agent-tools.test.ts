import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    executorConfig: undefined as Record<string, unknown> | undefined,
    prepareAgentExecution: vi.fn(),
}))

vi.mock('../agents/agent-store.js', () => ({
    getAgent: (id: string) => id === 'worker' ? {
        id: 'worker',
        internalName: 'worker',
        name: 'Worker',
        description: 'Does bounded work',
        autoMemory: false,
        autoApproveTools: true,
        thinkingEnabled: true,
        reasoningEffort: 'medium',
        iconUrl: null,
    } : null,
}))
vi.mock('./prepare-execution.js', () => ({
    prepareAgentExecution: mocks.prepareAgentExecution,
}))
vi.mock('../gateway/gateway.js', () => ({
    getGateway: () => ({
        getLastUsedProvider: () => ({ config: { id: 'provider' } }),
        modelSupportsToolCalls: vi.fn().mockResolvedValue(true),
    }),
}))
vi.mock('../memory/memory-space-scope.js', () => ({
    getAssignedOrDefaultSpaces: () => [],
}))
vi.mock('./agent-executor.js', () => ({
    AgentExecutor: class {
        constructor(config: Record<string, unknown>) {
            mocks.executorConfig = config
        }
        async run() {
            return { content: '', images: [], thinking: '', toolRounds: 0 }
        }
    },
}))

import { buildSubAgentTools } from './sub-agent-tools.js'

describe('sub-agent execution', () => {
    beforeEach(() => {
        mocks.executorConfig = undefined
        mocks.prepareAgentExecution.mockReset().mockResolvedValue({
            providerId: 'provider',
            model: 'model',
            tools: [],
            systemMessages: [],
        })
    })

    test('passes the tool-scoped timeout signal into preparation and execution', async () => {
        const parent = new AbortController()
        const toolScope = new AbortController()
        const [tool] = buildSubAgentTools({
            subAgents: [{ agentId: 'worker' }],
            conversationId: 'conversation',
            broadcast: vi.fn(),
            signal: parent.signal,
        })

        await tool.execute({ internalName: 'worker', instructions: 'Do it' }, toolScope.signal)

        expect(mocks.prepareAgentExecution).toHaveBeenCalledWith(
            expect.objectContaining({ signal: toolScope.signal }),
        )
        expect(mocks.executorConfig).toEqual(expect.objectContaining({ signal: toolScope.signal }))
    })
})
