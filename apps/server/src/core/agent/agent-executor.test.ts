import { describe, expect, test, vi } from 'vitest'
import { AgentExecutor, MaxToolRoundsExceededError } from './agent-executor.js'
import type { LLMGateway } from '../gateway/gateway.js'
import { IncompleteModelResponseError, type StreamChunk, type ToolDefinition } from '../gateway/providers/base.provider.js'
import { beginDebugContextCapture, clearDebugContextCapture, getDebugContextCapture } from '../chat/debug-context.js'

describe('AgentExecutor cancellation', () => {
  test('passes cancellation to an in-flight tool and stops before another model round', async () => {
    let toolSignal: AbortSignal | undefined
    let markToolStarted: (() => void) | undefined
    const toolStarted = new Promise<void>((resolve) => { markToolStarted = resolve })

    const tool: ToolDefinition = {
      name: 'slow_tool',
      description: 'Waits until cancelled',
      parameters: { type: 'object', properties: {} },
      timeout: 60_000,
      execute: async (_params, signal) => {
        toolSignal = signal
        markToolStarted?.()
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        return { success: true, output: 'unexpected' }
      },
    }

    const streamComplete = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {
      yield {
        toolCalls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'slow_tool', arguments: '{}' },
        }],
        done: true,
      }
    })())
    const controller = new AbortController()
    const executor = new AgentExecutor({
      gateway: { streamComplete } as unknown as LLMGateway,
      tools: [tool],
      conversationId: 'conversation-1',
      broadcast: vi.fn(),
      model: 'test-model',
      signal: controller.signal,
      saveMessages: false,
      emitEvents: false,
    })

    const run = executor.run([{ role: 'user', content: 'start' }])
    await toolStarted
    controller.abort()

    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(toolSignal?.aborted).toBe(true)
    expect(streamComplete).toHaveBeenCalledTimes(1)
  })
})

