import { beforeEach, describe, expect, test, vi } from 'vitest'

const { complete, run, prepare, gateway } = vi.hoisted(() => {
  const complete = vi.fn()
  const run = vi.fn()
  const prepare = vi.fn((_sql?: string) => ({ run, get: vi.fn() }))
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

import { buildFallbackTitle, generateQuickResponses, generateTitle, parseQuickResponses } from './post-execution.js'

describe('title generation', () => {
  beforeEach(() => {
    complete.mockReset()
    complete.mockResolvedValue({ content: 'Fix Persistent Chat Drafts' })
    run.mockReset()
    prepare.mockClear()
    gateway.getProvider.mockReset()
    gateway.getLastUsedProvider.mockClear()
  })

  test('applies a fallback title immediately and upgrades it with the LLM result', async () => {
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
      // Mandatory-reasoning models need room for hidden reasoning tokens before
      // they emit the short visible title.
      maxTokens: 512,
    })
    // Fallback title is broadcast first, then the LLM title replaces it.
    expect(broadcast).toHaveBeenCalledWith('chat:title-updated', {
      conversationId: 'conversation-1',
      title: 'Fix Persistent Chat Drafts',
    })
    expect(run).toHaveBeenCalledWith(
      'Fix Persistent Chat Drafts',
      expect.any(Number),
      'conversation-1',
    )
  })

  test('keeps the fallback title when the LLM call fails or times out', async () => {
    complete.mockRejectedValueOnce(new Error('timeout'))
    const broadcast = vi.fn()

    await generateTitle({
      conversationId: 'conversation-2',
      userMessage: 'Explain how database indexes work',
      assistantResponse: 'Indexes are data structures that...',
      broadcast,
    })

    expect(broadcast).toHaveBeenCalledWith('chat:title-updated', {
      conversationId: 'conversation-2',
      title: 'Explain How Database Indexes Work',
    })
  })

  test('preserves Unicode letters in fallback titles', () => {
    expect(buildFallbackTitle('Wär öfters übermäßig')).toBe('Wär Öfters Übermäßig')
    expect(buildFallbackTitle('Über München und Köln')).toBe('Über München Und Köln')
    expect(buildFallbackTitle('日本語のタイトル')).toBe('日本語のタイトル')
  })

  test('supports generated titles up to 20 words and requests the same limit', async () => {
    const title = 'Add More Detail To Chat Titles For Better Context In Project History'
    complete.mockResolvedValueOnce({ content: title })

    await generateTitle({
      conversationId: 'conversation-3',
      userMessage: 'Build a detailed account migration plan',
      assistantResponse: 'Here is the migration plan.',
      broadcast: vi.fn(),
    })

    expect(complete.mock.calls[0][0].messages[0].content).toContain('3-20 words')
    expect(run).toHaveBeenLastCalledWith(
      title,
      expect.any(Number),
      'conversation-3',
    )
  })
})

describe('quick response parsing', () => {
  beforeEach(() => {
    complete.mockReset()
    run.mockReset()
    prepare.mockReset()
    prepare.mockImplementation((sql?: string) => ({
      run,
      get: vi.fn(() => sql?.includes("role = 'assistant'") ? { id: 'assistant-1' } : undefined),
    }))
  })

  test('accepts JSON, removes duplicates, and caps suggestions at three', () => {
    expect(parseQuickResponses(JSON.stringify([
      'Show me an example',
      'Explain the tradeoffs',
      'show me an example',
      'What should I do next?',
      'A fourth unique option',
    ]))).toEqual([
      'Show me an example',
      'Explain the tradeoffs',
      'What should I do next?',
    ])
  })

  test('tolerates fenced objects and simple list output', () => {
    expect(parseQuickResponses('```json\n{"suggestions":["One", "Two"]}\n```')).toEqual(['One', 'Two'])
    expect(parseQuickResponses('- First\n2. Second')).toEqual(['First', 'Second'])
  })

  test('persists and broadcasts suggestions for the latest assistant message', async () => {
    complete.mockResolvedValueOnce({ content: '["Show an example", "Explain the tradeoffs"]' })
    const broadcast = vi.fn()

    await generateQuickResponses({
      conversationId: 'conversation-1',
      messageId: 'assistant-1',
      userMessage: 'How does this work?',
      assistantResponse: 'It works in two stages.',
      broadcast,
    })

    expect(broadcast).toHaveBeenCalledWith('chat:post-action', {
      conversationId: 'conversation-1',
      action: 'generating-quick-responses',
      status: 'started',
    })
    expect(run).toHaveBeenCalledWith(
      '["Show an example","Explain the tradeoffs"]',
      'assistant-1',
      'conversation-1',
    )
    expect(broadcast).toHaveBeenCalledWith('chat:quick-responses', {
      conversationId: 'conversation-1',
      messageId: 'assistant-1',
      suggestions: ['Show an example', 'Explain the tradeoffs'],
    })
  })
})
