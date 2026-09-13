import { createHash, randomUUID } from 'node:crypto'
import { diffLines, diffWordsWithSpace, createTwoFilesPatch } from 'diff'
import { getDb } from '../../db/database.js'

export type MemoryRevisionSource = 'ai' | 'dream' | 'user' | 'filesystem' | 'import' | 'restore'

export interface MemoryRevisionContext {
  source: MemoryRevisionSource
  conversationId?: string
  agentId?: string
  messageIds?: string[]
}

export interface MemoryRevisionSummary {
  id: string
  revisionNumber: number
  contentHash: string
  source: MemoryRevisionSource
  conversationId?: string
  agentId?: string
  messageIds: string[]
  createdAt: number
}

export interface MemoryDiffSegment {
  type: 'unchanged' | 'added' | 'removed'
  text: string
}

interface DocumentRow {
  document_id: string
  document_ref: string
  category_id: string
  file_name: string
  current_hash: string
  status: 'active' | 'deleted'
  indexing_status: 'pending' | 'indexed' | 'error'
}

interface RevisionRow {
  id: string
  document_id: string
  revision_number: number
  content_hash: string
  content: string
  source: MemoryRevisionSource
  conversation_id: string | null
  agent_id: string | null
  message_ids_json: string
  created_at: number
}

export function contentRevisionHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function recordMemoryRevision(input: {
  documentId: string
  documentRef: string
  categoryId: string
  fileName: string
  content: string
  context?: MemoryRevisionContext
  indexingStatus?: 'pending' | 'indexed' | 'error'
}): MemoryRevisionSummary {
  const db = getDb()
  const now = Date.now()
  const contentHash = contentRevisionHash(input.content)
  const context = input.context ?? { source: 'filesystem' as const }
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM memory_documents WHERE document_id = ?').get(input.documentId) as DocumentRow | undefined
    db.prepare(`
      INSERT INTO memory_documents(document_id, document_ref, category_id, file_name, current_hash, status, indexing_status, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)
      ON CONFLICT(document_id) DO UPDATE SET
        document_ref = excluded.document_ref,
        category_id = excluded.category_id,
        file_name = excluded.file_name,
        current_hash = excluded.current_hash,
        status = 'active',
        indexing_status = excluded.indexing_status,
        updated_at = excluded.updated_at,
        deleted_at = NULL
    `).run(input.documentId, input.documentRef, input.categoryId, input.fileName, contentHash, input.indexingStatus ?? 'indexed', now, now)

    if (existing?.current_hash === contentHash) {
      const latest = db.prepare('SELECT * FROM memory_document_revisions WHERE document_id = ? ORDER BY revision_number DESC LIMIT 1').get(input.documentId) as RevisionRow | undefined
      if (latest) return rowToSummary(latest)
    }
    const next = ((db.prepare('SELECT MAX(revision_number) AS n FROM memory_document_revisions WHERE document_id = ?').get(input.documentId) as { n: number | null }).n ?? 0) + 1
    const id = randomUUID()
    db.prepare(`
      INSERT INTO memory_document_revisions(id, document_id, revision_number, content_hash, content, source, conversation_id, agent_id, message_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.documentId, next, contentHash, input.content, context.source, context.conversationId ?? null, context.agentId ?? null, JSON.stringify(context.messageIds ?? []), now)
    return { id, revisionNumber: next, contentHash, source: context.source, conversationId: context.conversationId, agentId: context.agentId, messageIds: context.messageIds ?? [], createdAt: now }
  })()
}

export function updateMemoryDocumentLocation(documentId: string, categoryId: string, fileName: string): void {
  getDb().prepare('UPDATE memory_documents SET category_id = ?, file_name = ?, updated_at = ? WHERE document_id = ?')
    .run(categoryId, fileName, Date.now(), documentId)
}

export function setMemoryDocumentIndexingStatus(documentId: string, status: 'pending' | 'indexed' | 'error'): void {
  getDb().prepare('UPDATE memory_documents SET indexing_status = ?, updated_at = ? WHERE document_id = ?')
    .run(status, Date.now(), documentId)
}

export function markMemoryDocumentDeleted(documentId: string): void {
  getDb().prepare("UPDATE memory_documents SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE document_id = ?")
    .run(Date.now(), Date.now(), documentId)
}

export function listMemoryRevisions(documentRef: string): MemoryRevisionSummary[] {
  return (getDb().prepare(`
    SELECT r.* FROM memory_document_revisions r
    JOIN memory_documents d ON d.document_id = r.document_id
    WHERE d.document_ref = ? ORDER BY r.revision_number DESC
  `).all(documentRef) as RevisionRow[]).map(rowToSummary)
}

export function getMemoryRevision(documentRef: string, revisionId: string): (MemoryRevisionSummary & { content: string; documentId: string }) | undefined {
  const row = getDb().prepare(`
    SELECT r.* FROM memory_document_revisions r
    JOIN memory_documents d ON d.document_id = r.document_id
    WHERE d.document_ref = ? AND r.id = ?
  `).get(documentRef, revisionId) as RevisionRow | undefined
  return row ? { ...rowToSummary(row), content: row.content, documentId: row.document_id } : undefined
}

export function getMemoryDocument(documentRef: string): DocumentRow | undefined {
  return getDb().prepare('SELECT * FROM memory_documents WHERE document_ref = ?').get(documentRef) as DocumentRow | undefined
}

export function unifiedMemoryDiff(documentRef: string, fromId: string, toId: string): string | undefined {
  const from = getMemoryRevision(documentRef, fromId)
  const to = getMemoryRevision(documentRef, toId)
  if (!from || !to) return undefined
  // Avoid emitting a header-only patch for equivalent snapshots.
  if (diffLines(from.content, to.content).every(part => !part.added && !part.removed)) return ''
  return createTwoFilesPatch(`revision-${from.revisionNumber}`, `revision-${to.revisionNumber}`, from.content, to.content, '', '', { context: 3 })
}

/** Word-level changes for presenting a revision as readable prose instead of patch syntax. */
export function inlineMemoryDiff(documentRef: string, fromId: string, toId: string): MemoryDiffSegment[] | undefined {
  const from = getMemoryRevision(documentRef, fromId)
  const to = getMemoryRevision(documentRef, toId)
  if (!from || !to) return undefined
  return diffWordsWithSpace(from.content, to.content).map(part => ({
    type: part.added ? 'added' : part.removed ? 'removed' : 'unchanged',
    text: part.value,
  }))
}

function rowToSummary(row: RevisionRow): MemoryRevisionSummary {
  let messageIds: string[] = []
  try { messageIds = JSON.parse(row.message_ids_json) as string[] } catch { /* malformed legacy metadata */ }
  return {
    id: row.id,
    revisionNumber: row.revision_number,
    contentHash: row.content_hash,
    source: row.source,
    conversationId: row.conversation_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    messageIds,
    createdAt: row.created_at,
  }
}
