import { beforeEach, describe, expect, test, vi } from 'vitest'

const { complete, run, prepare, gateway } = vi.hoisted(() => {
  const complete = vi.fn()
  const run = vi.fn()
  const prepare = vi.fn(() => ({ run }))
  const gateway = {
    complete,
    getProvider: vi.fn(),
    getLastUsedProvider: vi.fn(() => ({
      config: { id: 'groq', defaultModel: 'reasoning-model' },
    })),
  }
  return { complete, run, prepare, gateway }
})

vi.mock('../../db/database.js', () => ({
  getDb: () => ({ prepare }),
}))

vi.mock('../gateway/gateway.js', () => ({
  getGateway: () => gateway,
}))

import { generateTitle } from './post-execution.js'

describe('title generation', () => {
  beforeEach(() => {
    complete.mockReset()
    complete.mockResolvedValue({ content: 'Fix Persistent Chat Drafts' })
    run.mockReset()
    prepare.mockClear()
    gateway.getProvider.mockReset()
    gateway.getLastUsedProvider.mockClear()
  })

  test('generates a title without imposing a completion token limit', async () => {
    const broadcast = vi.fn()

    await generateTitle({
      conversationId: 'conversation-1',
      userMessage: 'Please fix persistent chat drafts',
      assistantResponse: 'The composer now restores saved drafts.',
      broadcast,
    })

    const request = complete.mock.calls[0][0]
    expect(request).toMatchObject({
      model: 'reasoning-model',
      thinkingEnabled: false,
    })
    expect(request).not.toHaveProperty('maxTokens')
    expect(run).toHaveBeenCalledWith(
      'Fix Persistent Chat Drafts',
      expect.any(Number),
      'conversation-1',
    )
    expect(broadcast).toHaveBeenCalledWith('chat:title-updated', {
      conversationId: 'conversation-1',
      title: 'Fix Persistent Chat Drafts',
    })
  })
})
