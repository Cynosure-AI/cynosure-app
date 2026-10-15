import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../../db/database.js'

const queue = vi.hoisted(() => ({
    enqueueChatMessage: vi.fn(async (conversationId: string) => ({ id: 'wake-up', conversationId })),
    runNextQueuedMessage: vi.fn(async () => undefined),
    whenChatQueueReady: vi.fn(async () => undefined),
}))
vi.mock('../chat/message-queue.js', () => queue)

import { getCronJob, getPendingWait, getWaitResumeTimes, listCronJobs, startCronScheduler, stopCronScheduler, triggerCronJobNow } from './cron-scheduler.js'
import { makeScheduleTools } from '../tools/builtin/schedule-tools.js'

const savedConfig = {
    allowedTools: ['builtin:scheduling::schedule_wait'], subAgents: [], memoryFolderIds: [], systemPrompt: 'Saved prompt',
    model: 'saved-model', providerId: 'saved-provider', thinkingEnabled: true, reasoningEffort: 'high',
    autoToolRouting: false, autoMemory: false,
}

let directory: string
const broadcast = vi.fn()
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-cron-wait-'))
    process.env.CYNOSURE_DATA_DIR = directory
    const insert = getDb().prepare('INSERT INTO conversations (id, title, agent_id, origin, execution_config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    insert.run('chat-1', 'Chat', 'agent-1', 'chat', JSON.stringify(savedConfig), 1, 1)
    insert.run('telegram-1', 'Telegram', 'agent-1', 'channel', '{}', 1, 1)
    startCronScheduler(broadcast)
})
afterEach(async () => {
    await stopCronScheduler()
    vi.clearAllMocks()
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    rmSync(directory, { recursive: true, force: true })
})

function waitTool(conversationId: string) {
    return makeScheduleTools({ agentId: 'agent-1', conversationId }).find((tool) => tool.name === 'schedule_wait')!
}

describe('schedule_wait', () => {
    test('lists the wait as a one-off job for its conversation and keeps only the latest', async () => {
        const first = await waitTool('chat-1').execute({ minutes: 5, note: 'Check the build' })
        const second = await waitTool('chat-1').execute({ minutes: 10, note: 'Check the deploy' })
        expect(first.success).toBe(true)
        expect(second.success).toBe(true)
        const firstId = JSON.parse(first.output).jobId
        expect(JSON.parse(second.output).replacedJobIds).toEqual([firstId])

        const jobs = listCronJobs()
        expect(jobs).toEqual([expect.objectContaining({
            name: 'Wait: Check the deploy', agentId: 'agent-1', prompt: 'Check the deploy',
            enabled: true, oneOff: true, conversationId: 'chat-1',
        })])
    })

    test('reports when each waiting conversation resumes and signals changes to chat lists', async () => {
        const created = await waitTool('chat-1').execute({ minutes: 5, note: 'Check the build' })
        const { resumesAt } = JSON.parse(created.output)
        expect(getWaitResumeTimes(['chat-1', 'telegram-1'])).toEqual(new Map([['chat-1', Date.parse(resumesAt)]]))
        expect(getPendingWait('chat-1')).toEqual({ jobId: JSON.parse(created.output).jobId, resumesAt: Date.parse(resumesAt), note: 'Check the build' })
        expect(getPendingWait('telegram-1')).toBeNull()
        expect(broadcast).toHaveBeenCalledWith('cron:waits-changed', {})

        broadcast.mockClear()
        const del = makeScheduleTools({ agentId: 'agent-1', conversationId: 'chat-1' }).find((tool) => tool.name === 'schedule_delete')!
        await del.execute({ jobId: JSON.parse(created.output).jobId })
        expect(getWaitResumeTimes(['chat-1'])).toEqual(new Map())
        expect(getPendingWait('chat-1')).toBeNull()
        expect(broadcast).toHaveBeenCalledWith('cron:waits-changed', {})
    })

    test('rejects waits longer than an hour, outside a conversation, and in channel conversations', async () => {
        await expect(waitTool('chat-1').execute({ minutes: 61, note: 'Later' }))
            .resolves.toMatchObject({ success: false, error: expect.stringMatching(/1 to 60/) })
        await expect(makeScheduleTools({ agentId: 'agent-1' })[4].execute({ minutes: 5, note: 'Later' }))
            .resolves.toMatchObject({ success: false, error: expect.stringMatching(/inside a conversation/) })
        await expect(waitTool('telegram-1').execute({ minutes: 5, note: 'Later' }))
            .resolves.toMatchObject({ success: false, error: expect.stringMatching(/messaging channel/) })
        expect(listCronJobs()).toEqual([])
    })

    test('is not editable through schedule_update', async () => {
        const created = await waitTool('chat-1').execute({ minutes: 5, note: 'Check the build' })
        const update = makeScheduleTools({ agentId: 'agent-1', conversationId: 'chat-1' }).find((tool) => tool.name === 'schedule_update')!
        await expect(update.execute({ jobId: JSON.parse(created.output).jobId, schedule: '0 9 * * *' }))
            .resolves.toMatchObject({ success: false, error: expect.stringMatching(/is a wait/) })
    })

    test('resumes the same conversation with its saved settings and then removes the wait', async () => {
        const created = await waitTool('chat-1').execute({ minutes: 5, note: 'Check the build' })
        const jobId = JSON.parse(created.output).jobId

        triggerCronJobNow(jobId)
        await vi.waitFor(() => expect(queue.runNextQueuedMessage).toHaveBeenCalledWith('chat-1', 'wake-up'))
        expect(queue.enqueueChatMessage).toHaveBeenCalledWith('chat-1', {
            content: expect.stringContaining('Continue where you left off: Check the build'),
            delivery: 'next',
            run: expect.objectContaining({ model: 'saved-model', providerOverride: 'saved-provider', systemPrompt: 'Saved prompt', reasoningEffort: 'high' }),
        })
        expect(getCronJob(jobId)).toBeUndefined()
    })

    test('drops a wait whose conversation was deleted', async () => {
        const created = await waitTool('chat-1').execute({ minutes: 5, note: 'Check the build' })
        const jobId = JSON.parse(created.output).jobId
        getDb().prepare('DELETE FROM conversations WHERE id = ?').run('chat-1')

        triggerCronJobNow(jobId)
        await vi.waitFor(() => expect(getCronJob(jobId)).toBeUndefined())
        expect(queue.enqueueChatMessage).not.toHaveBeenCalled()
    })
})
