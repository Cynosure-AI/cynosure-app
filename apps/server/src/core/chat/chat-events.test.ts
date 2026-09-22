import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { applySchemaMigrations } from '../../db/migrations.js'
import { appendMessageEvents, lastChatEventSequence, listChatEvents } from './chat-events.js'

describe('canonical chat event replay', () => {
  test('persists order and idempotency across conversation boundaries', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applySchemaMigrations(db)
    for (const id of ['a', 'b']) {
      db.prepare('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, 1, 1)').run(id)
    }
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, content_blocks_json, created_at)
      VALUES ('m1', 'a', 'user', 'old', '[{"type":"text","text":"new"}]', 1)
    `).run()
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, created_at)
      VALUES ('m2', 'b', 'assistant', 'other', 2)
    `).run()
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, created_at)
      VALUES ('m3', 'a', 'assistant', 'done', 3)
    `).run()

    const first = appendMessageEvents(db, 'a', 'execution-1', 'm1')
    appendMessageEvents(db, 'b', 'execution-2', 'm2')
    const last = appendMessageEvents(db, 'a', 'execution-1', 'm3')
    expect(appendMessageEvents(db, 'a', 'execution-1', 'm1')).toEqual([])
    expect(first[0]).toMatchObject({
      version: 1, type: 'item.appended', executionId: 'execution-1',
      payload: { item: { id: 'm1', blocks: [{ type: 'text', text: 'new' }] } },
    })
    expect(listChatEvents(db, 'a', first[0].sequence).filter(event => event.type === 'item.appended').map(event => event.payload.item.id))
      .toEqual(['m3'])
    expect(last[0].sequence).toBeGreaterThan(first[0].sequence)
    expect(lastChatEventSequence(db, 'a')).toBe(last[0].sequence)
    expect(listChatEvents(db, 'b', 0).filter(event => event.type === 'item.appended').map(event => event.payload.item.id)).toEqual(['m2'])
    db.close()
  })
})
