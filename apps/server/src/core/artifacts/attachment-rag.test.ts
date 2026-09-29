import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../../db/database.js'
import { buildAttachmentFilter, makeAttachmentTools, persistMessageFileAttachments, searchConversationAttachments } from './attachment-rag.js'
import { materializeFileAttachment } from './file-artifacts.js'
import { listStagedChatAttachments, stageChatAttachment } from './staged-attachments.js'
import { registerConversationRoutes } from '../../routes/conversations.js'
import { registerChatRoutes } from '../../routes/chat.js'

const mocks = vi.hoisted(() => ({
  ingest: vi.fn().mockResolvedValue(1),
  retrieve: vi.fn().mockResolvedValue([{ text: 'Another chat', sourceFile: 'other-asset' }]),
  deleteByFilter: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../memory/parser.js', () => ({ getMemoryParser: () => mocks }))
vi.mock('../memory/rag.js', () => ({ getRAGStore: () => mocks }))
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

test('empty conversations cannot search other chats or uncommitted uploads', async () => {
  const staged = await stageChatAttachment('draft', { name: 'notes.txt', content: 'Unsent draft' })
  await vi.waitFor(() => expect(listStagedChatAttachments('draft')[0].status).toBe('ready'))
  expect(buildAttachmentFilter('draft')).toBe('1 = 0')
  expect(await searchConversationAttachments('draft', 'notes')).toEqual([])
  const search = makeAttachmentTools('draft').find(tool => tool.name === 'attachment_search')!
  expect((await search.execute({ query: 'notes' })).success).toBe(false)
  expect(mocks.retrieve).not.toHaveBeenCalled()
  expect(existsSync(staged.artifact.originalPath)).toBe(true)
})

test('an empty or unmatched requested subset cannot broaden to all documents', async () => {
  const db = getDb()
  db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m1', 'draft', 'user', '', 1)").run()
  const artifact = await materializeFileAttachment({ name: 'saved.txt', content: 'Committed' }, 'draft')
  persistMessageFileAttachments(db, 'm1', 'draft', [artifact], 1)
  expect(buildAttachmentFilter('draft')).toContain(artifact.id)
  for (const ids of [[], ['missing']]) {
    expect(await searchConversationAttachments('draft', 'notes', 6, ids)).toEqual([])
  }
  expect(mocks.retrieve).not.toHaveBeenCalled()
})

test.each(['single', 'all'])('conversation deletion (%s) cleans staged files and vectors before cascading rows', async (kind) => {
  const staged = await stageChatAttachment('draft', { name: 'notes.txt', content: 'Unsent draft' })
  await vi.waitFor(() => expect(listStagedChatAttachments('draft')[0].status).toBe('ready'))
  mocks.deleteByFilter.mockClear()
  const app = Fastify()
  await app.register(registerConversationRoutes, { prefix: '/api/chat' })
  try {
    const response = await app.inject({ method: 'DELETE', url: kind === 'single' ? '/api/chat/conversations/draft' : '/api/chat/conversations' })
    expect(response.statusCode, response.body).toBe(200)
    expect(listStagedChatAttachments('draft')).toEqual([])
    expect(existsSync(staged.artifact.originalPath)).toBe(false)
    expect(existsSync(staged.artifact.textPath)).toBe(false)
    expect(mocks.deleteByFilter).toHaveBeenCalledWith('conversation_attachments', `sourceFile = '${staged.id}'`)
  } finally { await app.close() }
})

test('New Chat discard endpoint removes drafts while preserving committed files', async () => {
  const db = getDb()
  db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m1', 'draft', 'user', '', 1)").run()
  const committed = await materializeFileAttachment({ name: 'saved.txt', content: 'Keep me' }, 'draft')
  persistMessageFileAttachments(db, 'm1', 'draft', [committed], 1)
  const staged = await stageChatAttachment('draft', { name: 'unsent.txt', content: 'Discard me' })
  await vi.waitFor(() => expect(listStagedChatAttachments('draft')[0].status).toBe('ready'))
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
