import { existsSync, rmSync } from 'fs'
import { getDb } from '../../db/database.js'
import { deleteConversationAttachmentChunks, indexConversationAttachment } from './attachment-rag.js'
import { materializeFileAttachment, type FileAttachmentArtifact, type FileAttachmentInput } from './file-artifacts.js'

export type StagedAttachmentStatus = 'processing' | 'ready' | 'failed'

export interface StagedChatAttachmentState {
  id: string
  conversationId: string
  clientId?: string
  name: string
  status: StagedAttachmentStatus
  progressCurrent: number
  progressTotal: number
  chunkCount: number
  error?: string
  createdAt: number
  updatedAt: number
  artifact: FileAttachmentArtifact
}

type StageUpdate = Omit<StagedChatAttachmentState, 'artifact' | 'createdAt' | 'updatedAt'>
const activeIndexJobs = new Map<string, AbortController>()

function rowToState(row: {
  id: string; conversation_id: string; client_id: string | null; artifact_json: string
  status: StagedAttachmentStatus; progress_current: number; progress_total: number
  error: string | null; created_at: number; updated_at: number | null
}): StagedChatAttachmentState {
  const artifact = JSON.parse(row.artifact_json) as FileAttachmentArtifact
  return {
    id: row.id,
    conversationId: row.conversation_id,
    clientId: row.client_id || undefined,
    name: artifact.name,
    status: row.status,
    progressCurrent: row.progress_current || 0,
    progressTotal: row.progress_total || 0,
    chunkCount: artifact.chunkCount || 0,
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    artifact,
  }
}

function publicUpdate(state: StagedChatAttachmentState): StageUpdate {
  return {
    id: state.id,
    conversationId: state.conversationId,
    clientId: state.clientId,
    name: state.name,
    status: state.status,
    progressCurrent: state.progressCurrent,
    progressTotal: state.progressTotal,
    chunkCount: state.chunkCount,
    error: state.error,
  }
}

function readStagedRows(conversationId?: string): StagedChatAttachmentState[] {
  const rows = getDb().prepare(`
    SELECT id, conversation_id, client_id, artifact_json, status,
      progress_current, progress_total, error, created_at, updated_at
    FROM staged_chat_attachments
    ${conversationId ? 'WHERE conversation_id = ?' : ''}
    ORDER BY created_at ASC
  `).all(...(conversationId ? [conversationId] : [])) as Array<{
    id: string; conversation_id: string; client_id: string | null; artifact_json: string
    status: StagedAttachmentStatus; progress_current: number; progress_total: number
    error: string | null; created_at: number; updated_at: number | null
  }>
  return rows.map(rowToState)
}

function startIndexing(state: StagedChatAttachmentState, onUpdate?: (update: StageUpdate) => void): void {
  if (activeIndexJobs.has(state.id)) return
  const controller = new AbortController()
  activeIndexJobs.set(state.id, controller)

  void (async () => {
    try {
      // A process may have stopped midway through a previous attempt. Always
      // rebuild this asset from a clean source-specific slice before resuming.
      await deleteConversationAttachmentChunks(state.conversationId, [state.artifact.assetId || state.artifact.id])
      const chunkCount = await indexConversationAttachment(state.conversationId, state.artifact, {
        signal: controller.signal,
        throwOnError: true,
        onProgress: (current, total) => {
          const updatedAt = Date.now()
          const result = getDb().prepare(`
            UPDATE staged_chat_attachments
            SET progress_current = ?, progress_total = ?, updated_at = ?
            WHERE id = ? AND status = 'processing'
          `).run(current, total, updatedAt, state.id)
          if (result.changes === 0) return
          state.progressCurrent = current
          state.progressTotal = total
          state.updatedAt = updatedAt
          onUpdate?.(publicUpdate(state))
        },
      })
      controller.signal.throwIfAborted()
      state.artifact.chunkCount = chunkCount
      state.chunkCount = chunkCount
      state.status = 'ready'
      state.progressCurrent = Math.max(state.progressCurrent, chunkCount)
      state.progressTotal = Math.max(state.progressTotal, chunkCount)
      state.updatedAt = Date.now()
      const result = getDb().prepare(`
        UPDATE staged_chat_attachments
        SET artifact_json = ?, status = 'ready', progress_current = ?, progress_total = ?,
          error = NULL, updated_at = ? WHERE id = ? AND status = 'processing'
      `).run(JSON.stringify(state.artifact), state.progressCurrent, state.progressTotal, state.updatedAt, state.id)
      if (result.changes > 0) onUpdate?.(publicUpdate(state))
    } catch (error) {
      if (controller.signal.aborted) return
      state.status = 'failed'
      state.error = error instanceof Error ? error.message : 'Attachment indexing failed'
      state.updatedAt = Date.now()
      const result = getDb().prepare(`
        UPDATE staged_chat_attachments SET status = 'failed', error = ?, updated_at = ?
        WHERE id = ? AND status = 'processing'
      `).run(state.error, state.updatedAt, state.id)
      if (result.changes > 0) onUpdate?.(publicUpdate(state))
      await deleteConversationAttachmentChunks(state.conversationId, [state.artifact.assetId || state.artifact.id]).catch(() => undefined)
    } finally {
      activeIndexJobs.delete(state.id)
    }
  })()
}

