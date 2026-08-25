import { afterEach, describe, expect, test, vi } from 'vitest'
import type { LLMGateway } from '../gateway/gateway.js'
import {
  beginDebugContextCapture,
  clearDebugContextCapture,
  completeWithDebugCapture,
  getDebugContextCapture,
  updateDebugContextCapture,
} from './debug-context.js'

const conversationId = 'debug-auxiliary-calls'

afterEach(() => clearDebugContextCapture(conversationId))

describe('debug context auxiliary capture', () => {
  test('labels and records pre-turn request/response phases before main execution', async () => {
    const gateway = {
      complete: vi.fn().mockResolvedValue({
        id: 'response',
        content: '',
        thinking: '',
        toolCalls: [],
        usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
        model: 'router-model',
        provider: 'provider',
        latencyMs: 10,
      }),
    } as unknown as LLMGateway
    beginDebugContextCapture({ conversationId, executionId: 'execution' })

    await completeWithDebugCapture({
      enabled: true,
      conversationId,
      phase: 'task-context',
      label: 'Retrieval and tool query planning',
      gateway,
      providerId: 'router-provider',
      request: {
        messages: [{ role: 'user', content: 'Where is Caroline?' }],
        model: 'router-model',
        toolChoice: { type: 'function', name: 'set_task_context' },
      },
    })
    updateDebugContextCapture(conversationId, { providerId: 'main-provider', model: 'main-model' })

    expect(getDebugContextCapture(conversationId)).toMatchObject({
      providerId: 'main-provider',
      model: 'main-model',
      rounds: [{
        phase: 'task-context',
        label: 'Retrieval and tool query planning',
        providerId: 'router-provider',
        request: { toolChoice: { name: 'set_task_context' } },
        response: { usage: { totalTokens: 15 } },
      }],
    })
  })
})
