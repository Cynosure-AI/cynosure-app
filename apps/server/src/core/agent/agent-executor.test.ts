import { describe, expect, test, vi } from 'vitest'
import { AgentExecutor } from './agent-executor.js'
import type { LLMGateway } from '../gateway/gateway.js'
import type { StreamChunk, ToolDefinition } from '../gateway/providers/base.provider.js'

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
