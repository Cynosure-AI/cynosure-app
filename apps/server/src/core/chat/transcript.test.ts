import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { applySchemaMigrations } from '../../db/migrations.js'
import { contentBlocksToProviderContent, executionUpdateToChatPayload, latestMessageEventSequence, listChatEvents, messageContentBlocks, messageContentJson, messageTextSql, persistChatEvent, pruneSettledStreamDeltas, slimSettledChatEvents, TOOL_CONTENT_PREVIEW_CHARS, toolContentPreview } from './transcript.js'

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
    const routing = persistChatEvent(db, { conversationId: 'c1', executionId: 'e1', payload: {
      type: 'routing-decision', taskId: 'router', phase: 'memory-context',
      entries: [{ name: 'notes.md', details: { type: 'memory' } }],
    } })!
    expect(listChatEvents(db, 'c1', delta.sequence)).toEqual([routing])
    expect(persistChatEvent(db, { conversationId: 'c1', executionId: 'e1', payload: { type: 'title-updated', title: 'New' } })?.type).toBe('title-updated')
    expect(persistChatEvent(db, { conversationId: 'missing', executionId: 'e1', payload: { type: 'queue-changed' } })).toBeNull()
    expect(listChatEvents(db, 'c1', 0, 1000, ['routing-decision', 'tool-calls'])).toEqual([routing])
    db.close()
  })

  test('prunes stream deltas superseded by a saved message and keeps the in-flight stream', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applySchemaMigrations(db)
    db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c1', 'Chat', 1, 1)
    const delta = (text: string) => persistChatEvent(db, { conversationId: 'c1', executionId: 'e1', payload: { type: 'content-delta', streamId: 'e1', scope: 'main', block: { type: 'text', text } } })!
    expect(pruneSettledStreamDeltas(db, 'c1')).toBe(0)
    delta('Hel')
    delta('lo')
    const saved = persistChatEvent(db, { conversationId: 'c1', executionId: 'e1', payload: { type: 'transcript-item',
      item: { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Hello' }], createdAt: 1 } } })!
    const pending = delta('Next')
    expect(latestMessageEventSequence(db, 'c1')).toBe(saved.sequence)
    expect(pruneSettledStreamDeltas(db, 'c1')).toBe(2)
    expect(listChatEvents(db, 'c1')).toEqual([saved, pending])
    db.close()
  })

  test('stores settled tool output once and reads events back unchanged', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applySchemaMigrations(db)
    db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c1', 'Chat', 1, 1)
    const saveTool = (id: string, callId: string, blocks: unknown[]) => db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, content_blocks_json, tool_call_id, created_at) VALUES (?, 'c1', 'tool', ?, ?, ?, 1)",
    ).run(id, (blocks as Array<{ text?: string }>).map((block) => block.text ?? '').join(''), JSON.stringify(blocks), callId)
    const result = (callId: string, text: string) => ({ type: 'tool-result' as const, id: `result:${callId}`, executionId: 'e1', taskId: 't1',
      iteration: 1, callId, name: 'search', success: true, createdAt: 1,
      content: [{ type: 'text' as const, text }, { type: 'image' as const, artifactId: '/img', url: '/img' }] })
    saveTool('m-same', 'call-same', [{ type: 'text', text: 'full output' }, { type: 'image', artifactId: '/img', url: '/img' }])
    saveTool('m-diff', 'call-diff', [{ type: 'text', text: 'saved differently' }])
    const results = persistChatEvent(db, { conversationId: 'c1', executionId: 'e1', payload: { type: 'tool-results',
      items: [result('call-same', 'full output'), result('call-diff', 'what the card showed')] } })!
    const item = persistChatEvent(db, { conversationId: 'c1', executionId: 'e1', payload: { type: 'transcript-item',
      item: { type: 'message', id: 'm-same', role: 'tool', toolCallId: 'call-same', createdAt: 1,
        content: [{ type: 'text', text: 'full output' }, { type: 'image', artifactId: '/img', url: '/img' }] } } })!

    const args = '{"query":"unique search arguments"}'
    db.prepare(`INSERT INTO messages (id, conversation_id, role, content, content_blocks_json, tool_calls_json, created_at)
      VALUES ('m-assistant', 'c1', 'assistant', 'Searching now', ?, ?, 1)`)
      .run(JSON.stringify([{ type: 'text', text: 'Searching now' }, { type: 'reasoning', text: 'long private reasoning' }]),
        JSON.stringify([{ id: 'call-same', type: 'function', function: { name: 'search', arguments: args } }]))
    const calls = persistChatEvent(db, { conversationId: 'c1', executionId: 'e1', payload: { type: 'tool-calls', items: [{
      type: 'tool-call', id: 'call:call-same', executionId: 'e1', taskId: 't1', iteration: 1, callId: 'call-same', name: 'search', arguments: args, createdAt: 1 }] } })!
    const reply = persistChatEvent(db, { conversationId: 'c1', executionId: 'e1', payload: { type: 'transcript-item',
      item: { type: 'message', id: 'm-assistant', role: 'assistant', createdAt: 1,
        content: [{ type: 'text', text: 'Searching now' }, { type: 'reasoning', text: 'long private reasoning' }] } } })!

    expect(slimSettledChatEvents(db, 'c1')).toBe(4)
    const stored = db.prepare('SELECT event_json FROM chat_events ORDER BY sequence').pluck().all() as string[]
    expect(stored.every((json) => !json.includes('full output') && !json.includes('unique search arguments') && !json.includes('private reasoning'))).toBe(true)
    // A copy that differs from the saved message is the only record of what was shown, so it stays.
    expect(stored[0]).toContain('what the card showed')
    expect(listChatEvents(db, 'c1')).toEqual([results, item, calls, reply])
    expect(slimSettledChatEvents(db, 'c1')).toBe(0)
    db.close()
  })

  test('reads full tool output from content blocks behind a stored preview', () => {
    const db = new Database(':memory:')
    applySchemaMigrations(db)
    db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', 'Chat', 1, 1)").run()
    const output = 'x'.repeat(TOOL_CONTENT_PREVIEW_CHARS + 50)
    const insert = db.prepare("INSERT INTO messages (id, conversation_id, role, content, content_blocks_json, created_at) VALUES (?, 'c1', ?, ?, ?, 1)")
    insert.run('tool', 'tool', toolContentPreview(output), messageContentJson({ id: 'tool', content: output, structuredContent: { ok: true } }))
    insert.run('assistant', 'assistant', 'Short reply', null)
    expect(toolContentPreview(output)).toHaveLength(TOOL_CONTENT_PREVIEW_CHARS + 1)
    expect(toolContentPreview('short')).toBe('short')
    const text = db.prepare(`SELECT id, ${messageTextSql()} AS text FROM messages ORDER BY id`).all()
    expect(text).toEqual([{ id: 'assistant', text: 'Short reply' }, { id: 'tool', text: output }])
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
