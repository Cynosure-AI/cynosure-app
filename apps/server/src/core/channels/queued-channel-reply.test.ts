import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../../db/database.js'

const { deliver } = vi.hoisted(() => ({ deliver: vi.fn(async () => true) }))
vi.mock('./channel-manager.js', () => ({ getChannelManager: () => ({ deliver }) }))
import { deliverQueuedChannelReply } from './queued-channel-reply.js'
import { recordChannelDeliveries } from './channel-delivery.js'

let directory: string
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-queued-channel-'))
    process.env.CYNOSURE_DATA_DIR = directory
    deliver.mockClear()
    getDb().prepare('INSERT INTO conversations (id, title, metadata_json, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
        .run('conversation', 'Chat', '{}')
})
afterEach(() => {
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    rmSync(directory, { recursive: true, force: true })
})

test.each(['telegram', 'discord', 'slack'])('routes a resumed %s reply using persisted conversation metadata', async (type) => {
    getDb().prepare('UPDATE conversations SET metadata_json = ? WHERE id = ?')
        .run(JSON.stringify({ channelKey: `${type}:channel-id:target:thread` }), 'conversation')
    await deliverQueuedChannelReply('conversation', 'The build finished.')
    expect(deliver).toHaveBeenCalledExactlyOnceWith('channel-id', 'target:thread', 'The build finished.', {
        sourceConversationId: 'conversation',
    })
})

test('routes waits in a conversation continued from a delivered notification', async () => {
    getDb().prepare("INSERT INTO channels (id, name, type, agent_id, config_json, created_at, updated_at) VALUES ('channel', 'Telegram', 'telegram', '', '{}', 1, 1)").run()
    recordChannelDeliveries({ channelId: 'channel', target: '-123', platformMessageIds: ['42'], conversationId: 'conversation' })
    await deliverQueuedChannelReply('conversation', 'Here is the follow-up.')
    expect(deliver).toHaveBeenCalledExactlyOnceWith('channel', '-123', 'Here is the follow-up.', {
        sourceConversationId: 'conversation',
    })
})

test('keeps web conversations and empty replies off messaging channels', async () => {
    await deliverQueuedChannelReply('conversation', 'Web reply')
    await deliverQueuedChannelReply('missing', 'Deleted chat')
    await deliverQueuedChannelReply('conversation', '')
    expect(deliver).not.toHaveBeenCalled()
})
