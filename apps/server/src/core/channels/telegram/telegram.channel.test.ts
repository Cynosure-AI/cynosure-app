import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TelegramCtx } from './telegram.channel.js'
import { getEventBus } from '../../telemetry/event-bus.js'

const mocks = vi.hoisted(() => ({
    sendMessage: vi.fn(),
    stopAllActivity: vi.fn(),
    sendMessageReturningId: vi.fn(),
    editMessage: vi.fn(),
    answerCallbackQuery: vi.fn(),
    deleteMessage: vi.fn(),
    extractAttachments: vi.fn(),
    receiveChannelMessage: vi.fn(),
}))

vi.mock('./telegram.api.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('./telegram.api.js')>(),
    sendMessage: mocks.sendMessage,
    sendMessageReturningId: mocks.sendMessageReturningId,
    editMessage: mocks.editMessage,
    answerCallbackQuery: mocks.answerCallbackQuery,
    deleteMessage: mocks.deleteMessage,
    extractAttachments: mocks.extractAttachments,
}))

vi.mock('../channel-turn.js', () => ({ receiveChannelMessage: mocks.receiveChannelMessage }))

vi.mock('../../activity/stop-all.js', () => ({
    stopAllActivity: mocks.stopAllActivity,
}))

import { handleCallbackQuery, handleCommand, handleMessage, subscribeToHITL, type TelegramUpdate } from './telegram.channel.js'

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

describe('Telegram approval flow', () => {
    beforeEach(() => {
        mocks.sendMessageReturningId.mockReset().mockResolvedValue(100)
        mocks.editMessage.mockReset().mockResolvedValue(true)
        mocks.answerCallbackQuery.mockReset().mockResolvedValue(undefined)
        mocks.deleteMessage.mockReset().mockResolvedValue(true)
    })
    afterEach(() => getEventBus().removeAllListeners())

    function setup() {
        const ctx = {
            channelId: 'telegram', broadcast: vi.fn(), allowedUserIds: new Set(['42']),
            conversationTargets: new Map([['conversation', 42]]),
            conversationToUser: new Map([['conversation', 42]]),
            conversationSendQueue: new Map(), pendingHITL: new Map(),
        } as unknown as TelegramCtx
        const unsubscribe = subscribeToHITL(ctx)
        const resolve = vi.fn()
        getEventBus().emit('hitl:request', {
            conversationId: 'conversation', taskId: 'approval', resolve,
            toolCalls: [{ id: 'call', function: { name: 'file_write', arguments: '{"path":"/recipes/potato_muffins.md"}' } }],
        })
        return { ctx, resolve, unsubscribe }
    }

    test('shows the target and removes the prompt once approved', async () => {
        const { ctx, resolve, unsubscribe } = setup()
        await vi.waitFor(() => expect(ctx.pendingHITL.size).toBe(1))
        expect(mocks.sendMessageReturningId.mock.calls[0][2]).toContain('/recipes/potato_muffins.md')

        await handleCallbackQuery(ctx, { id: 'click', from: { id: 42, first_name: 'User' },
            message: { message_id: 100, chat: { id: 42, type: 'private' } }, data: 'hitl:approval:approve' })

        expect(resolve).toHaveBeenCalledWith({ approved: true, reason: undefined })
        expect(ctx.pendingHITL.size).toBe(0)
        expect(mocks.deleteMessage).toHaveBeenCalledWith(ctx, 42, 100)
        expect(mocks.editMessage).not.toHaveBeenCalled()
        expect(mocks.answerCallbackQuery).toHaveBeenCalledWith(ctx, 'click', expect.stringContaining('Approved'))
        unsubscribe()
    })

    test('collapses the prompt with its context when Telegram refuses to delete it', async () => {
        mocks.deleteMessage.mockResolvedValue(false)
        const { ctx, unsubscribe } = setup()
        await vi.waitFor(() => expect(ctx.pendingHITL.size).toBe(1))

        await handleCallbackQuery(ctx, { id: 'click', from: { id: 42, first_name: 'User' },
            message: { message_id: 100, chat: { id: 42, type: 'private' } }, data: 'hitl:approval:deny' })

        expect(mocks.editMessage).toHaveBeenCalledWith(ctx, 42, 100,
            expect.stringContaining('/recipes/potato_muffins.md'), { reply_markup: { inline_keyboard: [] } })
        expect(mocks.editMessage.mock.calls[0][3]).toContain('Declined')
        unsubscribe()
    })

    test('removes the prompt when answered in Cynosure without resolving twice', async () => {
        const { ctx, resolve, unsubscribe } = setup()
        await vi.waitFor(() => expect(ctx.pendingHITL.size).toBe(1))

        getEventBus().emit('hitl:resolved', { taskId: 'approval' })

        expect(ctx.pendingHITL.size).toBe(0)
        expect(resolve).not.toHaveBeenCalled()
        await vi.waitFor(() => expect(mocks.deleteMessage).toHaveBeenCalledWith(ctx, 42, 100))
        unsubscribe()
    })
})

describe('Telegram albums', () => {
    test('handles the photos of an album and its caption as one message', async () => {
        mocks.receiveChannelMessage.mockReset().mockResolvedValue(undefined)
        mocks.extractAttachments.mockReset().mockImplementation(async (_ctx, msg: { message_id: number }) =>
            ({ imageDataUrls: [`image-${msg.message_id}`], audioDataUrls: [] }))
        const ctx = { channelId: 'telegram', allowedUserIds: new Set(['42']), mediaGroups: new Map() } as unknown as TelegramCtx
        const part = (id: number, caption?: string): TelegramUpdate => ({ update_id: id, message: {
            message_id: id, from: { id: 42, first_name: 'User' }, chat: { id: 42, type: 'private' }, date: 0,
            media_group_id: 'album', caption, photo: [{ file_id: `f${id}`, file_unique_id: `u${id}`, width: 1, height: 1 }],
        } })

        await Promise.all([handleMessage(ctx, part(1)), handleMessage(ctx, part(2, 'Pls eintragen'))])

        expect(mocks.receiveChannelMessage).toHaveBeenCalledOnce()
        const inbound = mocks.receiveChannelMessage.mock.calls[0][1]
        expect(inbound.text).toBe('Pls eintragen')
        expect(await inbound.extractMedia()).toEqual({ imageDataUrls: ['image-1', 'image-2'], audioDataUrls: [] })
        expect(ctx.mediaGroups.size).toBe(0)
    })
})
