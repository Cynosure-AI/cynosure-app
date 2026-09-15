import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    executorConfig: undefined as Record<string, unknown> | undefined,
    executorMessages: undefined as unknown[] | undefined,
    prepareAgentExecution: vi.fn(),
    dbPrepare: vi.fn(),
    session: undefined as { invocation_id: string; agent_id: string; history_json: string } | undefined,
    executorResult: { content: '', images: [], thinking: '', toolRounds: 0 },
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
vi.mock('../memory/memory-folder-scope.js', () => ({
    getAssignedMemoryFolders: () => [],
}))
vi.mock('../../db/database.js', () => ({
    getDb: () => ({
        prepare: mocks.dbPrepare,
    }),
}))
vi.mock('./agent-executor.js', () => ({
    AgentExecutor: class {
        constructor(config: Record<string, unknown>) {
            mocks.executorConfig = config
        }
        async run(messages: unknown[]) {
            mocks.executorMessages = messages
            return mocks.executorResult
        }
    },
}))

import { buildSubAgentTools } from './sub-agent-tools.js'

describe('sub-agent execution', () => {
    beforeEach(() => {
        mocks.executorConfig = undefined
        mocks.executorMessages = undefined
        mocks.session = undefined
        mocks.executorResult = { content: '', images: [], thinking: '', toolRounds: 0 }
        mocks.dbPrepare.mockReset().mockImplementation((sql: string) => ({
            run: vi.fn(),
            get: vi.fn(() => sql.includes('SELECT invocation_id') ? mocks.session : undefined),
        }))
        mocks.prepareAgentExecution.mockReset().mockResolvedValue({
            providerId: 'provider',
            model: 'model',
            tools: [],
            systemMessages: [],
        })
    })

    test('combines the tool-scoped signal with the sub-agent execution timeout', async () => {
        const parent = new AbortController()
        const toolScope = new AbortController()
        const [tool] = buildSubAgentTools({
            subAgents: [{ agentId: 'worker' }],
            conversationId: 'conversation',
            broadcast: vi.fn(),
            signal: parent.signal,
        })

        await tool.execute({ internalName: 'worker', instructions: 'Do it' }, toolScope.signal)

        const subAgentSignal = mocks.prepareAgentExecution.mock.calls[0][0].signal as AbortSignal
        expect(subAgentSignal).not.toBe(toolScope.signal)
        expect(mocks.executorConfig).toEqual(expect.objectContaining({ signal: subAgentSignal }))
        expect(subAgentSignal.aborted).toBe(false)
        toolScope.abort(new DOMException('Timed out', 'AbortError'))
        expect(subAgentSignal.aborted).toBe(true)
    })

    test('allows five minutes for delegated work plus a shutdown grace period', () => {
        const [tool, continueTool] = buildSubAgentTools({
            subAgents: [{ agentId: 'worker' }],
            conversationId: 'conversation',
            broadcast: vi.fn(),
        })

        expect(tool.timeout).toBe(310_000)
        expect(continueTool.timeout).toBe(310_000)
    })

    test('declares conservative behavior hints for delegated execution', () => {
        const [tool, continueTool] = buildSubAgentTools({
            subAgents: [{ agentId: 'worker' }],
            conversationId: 'conversation',
            broadcast: vi.fn(),
        })

        expect(tool.execution).toEqual({ readOnly: false })
        expect(tool.annotations).toEqual({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        })
        expect(continueTool.execution).toEqual({ readOnly: false })
        expect(continueTool.annotations).toEqual(tool.annotations)
    })

    test('returns a durable invocation ID from spawn', async () => {
        mocks.executorResult = { content: 'Completed work', images: [], thinking: '', toolRounds: 0 }
        const [tool] = buildSubAgentTools({
            subAgents: [{ agentId: 'worker' }],
            conversationId: 'conversation',
            broadcast: vi.fn(),
        })

        const result = await tool.execute({ internalName: 'worker', instructions: 'Do it' })

        expect(result.success).toBe(true)
        expect(result.structuredContent).toEqual({
            invocationId: expect.stringMatching(/^worker-[23456789abcdefghjkmnpqrstuvwxyz]{8}$/),
            response: 'Completed work',
        })
        expect(result.output).toContain(`Sub-agent invocation ID: ${(result.structuredContent as { invocationId: string }).invocationId}`)
    })

    test('continues only the durable private session transcript', async () => {
        mocks.session = {
            invocation_id: 'invocation',
            agent_id: 'worker',
            history_json: JSON.stringify([
                { role: 'user', content: 'Original private task' },
                { role: 'assistant', content: 'Original private answer' },
            ]),
        }
        const [, continueTool] = buildSubAgentTools({
            subAgents: [{ agentId: 'worker' }],
            conversationId: 'conversation',
            broadcast: vi.fn(),
        })

        await continueTool.execute({ invocationId: 'invocation', instructions: 'Follow up' })

        expect(mocks.executorMessages).toEqual([
            { role: 'user', content: 'Original private task' },
            { role: 'assistant', content: 'Original private answer' },
            { role: 'user', content: 'Follow up' },
        ])
    })

    test('rejects sessions outside the current conversation', async () => {
        const [, continueTool] = buildSubAgentTools({
            subAgents: [{ agentId: 'worker' }],
            conversationId: 'conversation',
            broadcast: vi.fn(),
        })

        const result = await continueTool.execute({ invocationId: 'missing', instructions: 'Follow up' })

        expect(result.success).toBe(false)
        expect(result.error).toContain('exists in this conversation')
    })
})