describe('AgentExecutor tool-loop safety', () => {
  test('keeps the completed placeholder for a successful empty post-tool response', async () => {
    const tool: ToolDefinition = {
      name: 'check', description: 'check', parameters: { type: 'object', properties: {} }, timeout: 1_000,
      execute: async () => ({ success: true, output: 'no notification needed' }),
    }
    let call = 0
    const streamComplete = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {
      if (call++ === 0) {
        yield { toolCalls: [{ id: 'check-1', type: 'function', function: { name: 'check', arguments: '{}' } }], done: true }
        return
      }
      yield { done: true }
    })())
    const executor = new AgentExecutor({
      gateway: { streamComplete } as unknown as LLMGateway,
      tools: [tool], conversationId: 'empty-success', broadcast: vi.fn(), model: 'test',
      saveMessages: false, emitEvents: false,
    })

    const result = await executor.run([{ role: 'user', content: 'check quietly' }])

    expect(result.content).toBe('(completed)')
  })

  test('retries an interrupted post-tool model round without repeating the tool', async () => {
    const execute = vi.fn(async () => ({ success: true, output: 'tool result' }))
    const tool: ToolDefinition = {
      name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: {} }, timeout: 1_000,
      execute,
    }
    let call = 0
    const streamComplete = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {
      call++
      if (call === 1) {
        yield { toolCalls: [{ id: 'lookup-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }], done: true }
        return
      }
      if (call === 2) {
        yield { content: 'partial response', done: false }
        throw new Error('Upstream idle timeout exceeded')
      }
      yield { content: 'finished after retry', done: true }
    })())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const executor = new AgentExecutor({
      gateway: { streamComplete } as unknown as LLMGateway,
      tools: [tool], conversationId: 'retry-round', broadcast: vi.fn(), model: 'test',
      saveMessages: false, emitEvents: false,
    })

    const result = await executor.run([{ role: 'user', content: 'go' }])

    expect(result.content).toBe('finished after retry')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(streamComplete).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  test('fails after repeated post-tool stream interruption instead of completing', async () => {
    const execute = vi.fn(async () => ({ success: true, output: 'tool result' }))
    const tool: ToolDefinition = {
      name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: {} }, timeout: 1_000,
      execute,
    }
    let call = 0
    const streamComplete = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {
      if (call++ === 0) {
        yield { toolCalls: [{ id: 'lookup-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }], done: true }
        return
      }
      throw new Error('Upstream idle timeout exceeded')
    })())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const executor = new AgentExecutor({
      gateway: { streamComplete } as unknown as LLMGateway,
      tools: [tool], conversationId: 'failed-retry', broadcast: vi.fn(), model: 'test',
      saveMessages: false, emitEvents: false,
    })

    await expect(executor.run([{ role: 'user', content: 'go' }]))
      .rejects.toThrow('Upstream idle timeout exceeded')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(streamComplete).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })

  test('does not retry a deterministic incomplete provider response', async () => {
    const execute = vi.fn(async () => ({ success: true, output: 'tool result' }))
    const tool: ToolDefinition = {
      name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: {} }, timeout: 1_000,
      execute,
    }
    let call = 0
    const streamComplete = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {
      if (call++ === 0) {
        yield { toolCalls: [{ id: 'lookup-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }], done: true }
        return
      }
      throw new IncompleteModelResponseError('max_tokens')
    })())
    const executor = new AgentExecutor({
      gateway: { streamComplete } as unknown as LLMGateway,
      tools: [tool], conversationId: 'incomplete', broadcast: vi.fn(), model: 'test',
      saveMessages: false, emitEvents: false,
    })

    await expect(executor.run([{ role: 'user', content: 'go' }]))
      .rejects.toBeInstanceOf(IncompleteModelResponseError)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(streamComplete).toHaveBeenCalledTimes(2)
  })

  test('rejects an initial stream that ends without a terminal event', async () => {
    const streamComplete = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {
      yield { content: 'partial', done: false }
    })())
    const executor = new AgentExecutor({
      gateway: { streamComplete } as unknown as LLMGateway,
      tools: [], conversationId: 'unexpected-eof', broadcast: vi.fn(), model: 'test',
      saveMessages: false, emitEvents: false,
    })

    await expect(executor.run([{ role: 'user', content: 'go' }]))
      .rejects.toThrow('before a terminal completion event')
    expect(streamComplete).toHaveBeenCalledOnce()
  })

  test('validates tool arguments before execution', async () => {
    const execute = vi.fn(async () => ({ success: true, output: 'unexpected' }))
    const tool: ToolDefinition = {
      name: 'strict_tool',
      description: 'Requires a value',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      timeout: 1_000,
      execute,
    }
    let call = 0
    const streamComplete = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {
      if (call++ === 0) {
        yield { toolCalls: [{ id: 'bad', type: 'function', function: { name: 'strict_tool', arguments: '{"extra":true}' } }], done: true }
      } else {
        yield { content: 'recovered', done: true }
      }
    })())
    const executor = new AgentExecutor({
      gateway: { streamComplete } as unknown as LLMGateway,
      tools: [tool], conversationId: 'validation', broadcast: vi.fn(), model: 'test',
      saveMessages: false, emitEvents: false,
    })

    const result = await executor.run([{ role: 'user', content: 'go' }])
    expect(result.content).toBe('recovered')
    expect(execute).not.toHaveBeenCalled()
  })

  test('runs read-only calls concurrently but waits before a mutating call', async () => {
    const events: string[] = []
    const makeRead = (name: string): ToolDefinition => ({
      name, description: name, parameters: { type: 'object', properties: {} }, timeout: 1_000,
      execution: { readOnly: true },
      execute: async () => {
        events.push(`${name}:start`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        events.push(`${name}:end`)
        return { success: true, output: name }
      },
    })
    const write: ToolDefinition = {
      name: 'write', description: 'write', parameters: { type: 'object', properties: {} }, timeout: 1_000,
      execution: { readOnly: false },
      execute: async () => { events.push('write:start'); return { success: true, output: 'written' } },
    }
    let call = 0
    const streamComplete = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {
      if (call++ === 0) {
        yield {
          toolCalls: ['read_a', 'read_b', 'write'].map((name) => ({ id: name, type: 'function' as const, function: { name, arguments: '{}' } })),
          done: true,
        }
      } else yield { content: 'done', done: true }
    })())
    const executor = new AgentExecutor({
      gateway: { streamComplete } as unknown as LLMGateway,
      tools: [makeRead('read_a'), makeRead('read_b'), write], conversationId: 'schedule', broadcast: vi.fn(), model: 'test',
      saveMessages: false, emitEvents: false,
    })

    await executor.run([{ role: 'user', content: 'go' }])
    expect(events.slice(0, 2)).toEqual(['read_a:start', 'read_b:start'])
    expect(events.indexOf('write:start')).toBeGreaterThan(events.indexOf('read_a:end'))
    expect(events.indexOf('write:start')).toBeGreaterThan(events.indexOf('read_b:end'))
  })

  test('throws a distinct error when tool rounds are exhausted', async () => {
    const tool: ToolDefinition = {
      name: 'again', description: 'again', parameters: { type: 'object', properties: {} }, timeout: 1_000,
      execute: async () => ({ success: true, output: 'again' }),
    }
    const streamComplete = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {
      yield { toolCalls: [{ id: String(Math.random()), type: 'function', function: { name: 'again', arguments: '{}' } }], done: true }
    })())
    const executor = new AgentExecutor({
      gateway: { streamComplete } as unknown as LLMGateway,
      tools: [tool], conversationId: 'max-rounds', broadcast: vi.fn(), model: 'test', maxRounds: 1,
      saveMessages: false, emitEvents: false,
    })

    await expect(executor.run([{ role: 'user', content: 'loop' }])).rejects.toBeInstanceOf(MaxToolRoundsExceededError)
  })
})

