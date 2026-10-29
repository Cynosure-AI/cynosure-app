import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { closeDb, getDb } from '../../db/database.js'
import { listConversationFileAttachments, persistMessageFileAttachments } from './attachment-store.js'
import { materializeFileAttachment } from './file-artifacts.js'
import { listStagedChatAttachments, stageChatAttachment } from './staged-attachments.js'
import { registerConversationRoutes } from '../../routes/conversations.js'
import { registerChatRoutes } from '../../routes/chat.js'

let directory = ''
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cynosure-attachment-scope-'))
  process.env.CYNOSURE_DATA_DIR = directory
  getDb().prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('draft', 'Draft', 1, 1)").run()
})
afterEach(async () => {
  closeDb()
  delete process.env.CYNOSURE_DATA_DIR
  await rm(directory, { recursive: true, force: true })
})

test('staged uploads are ready once parsed and stay out of the conversation until sent', async () => {
  const staged = await stageChatAttachment('draft', { name: 'notes.txt', content: 'Unsent draft' })
  expect(staged.status).toBe('ready')
  expect(listStagedChatAttachments('draft').map((item) => item.status)).toEqual(['ready'])
  expect(listConversationFileAttachments(getDb(), 'draft')).toEqual([])
  expect(existsSync(staged.artifact.originalPath)).toBe(true)
})

test.each(['single', 'all'])('conversation deletion (%s) cleans staged files before cascading rows', async (kind) => {
  const staged = await stageChatAttachment('draft', { name: 'notes.txt', content: 'Unsent draft' })
  const app = Fastify()
  await app.register(registerConversationRoutes, { prefix: '/api/chat' })
  try {
    const response = await app.inject({ method: 'DELETE', url: kind === 'single' ? '/api/chat/conversations/draft' : '/api/chat/conversations' })
    expect(response.statusCode, response.body).toBe(200)
    expect(listStagedChatAttachments('draft')).toEqual([])
    expect(existsSync(staged.artifact.originalPath)).toBe(false)
    expect(existsSync(staged.artifact.textPath)).toBe(false)
  } finally { await app.close() }
})

test('New Chat discard endpoint removes drafts while preserving committed files', async () => {
  const db = getDb()
  db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m1', 'draft', 'user', '', 1)").run()
  const committed = await materializeFileAttachment({ name: 'saved.txt', content: 'Keep me' }, 'draft')
  persistMessageFileAttachments(db, 'm1', 'draft', [committed], 1)
  const staged = await stageChatAttachment('draft', { name: 'unsent.txt', content: 'Discard me' })
  const app = Fastify()
  await app.register(instance => registerChatRoutes(instance, () => undefined), { prefix: '/api/chat' })
  try {
    const response = await app.inject({ method: 'DELETE', url: '/api/chat/conversations/draft/attachments/stage' })
    expect(response.statusCode, response.body).toBe(200)
    expect(listStagedChatAttachments('draft')).toEqual([])
    expect(existsSync(staged.artifact.originalPath)).toBe(false)
    expect(existsSync(committed.originalPath)).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS n FROM message_attachments').get()).toEqual({ n: 1 })
  } finally { await app.close() }
})
