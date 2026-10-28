import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb } from '../../../db/database.js'
import { makeNotificationTool } from './notification.js'
import { hydrateBuiltInTools } from '../built-in-tools.js'
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
    const notify = vi.fn().mockResolvedValue({ channelId: 'channel-1', target: 'user-1' })
    return { tool: makeNotificationTool({ conversationId: 'chat-1', availableChannels: channels, notify }), notify }
}

describe('notify_user', () => {
    test('defaults to the first connected channel', async () => {
        const { tool: notification, notify } = tool(['discord', 'slack'])
        const result = await notification.execute({ title: '  Finished  ', body: '  Task done  ' })
        expect(result).toEqual({ success: true, output: 'Notification sent on discord (channel channel-1).' })
        expect(notify).toHaveBeenCalledWith('discord', 'Finished\n\nTask done', 'chat-1')
        const properties = notification.parameters.properties as Record<string, unknown>
        expect(Object.keys(properties).sort()).toEqual(['body', 'channel', 'title'])
        expect(properties.channel).toEqual(expect.objectContaining({ enum: ['discord', 'slack'], default: 'discord' }))
    })
    test('no longer offers an app channel', async () => {
        const { tool: notification, notify } = tool(['telegram'])
        expect((notification.parameters.properties as Record<string, { enum: string[] }>).channel.enum).not.toContain('app')
        expect((await notification.execute({ channel: 'app', title: 'Hello', body: 'World' })).success).toBe(false)
        expect(notify).not.toHaveBeenCalled()
    })
    test('fails without sending when no channel is connected', async () => {
        const { tool: notification, notify } = tool()
        expect((notification.parameters.properties as Record<string, { enum: string[] }>).channel.enum).toEqual(['telegram', 'discord', 'slack'])
        expect(await notification.execute({ title: 'Hello', body: 'World' }))
            .toEqual({ success: false, output: 'No messaging channel is connected with a known recipient.' })
        expect(notify).not.toHaveBeenCalled()
    })
    test.each(['telegram', 'discord', 'slack'] as const)('sends the same title and body to %s, linked to the conversation', async channel => {
        const { tool: notification, notify } = tool([channel])
        const result = await notification.execute({ channel, title: '  Finished  ', body: '  Task done  ' })
        expect(result).toEqual({ success: true, output: `Notification sent on ${channel} (channel channel-1).` })
        expect(notify).toHaveBeenCalledWith(channel, 'Finished\n\nTask done', 'chat-1')
    })
    test('rejects unavailable channels and invalid input without sending', async () => {
        const { tool: notification, notify } = tool(['telegram'])
        for (const input of [null, {}, { title: 2, body: 'Hello' }, { title: 'Hello', body: ' ' },
            { channel: 'email', title: 'Hello', body: 'World' }, { channel: 'slack', title: 'Hello', body: 'World' }]) {
            expect((await notification.execute(input)).success).toBe(false)
        }
        expect(notify).not.toHaveBeenCalled()
    })
    test('returns delivery errors without reporting success', async () => {
        const { tool: notification, notify } = tool(['slack'])
        notify.mockRejectedValue(new Error('Delivery failed'))
        expect(await notification.execute({ channel: 'slack', title: 'Hello', body: 'World' }))
            .toEqual({ success: false, output: 'Delivery failed' })
    })
    test('rechecks channel connectivity when executing a hydrated tool', async () => {
        const manager = getChannelManager()
        vi.spyOn(manager, 'listFromDb').mockReturnValue([{ id: 'telegram', type: 'telegram', enabled: true,
            name: 'Telegram', agentId: 'agent', createdAt: 1, updatedAt: 1, config: { allowedUserIds: ['12345'] } }])
        const status = vi.spyOn(manager, 'getStatus').mockReturnValue({ connected: true })
        const notify = vi.fn()
        const notification = makeNotificationTool({ conversationId: '', notify })
        expect((notification.parameters.properties as Record<string, { enum: string[] }>).channel.enum).toEqual(['telegram'])
        status.mockReturnValue({ connected: false })
        expect((await notification.execute({ channel: 'telegram', title: 'Hello', body: 'World' })).success).toBe(false)
        expect(notify).not.toHaveBeenCalled()
    })
})

describe('notify_user hydration', () => {
    test('is hidden while no messaging channel is connected', () => {
        const manager = getChannelManager()
        vi.spyOn(manager, 'listFromDb').mockReturnValue([{ id: 'telegram', type: 'telegram', enabled: true,
            name: 'Telegram', agentId: 'agent', createdAt: 1, updatedAt: 1, config: { allowedUserIds: ['12345'] } }])
        const status = vi.spyOn(manager, 'getStatus').mockReturnValue({ connected: false })
        const tools = [{ ...makeNotificationTool({ conversationId: '', availableChannels: [] }), originalName: 'notify_user', name: 'aliased_notify_user' }]
        const context = { conversationId: 'chat-1', broadcast: () => undefined, memoryFolderOverrides: [] }
        expect(hydrateBuiltInTools(tools, context)).toEqual([])

        status.mockReturnValue({ connected: true })
        expect(hydrateBuiltInTools(tools, context).map(tool => tool.name)).toEqual(['aliased_notify_user'])
    })
})