describe('AgentExecutor debug context capture', () => {
  test('captures the exact gateway input and provider-visible output for every round', async () => {
    const conversationId = 'debug-context-rounds'
    beginDebugContextCapture({
      conversationId,
      executionId: 'execution-1',
      providerId: 'provider-1',
      model: 'test-model',
      contextWindow: 8_192,
      contextStrategy: 'sliding-window',
    })

    const tool: ToolDefinition = {
      name: 'lookup',
      title: 'Lookup',
      description: 'Looks up a value',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      timeout: 1_000,
      execute: async () => ({ success: true, output: 'tool result' }),
    }
    let call = 0
    const streamComplete = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {
      if (call++ === 0) {
        yield { thinking: 'I should look this up. ', done: false }
        yield {
          toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"value"}' } }],
          usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
          done: true,
        }
      } else {
        yield { content: 'Final answer', thinking: 'The tool answered.', usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 }, done: true }
      }
    })())
    const executor = new AgentExecutor({
      gateway: { streamComplete } as unknown as LLMGateway,
      tools: [tool],
      conversationId,
      broadcast: vi.fn(),
      providerId: 'provider-1',
      model: 'test-model',
      thinkingEnabled: true,
      reasoningEffort: 'high',
      saveMessages: false,
      emitEvents: false,
      debugContextEnabled: true,
    })

    await executor.run([
      { role: 'system', content: 'System instructions and memory' },
      { role: 'user', content: 'Question' },
    ])

    const capture = getDebugContextCapture(conversationId)
    expect(capture?.rounds).toHaveLength(2)
    expect(capture?.rounds[0].request.messages).toEqual([
      { role: 'system', content: 'System instructions and memory' },
      { role: 'user', content: 'Question' },
    ])
    expect(capture?.rounds[0].request.tools[0]).toEqual({
      name: 'lookup',
      title: 'Lookup',
      description: 'Looks up a value',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    })
    expect(capture?.rounds[0].response?.thinking).toBe('I should look this up. ')
    expect(capture?.rounds[1].request.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: 'tool result',
      toolCallId: 'call-1',
    })
    expect(capture?.rounds[1].response?.content).toBe('Final answer')
    expect(capture?.rounds[1].response?.thinking).toBe('The tool answered.')

    clearDebugContextCapture(conversationId)
  })
})
