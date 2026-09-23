import { expect, test } from 'vitest'
import type { MessageItem } from '@shared/types'
import { toDisplayMessage } from './message-view'

test('projects the same canonical message for loading and live replay', () => {
  const item: MessageItem = {
    type: 'message', id: 'message-1', role: 'assistant', createdAt: 42,
    invocationId: 'worker-1', toolCallIds: ['call-1'],
    content: [
      { type: 'text', text: 'Here is the result' },
      { type: 'reasoning', text: 'Checked the source' },
      { type: 'image', artifactId: 'image-1', url: '/api/files?path=image' },
      { type: 'file', artifactId: 'file-1', name: 'report.pdf', url: '/api/files?path=report' },
      { type: 'structured', value: { count: 2 } },
    ],
  }
  expect(toDisplayMessage(item, 9)).toEqual({
    id: 'message-1', sequence: 9, toolCallIds: ['call-1'], role: 'assistant', createdAt: 42,
    content: 'Here is the result', thinking: 'Checked the source',
    imageDataUrls: ['/api/files?path=image'], videoDataUrls: [], audioDataUrls: [],
    fileAttachments: [{ name: 'report.pdf', href: '/api/files?path=report' }],
    structuredContent: { count: 2 }, maInvocationId: 'worker-1',
    contextEvidence: undefined, agentId: undefined, agentName: undefined,
    agentIconUrl: undefined, maCodename: undefined, maAgentName: undefined,
    provider: undefined, model: undefined, promptTokens: undefined,
    completionTokens: undefined, contextTokens: undefined, latencyMs: undefined,
  })
})

test('restores a saved assistant error as an error bubble', () => {
  const item: MessageItem = {
    type: 'message', id: 'error-message', role: 'assistant', isError: true, createdAt: 42,
    content: [{ type: 'text', text: 'Generated image rejected by content moderation.' }],
  }
  expect(toDisplayMessage(item)).toMatchObject({
    id: 'error-message', isError: true, content: 'Generated image rejected by content moderation.',
  })
})
