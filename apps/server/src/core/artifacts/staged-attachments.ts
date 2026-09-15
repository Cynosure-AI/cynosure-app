import { existsSync, rmSync } from 'fs'
import { getDb } from '../../db/database.js'
import { deleteConversationAttachmentChunks, indexConversationAttachment } from './attachment-rag.js'
import { materializeFileAttachment, type FileAttachmentArtifact, type FileAttachmentInput } from './file-artifacts.js'

export async function stageChatAttachment(
  conversationId: string,
  file: FileAttachmentInput,
  opts?: { signal?: AbortSignal; onProgress?: (current: number, total: number) => void },
): Promise<FileAttachmentArtifact> {
  const artifact = await materializeFileAttachment(file, conversationId)
  try {
    artifact.chunkCount = await indexConversationAttachment(conversationId, artifact, opts)
    if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    getDb().prepare('INSERT INTO staged_chat_attachments (id, conversation_id, artifact_json, created_at) VALUES (?, ?, ?, ?)')
      .run(artifact.id, conversationId, JSON.stringify(artifact), Date.now())
    return artifact
  } catch (error) {
    for (const path of [artifact.originalPath, artifact.textPath]) {
      try { if (existsSync(path)) rmSync(path) } catch { /* best effort */ }
    }
    await deleteConversationAttachmentChunks(conversationId, [artifact.assetId || artifact.id]).catch(() => undefined)
    throw error
  }
}

export function takeStagedChatAttachments(conversationId: string, ids: string[]): FileAttachmentArtifact[] {
  if (!ids.length) return []
  const select = getDb().prepare('SELECT artifact_json FROM staged_chat_attachments WHERE id = ? AND conversation_id = ?')
  return ids.map(id => select.get(id, conversationId) as { artifact_json: string } | undefined)
    .filter((row): row is { artifact_json: string } => Boolean(row))
    .map(row => JSON.parse(row.artifact_json) as FileAttachmentArtifact)
}

export function releaseStagedChatAttachments(conversationId: string, ids: string[], deleteArtifacts = true): void {
  if (!ids.length) return
  const artifacts = takeStagedChatAttachments(conversationId, ids)
  const remove = getDb().prepare('DELETE FROM staged_chat_attachments WHERE id = ? AND conversation_id = ?')
  for (const id of ids) remove.run(id, conversationId)
  if (!deleteArtifacts) return
  for (const artifact of artifacts) {
    for (const path of [artifact.originalPath, artifact.textPath]) {
      try { if (existsSync(path)) rmSync(path) } catch { /* best effort */ }
    }
  }
  void deleteConversationAttachmentChunks(conversationId, ids)
}
