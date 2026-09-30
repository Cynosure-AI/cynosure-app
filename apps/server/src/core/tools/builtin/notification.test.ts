import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../../../db/database.js'
import { makeNotificationTool } from './notification.js'
import { getChannelManager } from '../../channels/channel-manager.js'

let directory: string
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-notify-'))
    vi.stubEnv('CYNOSURE_DATA_DIR', directory)
})
afterEach(() => {
    closeDb()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
})
function tool(channels: ('telegram' | 'discord' | 'slack')[] = []) {
    const broadcast = vi.fn()
    const notify = vi.fn().mockResolvedValue({ channelId: 'channel-1', target: 'user-1' })
    return { tool: makeNotificationTool({ agentId: 'agent-1', conversationId: 'chat-1', broadcast,
        availableChannels: channels, notify }), broadcast, notify }
}

describe('notify_user', () => {
    test('defaults to app delivery with a fixed notice severity and execution context', async () => {
        const { tool: notification, broadcast, notify } = tool()
        const result = await notification.execute({ title: '  Finished  ', body: '  Task done  ' })
        expect(result.success).toBe(true)
        expect(notify).not.toHaveBeenCalled()
        expect(broadcast).toHaveBeenCalledWith('notification:created', expect.objectContaining({
            agentId: 'agent-1', conversationId: 'chat-1', title: 'Finished', body: 'Task done', priority: 'notice',
        }))
        expect(getDb().prepare('SELECT severity FROM notifications').get()).toEqual({ severity: 'notice' })
        const properties = notification.parameters.properties as Record<string, unknown>
        expect(Object.keys(properties).sort()).toEqual(['body', 'channel', 'title'])
        expect(properties.channel).toEqual(expect.objectContaining({ enum: ['app'], default: 'app' }))
    })
    test('accepts an explicit app channel even when no external channel is available', async () => {
        const { tool: notification } = tool()
        expect((await notification.execute({ channel: 'app', title: 'Hello', body: 'World' })).success).toBe(true)
    })
    test.each(['telegram', 'discord', 'slack'] as const)('sends the same title and body to %s', async channel => {
        const { tool: notification, notify, broadcast } = tool([channel])
        const result = await notification.execute({ channel, title: '  Finished  ', body: '  Task done  ' })
        expect(result).toEqual({ success: true, output: `Notification sent on ${channel} (channel channel-1).` })
        expect(notify).toHaveBeenCalledWith(channel, 'Finished\n\nTask done')
        expect(broadcast).not.toHaveBeenCalled()
    })
    test('rejects unavailable channels and invalid input without sending', async () => {
        const { tool: notification, notify, broadcast } = tool(['telegram'])
        for (const input of [null, {}, { title: 2, body: 'Hello' }, { title: 'Hello', body: ' ' },
            { channel: 'email', title: 'Hello', body: 'World' }, { channel: 'slack', title: 'Hello', body: 'World' }]) {
            expect((await notification.execute(input)).success).toBe(false)
        }
        expect(notify).not.toHaveBeenCalled()
        expect(broadcast).not.toHaveBeenCalled()
    })
    test('returns delivery errors without reporting success or changing the channel', async () => {
        const { tool: notification, notify, broadcast } = tool(['slack'])
        notify.mockRejectedValue(new Error('Delivery failed'))
        expect(await notification.execute({ channel: 'slack', title: 'Hello', body: 'World' }))
            .toEqual({ success: false, output: 'Delivery failed' })
        expect(broadcast).not.toHaveBeenCalled()
    })
    test('rechecks channel connectivity when executing a hydrated tool', async () => {
        const manager = getChannelManager()
        vi.spyOn(manager, 'listFromDb').mockReturnValue([{ id: 'telegram', type: 'telegram', enabled: true,
            name: 'Telegram', agentId: 'agent', createdAt: 1, updatedAt: 1, config: { allowedUserIds: ['12345'] } }])
        const status = vi.spyOn(manager, 'getStatus').mockReturnValue({ connected: true })
        const notify = vi.fn()
        const notification = makeNotificationTool({ agentId: '', conversationId: '', broadcast: vi.fn(), notify })
        expect((notification.parameters.properties as Record<string, { enum: string[] }>).channel.enum).toEqual(['app', 'telegram'])
        status.mockReturnValue({ connected: false })
        expect((await notification.execute({ channel: 'telegram', title: 'Hello', body: 'World' })).success).toBe(false)
        expect(notify).not.toHaveBeenCalled()
    })
})
