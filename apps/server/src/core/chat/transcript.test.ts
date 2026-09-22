import { describe, expect, test } from 'vitest'
import type { StoredMessageDto } from '@shared/types'
import { blocksFromStoredMessage, readContentBlocks, toTranscriptItems } from './transcript.js'

const legacy: StoredMessageDto = {
  id: 'message-1',
  conversationId: 'chat-1',
  role: 'user',
  content: 'Describe this',
  thinking: 'reasoning',
  imageDataUrls: ['/api/files?image=1'],
  audioDataUrls: ['/api/files?audio=1'],
  fileAttachments: [{ name: 'notes.pdf', href: '/api/files?file=1' }],
  createdAt: 10,
}

describe('chat transcript compatibility', () => {
  test('projects old media columns without losing content or ordering', () => {
    const blocks = blocksFromStoredMessage(legacy)
    expect(blocks.map(block => block.type)).toEqual(['text', 'reasoning', 'image', 'audio', 'file'])
    expect(readContentBlocks(null, legacy)).toEqual(blocks)
    expect(readContentBlocks('{broken', legacy)).toEqual(blocks)
    expect(toTranscriptItems({ ...legacy, blocks })[0]).toMatchObject({
      type: 'message', id: 'message-1', blocks,
    })
  })

  test('uses stored canonical blocks when present', () => {
    expect(readContentBlocks('[{"type":"text","text":"canonical"}]', legacy))
      .toEqual([{ type: 'text', text: 'canonical' }])
  })

  test('preserves tool call identity and matching tool result', () => {
    const call: StoredMessageDto = {
      id: 'assistant-1', conversationId: 'chat-1', role: 'assistant',
      content: '', createdAt: 11, maInvocationId: 'delegate-1',
      toolCalls: [{ id: 'call-1', function: { name: 'search', arguments: '{"q":"hi"}' } }],
    }
    const result: StoredMessageDto = {
      id: 'result-1', conversationId: 'chat-1', role: 'tool',
      content: 'found', toolCallId: 'call-1', createdAt: 12,
      maInvocationId: 'delegate-1',
    }
    expect(toTranscriptItems(call)[1]).toMatchObject({
      type: 'tool-call', callId: 'call-1', name: 'search',
      arguments: { q: 'hi' }, invocationId: 'delegate-1',
    })
    expect(toTranscriptItems(result)[0]).toMatchObject({
      type: 'tool-result', callId: 'call-1', invocationId: 'delegate-1',
    })
  })
})
