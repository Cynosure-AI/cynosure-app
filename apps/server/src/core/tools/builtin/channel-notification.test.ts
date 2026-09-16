import { describe, expect, it, vi } from 'vitest'
import { makeChannelNotificationTool } from './channel-notification.js'

describe('notify_user_on_channel built-in tool', () => {
    it('sends a trimmed message through the requested channel', async () => {
        const notify = vi.fn().mockResolvedValue({ channelId: 'channel-1', target: 'user-1' })
        const tool = makeChannelNotificationTool({ agentId: 'agent-1', availableChannels: ['telegram'], notify })

        const result = await tool.execute({ channel: 'telegram', message: '  Hello this is the agent  ' }, {} as never)

        expect(notify).toHaveBeenCalledWith('telegram', 'Hello this is the agent')
        expect(result).toEqual({ success: true, output: 'Notification sent on telegram (channel channel-1).' })
    })

    it('rejects unsupported channels and empty messages', async () => {
        const notify = vi.fn()
        const tool = makeChannelNotificationTool({ agentId: 'agent-1', availableChannels: ['telegram'], notify })

        await expect(tool.execute({ channel: 'email', message: 'Hello' }, {} as never))
            .resolves.toEqual({ success: false, output: 'channel must be one of the available configured channels: telegram.' })
        await expect(tool.execute({ channel: 'telegram', message: '  ' }, {} as never))
            .resolves.toEqual({ success: false, output: 'message must not be empty' })
        expect(notify).not.toHaveBeenCalled()
    })

    it('returns delivery failures to the agent', async () => {
        const tool = makeChannelNotificationTool({
            agentId: 'agent-1',
            availableChannels: ['slack'],
            notify: vi.fn().mockRejectedValue(new Error('No recipient')),
        })

        await expect(tool.execute({ channel: 'slack', message: 'Hello' }, {} as never))
            .resolves.toEqual({ success: false, output: 'No recipient' })
    })

    it('only exposes and accepts channels available to this agent', async () => {
        const notify = vi.fn().mockResolvedValue({ channelId: 'channel-1', target: 'user-1' })
        const tool = makeChannelNotificationTool({
            agentId: 'agent-1',
            availableChannels: ['discord'],
            notify,
        })

        expect((tool.parameters.properties as Record<string, { enum?: string[] }>).channel.enum).toEqual(['discord'])
        await expect(tool.execute({ channel: 'telegram', message: 'Hello' }, {} as never))
            .resolves.toEqual({ success: false, output: 'channel must be one of the available configured channels: discord.' })
        expect(notify).not.toHaveBeenCalled()
    })
})
