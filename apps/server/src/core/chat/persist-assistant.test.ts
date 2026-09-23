import Database from 'better-sqlite3'
import { describe, expect, test, vi } from 'vitest'
import { applySchemaMigrations } from '../../db/migrations.js'
import { persistAssistantTurn } from './persist-assistant.js'
import { buildConversationHistory } from './message-history.js'

describe('persistAssistantTurn', () => {
  test('stores multimodal content and publishes the same message', () => {
    const db = new Database(':memory:')
    applySchemaMigrations(db)
    db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c1', 'Chat', 1, 1)
    const broadcast = vi.fn()
    const message = persistAssistantTurn(db, broadcast, {
      conversationId: 'c1', streamId: 's1', content: 'Generated video.', videos: ['/video/1'],
      generatedMedia: true, provider: 'p1', model: 'm1', startedAt: 1,
    })
    const row = db.prepare('SELECT content, content_blocks_json, generated_media, provider, model FROM messages WHERE id = ?')
      .get(message.id) as { content: string; content_blocks_json: string; generated_media: number; provider: string; model: string }
    expect(row).toMatchObject({ content: 'Generated video.', generated_media: 1, provider: 'p1', model: 'm1' })
    expect(JSON.parse(row.content_blocks_json)).toEqual([
      { type: 'text', text: 'Generated video.' },
      { type: 'video', artifactId: '/video/1', url: '/video/1' },
    ])
    expect(broadcast).toHaveBeenCalledWith('chat:event', {
      conversationId: 'c1', executionId: 's1', payload: {
        type: 'transcript-item', item: expect.objectContaining({
          type: 'message', id: message.id, role: 'assistant',
          content: [
            { type: 'text', text: 'Generated video.' },
            { type: 'video', artifactId: '/video/1', url: '/video/1' },
          ],
        }),
      },
    })
    db.close()
  })

  test('persists errors for reload without sending them back to the model', () => {
    const db = new Database(':memory:')
    applySchemaMigrations(db)
    db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c1', 'Chat', 1, 1)
    const broadcast = vi.fn()
    const message = persistAssistantTurn(db, broadcast, {
      conversationId: 'c1', streamId: 's1', content: 'Generated image rejected by content moderation.', isError: true,
    })
    const row = db.prepare('SELECT content, is_error FROM messages WHERE id = ?').get(message.id)
    expect(row).toEqual({ content: 'Generated image rejected by content moderation.', is_error: 1 })
    expect(broadcast).toHaveBeenCalledWith('chat:event', expect.objectContaining({
      payload: { type: 'transcript-item', item: expect.objectContaining({ isError: true }) },
    }))
    const history = buildConversationHistory({ db, conversationId: 'c1', mainAgentId: null, inlineAttachmentTextLimit: 24_000 })
    expect(history.messages).toEqual([])
    db.close()
  })
})
