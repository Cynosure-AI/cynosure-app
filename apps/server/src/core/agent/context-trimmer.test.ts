import { describe, expect, test, vi } from 'vitest'
import type { LLMGateway } from '../gateway/gateway.js'
import type { CompletionRequest, StreamChunk, ToolDefinition } from '../gateway/providers/base.provider.js'
import { AgentExecutor } from './agent-executor.js'
import {
    calculateContextBudget,
    ContextBudgetExceededError,
    estimateTotalTokens,
    estimateToolDefinitionTokens,
    trimMessagesToContextLimit,
} from './context-trimmer.js'

function tool(name: string, description: string): ToolDefinition {
    return {
        name,
        description,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: { query: { type: 'string', description: 'Search query' } },
        },
        timeout: 1_000,
        execute: async () => ({ success: true, output: 'ok' }),
    }
}

describe('central context budget', () => {
    test('subtracts system messages, complete tool definitions, and explicit reserves', () => {
        const messages = [
            { role: 'system' as const, content: 'Stable instructions' },
            { role: 'user' as const, content: 'Question' },
        ]
        const tools = [tool('search', 'Searches documents')]
        const budget = calculateContextBudget({
            contextWindow: 10_000,
            messages,
            tools,
            requestedOutputTokens: 1_000,
            thinkingEnabled: false,
            safetyMargin: 500,
        })

        expect(budget.estimatedSystemTokens).toBe(estimateTotalTokens([messages[0]]))
        expect(budget.estimatedToolDefinitionTokens).toBe(estimateToolDefinitionTokens(tools))
        expect(budget.availableHistory).toBe(
            10_000
            - budget.estimatedSystemTokens
            - budget.estimatedToolDefinitionTokens
            - 1_000
            - 0
            - 500,
        )
    })

    test('tool schemas reduce the history that can be retained', () => {
        const messages = [
            { role: 'system' as const, content: 'Instructions' },
            { role: 'user' as const, content: `old:${'x'.repeat(8_000)}` },
            { role: 'assistant' as const, content: 'Earlier answer' },
            { role: 'user' as const, content: 'current request' },
        ]
        const options = {
            requestedOutputTokens: 500,
            thinkingEnabled: false,
            safetyMargin: 100,
        }

        expect(trimMessagesToContextLimit(messages, 4_000, options)).toEqual(messages)

        const trimmed = trimMessagesToContextLimit(messages, 4_000, {
            ...options,
            tools: [tool('large_tool', 'z'.repeat(6_000))],
        })
        expect(trimmed.some((message) => typeof message.content === 'string' && message.content.startsWith('old:'))).toBe(false)
        expect(trimmed.at(-1)?.content).toBe('current request')
    })

    test('throws a configuration error instead of dropping the current request when system messages exhaust the budget', () => {
        const messages = [
            { role: 'system' as const, content: 's'.repeat(4_000) },
            { role: 'user' as const, content: 'must not be dropped' },
        ]

        expect(() => trimMessagesToContextLimit(messages, 1_000, {
            requestedOutputTokens: 100,
            thinkingEnabled: false,
            safetyMargin: 100,
        })).toThrowError(ContextBudgetExceededError)
        expect(() => trimMessagesToContextLimit(messages, 1_000, {
            requestedOutputTokens: 100,
            thinkingEnabled: false,
            safetyMargin: 100,
        })).toThrow(/System messages alone/)
    })
})

describe('AgentExecutor dynamic context budget', () => {
    test('recalculates immediately after expand_available_toolset loads tool schemas', async () => {
        const loadedTool = tool('dynamically_loaded', 'd'.repeat(8_000))
        const expandTool: ToolDefinition = {
            ...tool('expand_available_toolset', 'Loads additional tools'),
            execute: async () => ({
                success: true,
                output: 'Loaded one tool',
                loadedTools: [loadedTool],
            }),
        }
        const requests: CompletionRequest[] = []
        let round = 0
        const streamComplete = vi.fn((request: CompletionRequest) => {
            requests.push(request)
            return (async function* (): AsyncIterable<StreamChunk> {
                if (round++ === 0) {
                    yield {
                        toolCalls: [{
                            id: 'expand-1',
                            type: 'function',
                            function: { name: 'expand_available_toolset', arguments: '{}' },
                        }],
                        done: true,
                    }
                    return
                }
                yield { content: 'done', done: true }
            })()
        })
        const executor = new AgentExecutor({
            gateway: { streamComplete } as unknown as LLMGateway,
            tools: [expandTool],
            conversationId: 'dynamic-budget',
            broadcast: vi.fn(),
            model: 'test',
            contextWindow: 6_000,
            thinkingEnabled: false,
            saveMessages: false,
            emitEvents: false,
        })

        await executor.run([
            { role: 'system', content: 'Instructions' },
            { role: 'user', content: `old:${'x'.repeat(12_000)}` },
            { role: 'assistant', content: 'Earlier answer' },
            { role: 'user', content: 'load more tools' },
        ])

        expect(requests).toHaveLength(2)
        expect(requests[1].tools?.map(({ name }) => name)).toContain('dynamically_loaded')
        expect(requests[1].messages.some((message) =>
            typeof message.content === 'string' && message.content.startsWith('old:'),
        )).toBe(false)
        expect(requests[1].messages.some((message) => message.content === 'load more tools')).toBe(true)
        expect(requests[1].maxTokens).toBe(900)
    })
})
