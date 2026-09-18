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

export interface RecentMemoryChange extends MemoryRevisionSummary {
  documentRef: string
  folderId: string
  fileName: string
  status: 'active' | 'deleted'
  segments: MemoryDiffSegment[]
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
  folderId: string
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
    `).run(input.documentId, input.documentRef, input.folderId, input.fileName, contentHash, input.indexingStatus ?? 'indexed', now, now)

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

export function updateMemoryDocumentLocation(documentId: string, folderId: string, fileName: string): void {
  getDb().prepare('UPDATE memory_documents SET category_id = ?, file_name = ?, updated_at = ? WHERE document_id = ?')
    .run(folderId, fileName, Date.now(), documentId)
}

export function setMemoryDocumentIndexingStatus(documentId: string, status: 'pending' | 'indexed' | 'error'): void {
  getDb().prepare('UPDATE memory_documents SET indexing_status = ?, updated_at = ? WHERE document_id = ?')
    .run(status, Date.now(), documentId)
}

export function markMemoryDocumentDeleted(documentId: string): void {
  getDb().prepare("UPDATE memory_documents SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE document_id = ?")
    .run(Date.now(), Date.now(), documentId)
}

/** Record documents removed as a consequence of deleting one or more folders. */
export function markMemoryFoldersDeleted(folderIds: string[]): number {
  const ids = [...new Set(folderIds.filter(Boolean))]
  if (!ids.length) return 0
  const placeholders = ids.map(() => '?').join(', ')
  const now = Date.now()
  return getDb().prepare(`
    UPDATE memory_documents SET status = 'deleted', deleted_at = ?, updated_at = ?
    WHERE status = 'active' AND category_id IN (${placeholders})
  `).run(now, now, ...ids).changes
}

export function listMemoryRevisions(documentRef: string): MemoryRevisionSummary[] {
  return (getDb().prepare(`
    SELECT r.* FROM memory_document_revisions r
    JOIN memory_documents d ON d.document_id = r.document_id
    WHERE d.document_ref = ? ORDER BY r.revision_number DESC
  `).all(documentRef) as RevisionRow[]).map(rowToSummary)
}

/** Latest content changes across the memory space, including a readable diff
 * against each document's preceding snapshot. */
export function listRecentMemoryChanges(limit = 20): RecentMemoryChange[] {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)))
  const rows = getDb().prepare(`
    SELECT r.*, d.document_ref, d.category_id, d.file_name, d.status,
      (SELECT previous.content FROM memory_document_revisions previous
       WHERE previous.document_id = r.document_id
         AND previous.revision_number < r.revision_number
       ORDER BY previous.revision_number DESC LIMIT 1) AS previous_content
    FROM memory_document_revisions r
    JOIN memory_documents d ON d.document_id = r.document_id
    ORDER BY r.created_at DESC, r.rowid DESC
    LIMIT ?
  `).all(safeLimit) as Array<RevisionRow & {
    document_ref: string
    category_id: string
    file_name: string
    status: 'active' | 'deleted'
    previous_content: string | null
  }>

  return rows.map(row => ({
    ...rowToSummary(row),
    documentRef: row.document_ref,
    folderId: row.category_id,
    fileName: row.file_name,
    status: row.status,
    segments: row.previous_content === null
      ? (row.content ? [{ type: 'added' as const, text: row.content }] : [])
      : diffWordsWithSpace(row.previous_content, row.content).map(part => ({
          type: part.added ? 'added' as const : part.removed ? 'removed' as const : 'unchanged' as const,
          text: part.value,
        })),
  }))
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

/** Return the current monotonic revision number for a canonical document. */
export function getCurrentMemoryRevisionNumber(documentId: string): number | undefined {
  const row = getDb().prepare(`
    SELECT revision_number FROM memory_document_revisions
    WHERE document_id = ? ORDER BY revision_number DESC LIMIT 1
  `).get(documentId) as { revision_number: number } | undefined
  return row?.revision_number
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
  try { messageIds = JSON.parse(row.message_ids_json) as string[] } catch { /* malformed metadata */ }
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
