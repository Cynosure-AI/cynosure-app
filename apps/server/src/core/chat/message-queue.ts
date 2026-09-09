import { existsSync, rmSync } from 'fs'
import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import type { ChatMessage, ContentPart } from '../gateway/providers/base.provider.js'
import {
  artifactFileUrlToDataUrl,
  extractFilePathFromFileUrl,
  materializeAudioArtifacts,
  materializeImageArtifacts,
  toFileUrl,
} from '../artifacts/image-artifacts.js'
import {
  materializeFileAttachments,
  readFileAttachmentText,
  type FileAttachmentArtifact,
} from '../artifacts/file-artifacts.js'
import { deleteConversationAttachmentChunks, indexConversationAttachment, persistMessageFileAttachments } from '../artifacts/attachment-rag.js'
import type {
  ChatQueueRequest,
  ChatQueueStateDto,
  ChatRunConfig,
  ChatSendRequest,
  QueuedChatAttachment,
  QueuedChatMessageDto,
} from '@shared/types'
import { getChatExecutionIdsByConversation } from './active-executions.js'

type BroadcastFn = (event: string, data: unknown) => void

interface QueueRow {
  id: string
  conversation_id: string
  content: string
  delivery: 'next' | 'steer'
  status: 'pending' | 'paused'
  position: number
  run_json: string
  image_urls_json: string | null
  audio_urls_json: string | null
  file_artifacts_json: string | null
  created_at: number
  updated_at: number
}

export interface QueuedExecutionRequest extends ChatSendRequest {
  stagedFileArtifacts?: FileAttachmentArtifact[]
  fromQueue?: boolean
}

type QueueRunner = (conversationId: string, request: QueuedExecutionRequest) => Promise<boolean>

const steeringHandlers = new Map<string, () => void>()
const draining = new Set<string>()
let runner: QueueRunner | null = null
let broadcastQueue: BroadcastFn = () => {}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function rowFiles(row: QueueRow): FileAttachmentArtifact[] {
  return parseJson<FileAttachmentArtifact[]>(row.file_artifacts_json, [])
}

