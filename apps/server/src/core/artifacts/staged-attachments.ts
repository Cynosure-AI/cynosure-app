import { existsSync, rmSync } from 'fs'
import { getDb } from '../../db/database.js'
import { materializeFileAttachment, type FileAttachmentArtifact, type FileAttachmentInput } from './file-artifacts.js'
import { hasAttachmentAssetReferences, releaseAttachmentAsset } from './attachment-asset-references.js'

export type StagedAttachmentStatus = 'processing' | 'ready' | 'failed'

export interface StagedChatAttachmentState {
  id: string
  conversationId: string
  clientId?: string
  name: string
  status: StagedAttachmentStatus
  error?: string
  createdAt: number
  updatedAt: number
  artifact: FileAttachmentArtifact
}

const pendingStages = new Map<string, Set<Promise<StagedChatAttachmentState>>>()

function rowToState(row: {
  id: string; conversation_id: string; client_id: string | null; artifact_json: string
  status: StagedAttachmentStatus
  error: string | null; created_at: number; updated_at: number | null
}): StagedChatAttachmentState {
  const artifact = JSON.parse(row.artifact_json) as FileAttachmentArtifact
  return {
    id: row.id,
    conversationId: row.conversation_id,
    clientId: row.client_id || undefined,
    name: artifact.name,
    status: row.status,
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    artifact,
  }
}

function readStagedRows(conversationId?: string): StagedChatAttachmentState[] {
  const rows = getDb().prepare(`
    SELECT id, conversation_id, client_id, artifact_json, status, error, created_at, updated_at
    FROM staged_chat_attachments
    ${conversationId ? 'WHERE conversation_id = ?' : ''}
    ORDER BY created_at ASC
  `).all(...(conversationId ? [conversationId] : [])) as Array<{
    id: string; conversation_id: string; client_id: string | null; artifact_json: string
    status: StagedAttachmentStatus
    error: string | null; created_at: number; updated_at: number | null
  }>
  return rows.map(rowToState)
}

export function stageChatAttachment(
  conversationId: string,
  file: FileAttachmentInput & { clientId?: string },
): Promise<StagedChatAttachmentState> {
  const pending = pendingStages.get(conversationId) ?? new Set<Promise<StagedChatAttachmentState>>()
  pendingStages.set(conversationId, pending)
  const job = materializeAndStage(conversationId, file)
  pending.add(job)
  const settled = (): void => {
    pending.delete(job)
    if (!pending.size) pendingStages.delete(conversationId)
  }
  void job.then(settled, settled)
  return job
}

async function materializeAndStage(
  conversationId: string,
  file: FileAttachmentInput & { clientId?: string },
): Promise<StagedChatAttachmentState> {
  const artifact = await materializeFileAttachment(file, conversationId)
  const now = Date.now()
  const state: StagedChatAttachmentState = {
    id: artifact.id,
    conversationId,
    clientId: file.clientId,
    name: artifact.name,
    status: 'ready',
    createdAt: now,
    updatedAt: now,
    artifact,
  }
  try {
    getDb().prepare(`
      INSERT INTO staged_chat_attachments
        (id, conversation_id, client_id, artifact_json, status, progress_current,
         progress_total, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'ready', 0, 0, NULL, ?, ?)
    `).run(artifact.id, conversationId, file.clientId || null, JSON.stringify(artifact), now, now)
  } catch (error) {
    releaseAttachmentAsset(artifact)
    if (!hasAttachmentAssetReferences(getDb(), artifact.assetId || artifact.id)) {
      getDb().prepare('DELETE FROM attachment_assets WHERE id = ?').run(artifact.assetId || artifact.id)
      for (const path of [artifact.originalPath, artifact.textPath]) rmSync(path, { force: true })
    }
    throw error
  }
  releaseAttachmentAsset(artifact)
  return state
}

export function listStagedChatAttachments(conversationId?: string): StagedChatAttachmentState[] {
  // Uploads staged while attachments were still indexed after parsing are ready as they are.
  getDb().prepare(`UPDATE staged_chat_attachments SET status = 'ready' WHERE status = 'processing'`).run()
  return readStagedRows(conversationId)
}

export function takeStagedChatAttachments(conversationId: string, ids: string[]): FileAttachmentArtifact[] {
  if (!ids.length) return []
  const select = getDb().prepare(`
    SELECT artifact_json FROM staged_chat_attachments
    WHERE id = ? AND conversation_id = ? AND status = 'ready'
  `)
  return ids.map(id => {
    const row = select.get(id, conversationId) as { artifact_json: string } | undefined
    if (!row) throw new Error('A selected attachment is no longer available or is still processing')
    return JSON.parse(row.artifact_json) as FileAttachmentArtifact
  })
}

/** Release draft references after durable message/queue ownership is established. */
export function commitStagedChatAttachments(conversationId: string, ids: string[]): void {
  if (!ids.length) return
  const remove = getDb().prepare('DELETE FROM staged_chat_attachments WHERE id = ? AND conversation_id = ?')
  for (const id of ids) remove.run(id, conversationId)
}

export async function releaseStagedChatAttachments(conversationId: string, ids: string[], deleteArtifacts = true): Promise<void> {
  if (!ids.length) return
  if (!deleteArtifacts) {
    commitStagedChatAttachments(conversationId, ids)
    return
  }
  const artifacts = readStagedRows(conversationId)
    .filter((state) => ids.includes(state.id))
    .map((state) => state.artifact)
  const ownedIds = artifacts.map(artifact => artifact.id)
  const remove = getDb().prepare('DELETE FROM staged_chat_attachments WHERE id = ? AND conversation_id = ?')
  for (const id of ownedIds) remove.run(id, conversationId)
  const retiring = new Map<string, FileAttachmentArtifact>()
  for (const artifact of artifacts) {
    const assetId = artifact.assetId || artifact.id
    if (hasAttachmentAssetReferences(getDb(), assetId)) continue
    retiring.set(assetId, artifact)
    getDb().prepare('DELETE FROM attachment_assets WHERE id = ?').run(assetId)
  }
  for (const artifact of retiring.values()) {
    for (const path of [artifact.originalPath, artifact.textPath]) {
      try { if (existsSync(path)) rmSync(path) } catch { /* best effort */ }
    }
  }
}

export async function discardStagedChatAttachments(conversationId: string): Promise<void> {
  // Parsing an upload may still be materializing its files when discard arrives.
  while (pendingStages.get(conversationId)?.size) {
    await Promise.allSettled([...pendingStages.get(conversationId)!])
  }
  await releaseStagedChatAttachments(conversationId, readStagedRows(conversationId).map(state => state.id))
}
