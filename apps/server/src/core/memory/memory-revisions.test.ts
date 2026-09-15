import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { closeDb, getDb } from '../../db/database.js'
import {
  getMemoryDocument,
  getMemoryRevision,
  listMemoryRevisions,
  markMemoryDocumentDeleted,
  markMemoryCategoriesDeleted,
  recordMemoryRevision,
  inlineMemoryDiff,
  unifiedMemoryDiff,
  updateMemoryDocumentLocation,
} from './memory-revisions.js'

describe('memory revision snapshots', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cynosure-memory-revisions-'))
    process.env.CYNOSURE_DATA_DIR = dataDir
    getDb()
  })

  afterEach(() => {
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('stores immutable snapshots, provenance, and line diffs', () => {
    const first = recordMemoryRevision({
      documentId: 'doc-1', documentRef: 'profile#stable', categoryId: 'uncategorized',
      fileName: 'Veronica Flowers - General Profile.md', content: 'Lives in Berlin.\n',
      context: { source: 'dream', conversationId: 'chat-1', agentId: 'agent-1', messageIds: ['m1'] },
    })
    const duplicate = recordMemoryRevision({
      documentId: 'doc-1', documentRef: 'profile#stable', categoryId: 'uncategorized',
      fileName: 'Veronica Flowers - General Profile.md', content: 'Lives in Berlin.\n',
      context: { source: 'filesystem' },
    })
    const second = recordMemoryRevision({
      documentId: 'doc-1', documentRef: 'profile#stable', categoryId: 'uncategorized',
      fileName: 'Veronica Flowers - General Profile.md', content: 'Lives in Hamburg.\n',
      context: { source: 'user' },
    })

    expect(duplicate.id).toBe(first.id)
    expect(listMemoryRevisions('profile#stable')).toHaveLength(2)
    expect(getMemoryRevision('profile#stable', first.id)).toMatchObject({
      content: 'Lives in Berlin.\n', source: 'dream', conversationId: 'chat-1', messageIds: ['m1'],
    })
    expect(unifiedMemoryDiff('profile#stable', first.id, second.id)).toContain('-Lives in Berlin.')
    expect(unifiedMemoryDiff('profile#stable', first.id, second.id)).toContain('+Lives in Hamburg.')
    expect(inlineMemoryDiff('profile#stable', first.id, second.id)).toEqual([
      { type: 'unchanged', text: 'Lives in ' },
      { type: 'removed', text: 'Berlin' },
      { type: 'added', text: 'Hamburg' },
      { type: 'unchanged', text: '.\n' },
    ])
  })

  test('keeps identity stable across moves and reactivates a matching deleted snapshot', () => {
    const first = recordMemoryRevision({
      documentId: 'doc-2', documentRef: 'hobbies#stable', categoryId: 'uncategorized',
      fileName: 'Veronica Flowers - Hobbies.md', content: 'Enjoys hiking.',
      context: { source: 'import' },
    })
    updateMemoryDocumentLocation('doc-2', 'people-veronica', 'Veronica Flowers - Interests.md')
    markMemoryDocumentDeleted('doc-2')

    const restored = recordMemoryRevision({
      documentId: 'doc-2', documentRef: 'hobbies#stable', categoryId: 'people-veronica',
      fileName: 'Veronica Flowers - Interests.md', content: 'Enjoys hiking.',
      context: { source: 'restore' },
    })

    expect(restored.id).toBe(first.id)
    expect(getMemoryDocument('hobbies#stable')).toMatchObject({
      document_id: 'doc-2', category_id: 'people-veronica',
      file_name: 'Veronica Flowers - Interests.md', status: 'active',
    })
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM memory_document_revisions WHERE document_id = ?').get('doc-2')).toEqual({ count: 1 })
  })

  test('records documents deleted through a folder cascade', () => {
    recordMemoryRevision({ documentId: 'parent-doc', documentRef: 'parent#doc', categoryId: 'parent', fileName: 'a.md', content: 'A' })
    recordMemoryRevision({ documentId: 'child-doc', documentRef: 'child#doc', categoryId: 'child', fileName: 'b.md', content: 'B' })
    recordMemoryRevision({ documentId: 'kept-doc', documentRef: 'kept#doc', categoryId: 'other', fileName: 'c.md', content: 'C' })

    expect(markMemoryCategoriesDeleted(['parent', 'child'])).toBe(2)
    expect(getMemoryDocument('parent#doc')?.status).toBe('deleted')
    expect(getMemoryDocument('child#doc')?.status).toBe('deleted')
    expect(getMemoryDocument('kept#doc')?.status).toBe('active')
  })
})