function rowToDto(row: QueueRow): QueuedChatMessageDto {
  const images = parseJson<string[]>(row.image_urls_json, [])
  const audio = parseJson<string[]>(row.audio_urls_json, [])
  const files = rowFiles(row)
  const attachments: QueuedChatAttachment[] = [
    ...images.map((url, index) => ({ id: `image-${index}`, kind: 'image' as const, name: `Image ${index + 1}`, url })),
    ...audio.map((url, index) => ({ id: `audio-${index}`, kind: 'audio' as const, name: `Audio ${index + 1}`, url })),
    ...files.map(file => ({ id: file.id, kind: 'file' as const, name: file.name, url: toFileUrl(file.originalPath, file.name) })),
  ]
  return {
    id: row.id,
    conversationId: row.conversation_id,
    content: row.content,
    delivery: row.delivery,
    status: row.status,
    position: row.position,
    attachments,
    run: parseJson<ChatRunConfig>(row.run_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rows(conversationId: string): QueueRow[] {
  return getDb().prepare(`
    SELECT * FROM queued_chat_messages
    WHERE conversation_id = ?
    ORDER BY position ASC, created_at ASC
  `).all(conversationId) as QueueRow[]
}

export function getChatQueueState(conversationId: string): ChatQueueStateDto {
  const queueRows = rows(conversationId)
  return {
    conversationId,
    paused: queueRows.some(row => row.status === 'paused'),
    items: queueRows.map(rowToDto),
  }
}

function notify(conversationId: string): void {
  broadcastQueue('chat:queue-changed', { conversationId })
}

function nextPosition(conversationId: string): number {
  const row = getDb().prepare(
    'SELECT COALESCE(MAX(position), 0) + 1 AS position FROM queued_chat_messages WHERE conversation_id = ?'
  ).get(conversationId) as { position: number }
  return row.position
}

async function stageRequest(conversationId: string, request: ChatQueueRequest): Promise<{
  images: string[]
  audio: string[]
  files: FileAttachmentArtifact[]
}> {
  const images = request.imageDataUrls?.length
    ? (await materializeImageArtifacts(request.imageDataUrls, conversationId)).map(item => item.url)
    : []
  const audio = request.audioDataUrls?.length
    ? (await materializeAudioArtifacts(request.audioDataUrls, conversationId)).map(item => item.url)
    : []
  const files = request.files?.length
    ? await materializeFileAttachments(request.files, conversationId)
    : []
  for (const file of files) file.chunkCount = await indexConversationAttachment(conversationId, file)
  return { images, audio, files }
}

export async function enqueueChatMessage(conversationId: string, request: ChatQueueRequest): Promise<QueuedChatMessageDto> {
  const staged = await stageRequest(conversationId, request)
  const db = getDb()
  const id = request.messageId || nanoid()
  const now = Date.now()
  const active = getChatExecutionIdsByConversation(conversationId).length > 0
  const alreadyPaused = rows(conversationId).some(row => row.status === 'paused')
  const status = request.delivery === 'steer' || (active && !alreadyPaused) ? 'pending' : 'paused'
  db.prepare(`
    INSERT INTO queued_chat_messages (
      id, conversation_id, content, delivery, status, position, run_json,
      image_urls_json, audio_urls_json, file_artifacts_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, conversationId, request.content, request.delivery, status, nextPosition(conversationId),
    JSON.stringify(request.run || {}),
    staged.images.length ? JSON.stringify(staged.images) : null,
    staged.audio.length ? JSON.stringify(staged.audio) : null,
    staged.files.length ? JSON.stringify(staged.files) : null,
    now, now,
  )
  const dto = rowToDto(db.prepare('SELECT * FROM queued_chat_messages WHERE id = ?').get(id) as QueueRow)
  notify(conversationId)
  if (request.delivery === 'steer') {
    const handler = steeringHandlers.get(conversationId)
    if (handler) handler()
    else if (!active) void runNextQueuedMessage(conversationId, id)
  }
  return dto
}

export async function replaceQueuedChatMessage(
  conversationId: string,
  id: string,
  request: ChatQueueRequest,
): Promise<QueuedChatMessageDto | null> {
  const existing = getDb().prepare(
    'SELECT * FROM queued_chat_messages WHERE id = ? AND conversation_id = ?'
  ).get(id, conversationId) as QueueRow | undefined
  if (!existing) return null
  const additions = await stageRequest(conversationId, request)
  const staged = {
    images: [...parseJson<string[]>(existing.image_urls_json, []), ...additions.images],
    audio: [...parseJson<string[]>(existing.audio_urls_json, []), ...additions.audio],
    files: [...rowFiles(existing), ...additions.files],
  }
  const now = Date.now()
  getDb().prepare(`
    UPDATE queued_chat_messages SET content = ?, delivery = ?, run_json = ?, image_urls_json = ?,
      audio_urls_json = ?, file_artifacts_json = ?, updated_at = ?
    WHERE id = ? AND conversation_id = ?
  `).run(
    request.content, request.delivery, JSON.stringify(request.run || {}),
    staged.images.length ? JSON.stringify(staged.images) : null,
    staged.audio.length ? JSON.stringify(staged.audio) : null,
    staged.files.length ? JSON.stringify(staged.files) : null,
    now, id, conversationId,
  )
  notify(conversationId)
  return rowToDto(getDb().prepare('SELECT * FROM queued_chat_messages WHERE id = ?').get(id) as QueueRow)
}

function cleanupRowArtifacts(row: QueueRow): void {
  const files = rowFiles(row)
  const urls = [
    ...parseJson<string[]>(row.image_urls_json, []),
    ...parseJson<string[]>(row.audio_urls_json, []),
  ]
  const paths = [
    ...urls.map(extractFilePathFromFileUrl).filter((path): path is string => Boolean(path)),
    ...files.flatMap(file => [file.originalPath, file.textPath]),
  ]
  for (const path of paths) {
    try { if (existsSync(path)) rmSync(path) } catch { /* best effort */ }
  }
  if (files.length) void deleteConversationAttachmentChunks(row.conversation_id, files.map(file => file.id))
}

export function deleteQueuedChatMessage(conversationId: string, id: string): boolean {
  const row = getDb().prepare(
    'SELECT * FROM queued_chat_messages WHERE id = ? AND conversation_id = ?'
  ).get(id, conversationId) as QueueRow | undefined
  if (!row) return false
  cleanupRowArtifacts(row)
  getDb().prepare('DELETE FROM queued_chat_messages WHERE id = ?').run(id)
  notify(conversationId)
  return true
}

export function deleteQueuedChatAttachment(conversationId: string, id: string, attachmentId: string): boolean {
  const db = getDb()
  const row = db.prepare(
    'SELECT * FROM queued_chat_messages WHERE id = ? AND conversation_id = ?'
  ).get(id, conversationId) as QueueRow | undefined
  if (!row) return false
  const images = parseJson<string[]>(row.image_urls_json, [])
  const audio = parseJson<string[]>(row.audio_urls_json, [])
  const files = rowFiles(row)
  let removed: QueueRow | null = null
  if (attachmentId.startsWith('image-')) {
    const index = Number(attachmentId.slice(6))
    const url = images.splice(index, 1)[0]
    if (url) removed = { ...row, image_urls_json: JSON.stringify([url]), audio_urls_json: null, file_artifacts_json: null }
  } else if (attachmentId.startsWith('audio-')) {
    const index = Number(attachmentId.slice(6))
    const url = audio.splice(index, 1)[0]
    if (url) removed = { ...row, image_urls_json: null, audio_urls_json: JSON.stringify([url]), file_artifacts_json: null }
  } else {
    const index = files.findIndex(file => file.id === attachmentId)
    const file = index === -1 ? undefined : files.splice(index, 1)[0]
    if (file) removed = { ...row, image_urls_json: null, audio_urls_json: null, file_artifacts_json: JSON.stringify([file]) }
  }
  if (!removed) return false
  cleanupRowArtifacts(removed)
  db.prepare(`
    UPDATE queued_chat_messages SET image_urls_json = ?, audio_urls_json = ?, file_artifacts_json = ?, updated_at = ?
    WHERE id = ? AND conversation_id = ?
  `).run(
    images.length ? JSON.stringify(images) : null,
    audio.length ? JSON.stringify(audio) : null,
    files.length ? JSON.stringify(files) : null,
    Date.now(), id, conversationId,
  )
  notify(conversationId)
  return true
}

export function promoteQueuedMessageToSteering(conversationId: string, id: string): boolean {
  const result = getDb().prepare(`
    UPDATE queued_chat_messages SET delivery = 'steer', status = 'pending', updated_at = ?
    WHERE id = ? AND conversation_id = ?
  `).run(Date.now(), id, conversationId)
  if (!result.changes) return false
  notify(conversationId)
  const handler = steeringHandlers.get(conversationId)
  if (handler) handler()
  else if (getChatExecutionIdsByConversation(conversationId).length === 0) void runNextQueuedMessage(conversationId, id)
  return true
}

export function configureChatQueue(queueRunner: QueueRunner, broadcast: BroadcastFn): void {
  runner = queueRunner
  broadcastQueue = broadcast
}

export function registerChatSteeringHandler(conversationId: string, handler: () => void): () => void {
  steeringHandlers.set(conversationId, handler)
  if (rows(conversationId).some(row => row.delivery === 'steer' && row.status === 'pending')) handler()
  return () => {
    if (steeringHandlers.get(conversationId) === handler) steeringHandlers.delete(conversationId)
  }
}

function makeQueuedExecution(row: QueueRow): QueuedExecutionRequest {
  return {
    content: row.content,
    messageId: row.id,
    imageDataUrls: parseJson<string[]>(row.image_urls_json, []),
    audioDataUrls: parseJson<string[]>(row.audio_urls_json, []),
    stagedFileArtifacts: rowFiles(row),
    run: parseJson<ChatRunConfig>(row.run_json, {}),
    fromQueue: true,
  }
}

export async function runNextQueuedMessage(conversationId: string, preferredId?: string): Promise<void> {
  if (!runner || draining.has(conversationId) || steeringHandlers.has(conversationId)) return
  const db = getDb()
  const candidate = preferredId
    ? db.prepare('SELECT * FROM queued_chat_messages WHERE id = ? AND conversation_id = ?').get(preferredId, conversationId) as QueueRow | undefined
    : db.prepare(`SELECT * FROM queued_chat_messages WHERE conversation_id = ? AND status = 'pending' ORDER BY position, created_at LIMIT 1`).get(conversationId) as QueueRow | undefined
  if (!candidate) return
  draining.add(conversationId)
  db.prepare(`UPDATE queued_chat_messages SET status = 'pending' WHERE conversation_id = ?`).run(conversationId)
  try {
    const completed = await runner(conversationId, makeQueuedExecution(candidate))
    if (completed) {
      draining.delete(conversationId)
      await runNextQueuedMessage(conversationId)
      return
    }
    db.prepare(`UPDATE queued_chat_messages SET status = 'paused' WHERE conversation_id = ?`).run(conversationId)
  } catch {
    db.prepare(`UPDATE queued_chat_messages SET status = 'paused' WHERE conversation_id = ?`).run(conversationId)
  } finally {
    draining.delete(conversationId)
    notify(conversationId)
  }
}

export function pauseChatQueue(conversationId: string): void {
  getDb().prepare(`UPDATE queued_chat_messages SET status = 'paused' WHERE conversation_id = ?`).run(conversationId)
  notify(conversationId)
}

export function markQueuedMessagePromoted(conversationId: string, id: string): void {
  getDb().prepare('DELETE FROM queued_chat_messages WHERE id = ? AND conversation_id = ?').run(id, conversationId)
  notify(conversationId)
}

export async function takeSteeringMessages(conversationId: string, streamId: string): Promise<ChatMessage[]> {
  const db = getDb()
  const steeringRows = db.prepare(`
    SELECT * FROM queued_chat_messages
    WHERE conversation_id = ? AND delivery = 'steer' AND status = 'pending'
    ORDER BY position, created_at
    LIMIT 1
  `).all(conversationId) as QueueRow[]
  const promoted: ChatMessage[] = []
  for (const row of steeringRows) {
    const images = parseJson<string[]>(row.image_urls_json, [])
    const audio = parseJson<string[]>(row.audio_urls_json, [])
    const files = rowFiles(row)
    const normalized = row.content.trim() || (audio.length ? 'Transcribe the attached audio.' : row.content)
    const parts: ContentPart[] = [{ type: 'text', text: normalized }]
    for (const file of files) {
      const text = readFileAttachmentText(file)
      if (text !== null) parts.push({ type: 'text', text: `[Attached file: ${file.name}]\n${text}` })
    }
    for (const url of images) parts.push({ type: 'image_url', image_url: { url: artifactFileUrlToDataUrl(url) || url } })
    for (const url of audio) parts.push({ type: 'audio_url', audio_url: { url: artifactFileUrlToDataUrl(url) || url } })
    const now = Date.now()
    db.transaction(() => {
      db.prepare(`
        INSERT OR IGNORE INTO messages (id, conversation_id, role, content, image_urls_json, audio_urls_json, created_at)
        VALUES (?, ?, 'user', ?, ?, ?, ?)
      `).run(row.id, conversationId, normalized, images.length ? JSON.stringify(images) : null, audio.length ? JSON.stringify(audio) : null, now)
      persistMessageFileAttachments(db, row.id, conversationId, files, now)
      db.prepare('DELETE FROM queued_chat_messages WHERE id = ?').run(row.id)
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)
    })()
    promoted.push({ role: 'user', content: parts.length > 1 ? parts : normalized })
    broadcastQueue('chat:new-message', {
      conversationId,
      streamId,
      message: {
        id: row.id, conversationId, role: 'user', content: normalized,
        imageDataUrls: images, audioDataUrls: audio,
        fileAttachments: files.map(file => ({ name: file.name, href: toFileUrl(file.originalPath, file.name) })), createdAt: now,
      },
    })
  }
  if (steeringRows.length) {
    notify(conversationId)
    const hasMore = db.prepare(`
      SELECT 1 FROM queued_chat_messages
      WHERE conversation_id = ? AND delivery = 'steer' AND status = 'pending'
      LIMIT 1
    `).get(conversationId)
    const handler = steeringHandlers.get(conversationId)
    if (hasMore && handler) queueMicrotask(handler)
  }
  return promoted
}

export function pauseAllChatQueuesOnStartup(): void {
  getDb().prepare(`UPDATE queued_chat_messages SET status = 'paused'`).run()
}
