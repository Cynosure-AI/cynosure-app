import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { TelegramCtx } from './telegram.channel.js'

const mocks = vi.hoisted(() => ({
    sendMessage: vi.fn(),
    stopAllActivity: vi.fn(),
}))

vi.mock('./telegram.api.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('./telegram.api.js')>(),
    sendMessage: mocks.sendMessage,
}))

vi.mock('../../activity/stop-all.js', () => ({
    stopAllActivity: mocks.stopAllActivity,
}))

import { handleCommand } from './telegram.channel.js'

describe('Telegram /kill command', () => {
    beforeEach(() => {
        mocks.sendMessage.mockReset().mockResolvedValue(undefined)
        mocks.stopAllActivity.mockReset()
    })

    test('stops all activity, including when Telegram appends the bot username', async () => {
        mocks.stopAllActivity.mockReturnValue({
            success: true,
            total: 4,
            counts: {
                chats: 1,
                cronRuns: 1,
                channelRuns: 1,
                memoryJobs: 1,
                memoryReembedding: 0,
                postActions: 0,
            },
        })

        const handled = await handleCommand({} as TelegramCtx, 42, '/kill@cynosure_bot')

        expect(handled).toBe(true)
        expect(mocks.stopAllActivity).toHaveBeenCalledOnce()
        expect(mocks.sendMessage).toHaveBeenCalledWith(
            expect.anything(),
            42,
            'Stopped 4 running execution(s) across all activity.',
        )
    })

    test('reports when there is nothing to stop', async () => {
        mocks.stopAllActivity.mockReturnValue({
            success: true,
            total: 0,
            counts: {
                chats: 0,
                cronRuns: 0,
                channelRuns: 0,
                memoryJobs: 0,
                memoryReembedding: 0,
                postActions: 0,
            },
        })

        await handleCommand({} as TelegramCtx, 42, '/kill')

        expect(mocks.sendMessage).toHaveBeenCalledWith(
            expect.anything(),
            42,
            'No executions are currently running.',
        )
    })
})