export async function stageChatAttachment(
  conversationId: string,
  file: FileAttachmentInput & { clientId?: string },
  opts?: { onUpdate?: (update: StageUpdate) => void },
): Promise<StagedChatAttachmentState> {
  const artifact = await materializeFileAttachment(file, conversationId)
  const now = Date.now()
  const state: StagedChatAttachmentState = {
    id: artifact.id,
    conversationId,
    clientId: file.clientId,
    name: artifact.name,
    status: 'processing',
    progressCurrent: 0,
    progressTotal: 0,
    chunkCount: 0,
    createdAt: now,
    updatedAt: now,
    artifact,
  }
  getDb().prepare(`
    INSERT INTO staged_chat_attachments
      (id, conversation_id, client_id, artifact_json, status, progress_current,
       progress_total, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'processing', 0, 0, NULL, ?, ?)
  `).run(artifact.id, conversationId, file.clientId || null, JSON.stringify(artifact), now, now)
  startIndexing(state, opts?.onUpdate)
  return state
}

export function listStagedChatAttachments(conversationId?: string): StagedChatAttachmentState[] {
  const states = readStagedRows(conversationId)
  // Recover jobs interrupted by an application restart. Stored artifact paths
  // are authoritative, and startIndexing de-duplicates live work.
  for (const state of states) if (state.status === 'processing') startIndexing(state)
  return states
}

export function takeStagedChatAttachments(conversationId: string, ids: string[]): FileAttachmentArtifact[] {
  if (!ids.length) return []
  const select = getDb().prepare(`
    SELECT artifact_json FROM staged_chat_attachments
    WHERE id = ? AND conversation_id = ? AND status = 'ready'
  `)
  return ids.map(id => select.get(id, conversationId) as { artifact_json: string } | undefined)
    .filter((row): row is { artifact_json: string } => Boolean(row))
    .map(row => JSON.parse(row.artifact_json) as FileAttachmentArtifact)
}

export function releaseStagedChatAttachments(conversationId: string, ids: string[], deleteArtifacts = true): void {
  if (!ids.length) return
  const artifacts = readStagedRows(conversationId)
    .filter((state) => ids.includes(state.id))
    .map((state) => state.artifact)
  const remove = getDb().prepare('DELETE FROM staged_chat_attachments WHERE id = ? AND conversation_id = ?')
  for (const id of ids) {
    activeIndexJobs.get(id)?.abort()
    remove.run(id, conversationId)
  }
  if (!deleteArtifacts) return
  for (const artifact of artifacts) {
    for (const path of [artifact.originalPath, artifact.textPath]) {
      try { if (existsSync(path)) rmSync(path) } catch { /* best effort */ }
    }
  }
  void deleteConversationAttachmentChunks(conversationId, artifacts.map((artifact) => artifact.assetId || artifact.id))
}
