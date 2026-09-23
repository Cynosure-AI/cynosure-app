import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { applySchemaMigrations } from '../../db/migrations.js'
import { contentBlocksToProviderContent, executionUpdateToChatPayload, listChatEvents, messageContentBlocks, persistChatEvent } from './transcript.js'

describe('canonical chat transcript', () => {
  test('adapts persisted media fields without losing their order within a modality', () => {
    expect(messageContentBlocks({
      id: 'm1', content: 'hello', thinking: 'considering',
      imageDataUrls: ['/image/1'], videoDataUrls: ['/video/1'], audioDataUrls: ['/audio/1'],
      fileAttachments: [{ name: 'notes.txt', href: '/file/1' }], structuredContent: { ok: true },
    })).toEqual([
      { type: 'text', text: 'hello' }, { type: 'reasoning', text: 'considering' },
      { type: 'image', artifactId: '/image/1', url: '/image/1' },
      { type: 'video', artifactId: '/video/1', url: '/video/1' },
      { type: 'audio', artifactId: '/audio/1', url: '/audio/1' },
      { type: 'file', artifactId: '/file/1', name: 'notes.txt', url: '/file/1' },
      { type: 'structured', value: { ok: true } },
    ])
  })

  test('persists ordered events and resumes after a sequence cursor', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applySchemaMigrations(db)
    db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c1', 'Chat', 1, 1)
    const start = persistChatEvent(db, { conversationId: 'c1', executionId: 'e1', payload: { type: 'stream-start', streamId: 'e1', scope: 'main' } })!
    const delta = persistChatEvent(db, { conversationId: 'c1', executionId: 'e1', payload: { type: 'content-delta', streamId: 'e1', scope: 'main', block: { type: 'text', text: 'Hi' } } })!
    expect(delta.sequence).toBeGreaterThan(start.sequence)
    expect(listChatEvents(db, 'c1', start.sequence)).toEqual([delta])
    expect(persistChatEvent(db, { conversationId: 'c1', executionId: 'e1', payload: { type: 'title-updated', title: 'New' } })?.type).toBe('title-updated')
    expect(persistChatEvent(db, { conversationId: 'missing', executionId: 'e1', payload: { type: 'queue-changed' } })).toBeNull()
    db.close()
  })

  test('converts only supported blocks at the provider boundary', () => {
    expect(contentBlocksToProviderContent([
      { type: 'text', text: 'describe' },
      { type: 'reasoning', text: 'private' },
      { type: 'image', artifactId: 'a', url: '/artifact/a' },
      { type: 'structured', value: { ignored: true } },
    ], (url) => `resolved:${url}`)).toEqual([
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: 'resolved:/artifact/a' } },
    ])
  })

  test('links delegated tool results to calls by stable IDs', () => {
    const db = new Database(':memory:')
    applySchemaMigrations(db)
    db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c1', 'Chat', 1, 1)
    const common = { conversationId: 'c1', taskId: 'task1', executionId: 'exec1', iteration: 2, maInvocationId: 'parent' }
    const calls = executionUpdateToChatPayload('step:tools-chosen', { ...common,
      toolCalls: [{ id: 'call1', name: 'spawn_subagent', arguments: '{"invocationId":"child"}' }] })
    const results = executionUpdateToChatPayload('step:executed', { ...common,
      results: [{ toolCallId: 'call1', success: true, output: 'done', structuredContent: { invocationId: 'child' } }] })
    expect(calls?.type).toBe('tool-calls')
    expect(results?.type).toBe('tool-results')
    if (calls?.type === 'tool-calls' && results?.type === 'tool-results') {
      expect(calls.items[0]).toMatchObject({ callId: 'call1', invocationId: 'child', parentInvocationId: 'parent' })
      expect(results.items[0]).toMatchObject({ callId: 'call1', invocationId: 'child', success: true })
    }
    db.close()
  })

  test('records execution status with its original task identity', () => {
    const db = new Database(':memory:')
    applySchemaMigrations(db)
    db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c1', 'Chat', 1, 1)
    const step = executionUpdateToChatPayload('step:status', {
      conversationId: 'c1', executionId: 'exec1', taskId: 'task1', iteration: 2,
      status: 'executing', maInvocationId: 'child',
    })
    expect(step).toMatchObject({ type: 'execution-step', taskId: 'task1', iteration: 2, invocationId: 'child' })
    const end = executionUpdateToChatPayload('task:completed', {
      conversationId: 'c1', executionId: 'exec1', taskId: 'task1',
    })
    expect(end).toMatchObject({ type: 'transcript-item', item: { type: 'execution-marker', taskId: 'task1', status: 'completed' } })
    db.close()
  })
})
